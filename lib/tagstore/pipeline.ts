/**
 * 带缓存复用的 AI 管线编排（阶段②正式运行的核心）。
 *
 * 流程：
 *   输入 articles
 *     ├─ 命中 store 且有价值 → cached 组 → generateDaily(runner = 本地合成) → 零 LLM
 *     ├─ 命中但已判无价值   → 直接丢弃（已被 AI 判定过，不再浪费额度）
 *     └─ 未命中             → fresh 组 → generateDaily(真 LLM)
 *   两组报告合并 → 回灌 store → 落盘
 *
 * **不漏损设计（四道防线）**
 *   1. miss 组 LLM 失败 → 默认**回退全量重跑**（TAG_FALLBACK_FULL=1，默认开），
 *      即把 hit 组也一起送进 LLM，保证任何条目都不会因为缓存路径而消失；
 *      全量也失败 → 才用 cached-only 降级并告警（CI 可见）。
 *   2. LLM 失败时**不回写** store（避免把网络抖动固化为「无价值」永久误杀）。
 *   2b. 部分批 PASS1 失败但报告非空（软失败检测漏检）→ 失败条目**保持未打标 + 告警**，
 *       绝不随 markDroppedAsIrrelevant 被标成永久无价值（把当次漏损升级为不可逆漏损）。
 *   3. 全过程计数对账并打印，条数异常一眼可见。
 *
 * **空 store 等价现状**：store 为空 → 全部 miss → 与改造前完全一致（全量 LLM）。
 */

import { generateDaily, makeSkipAiRunner } from "../ai/pipeline";
import type { Pass1Input, LlmRunner } from "../ai/pass1";
import type { ArticleInput, DailyReport } from "../types";
import type { DailyContext } from "../pipeline/context";
import { toPass1Input } from "../pipeline/pass1-input";
import {
  loadTagStore,
  saveTagStore,
  storeStats,
  upsertRecords,
  pruneStore,
  tagStoreEnabled,
} from "./store";
import { splitByCache, toSkipRunnerArgs } from "./split";
import { mergeReports, harvestFromReport, countItems } from "./merge";
import { windowBounds, inWindow } from "./window";
import { currentPhase, reportDate, windowDays } from "./phase";
import type { TagStoreFile } from "./types";

/** 空报告（某组无输入时使用）。 */
function emptyReport(date: string): DailyReport {
  return {
    date,
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
}

export interface CachedPipelineResult {
  report: DailyReport;
  /** 本轮统计（对账用）。 */
  stats: {
    input: number;
    reused: number;
    llm: number;
    droppedIrrelevant: number;
    droppedInvalid: number;
    freshItems: number;
    cachedItems: number;
    finalItems: number;
    fallbackFull: boolean;
    llmFailed: boolean;
    writeback: { added: number; updated: number; skipped: number };
  };
  store: TagStoreFile;
}

/** 是否开启「miss 组失败 → 全量重跑」兜底（默认开）。 */
function fallbackFullEnabled(): boolean {
  return process.env.TAG_FALLBACK_FULL?.trim() !== "0";
}

/**
 * 执行带缓存复用的 AI 管线。
 * 与 runAiPipeline 同签名，便于在 scripts/daily.ts 中直接替换。
 */
export async function runCachedAiPipeline(
  articles: ArticleInput[],
  ctx: DailyContext,
  opts: { missRunner?: LlmRunner } = {},
): Promise<CachedPipelineResult> {
  const date = ctx.date;
  const all: Pass1Input[] = articles.map(toPass1Input);

  // 总开关关闭 → 完全走原路径（等价于改造前）
  if (!tagStoreEnabled()) {
    ctx.log.info("tagstore", "TAG_STORE 已关闭，走原全量 LLM 路径");
    const report = await generateDaily(all, date, {});
    return {
      report,
      stats: {
        input: all.length,
        reused: 0,
        llm: all.length,
        droppedIrrelevant: 0,
        droppedInvalid: 0,
        freshItems: countItems(report),
        cachedItems: 0,
        finalItems: countItems(report),
        fallbackFull: false,
        llmFailed: false,
        writeback: { added: 0, updated: 0, skipped: 0 },
      },
      store: loadTagStore(),
    };
  }

  const store = loadTagStore();
  const before = storeStats(store);
  ctx.log.info(
    "tagstore",
    `已加载标签库：${before.total} 条（有价值 ${before.relevant}）by ${JSON.stringify(before.byTagger)}`,
  );

  // ① 分流
  const split = splitByCache(all, store);
  ctx.log.info(
    "tagstore",
    `分流：输入 ${all.length} → 复用 ${split.hit.length}（零 LLM）/ 待打标 ${split.miss.length} / 已判无价值丢弃 ${split.droppedIrrelevant}`,
  );

  const articlesByUrl = new Map<string, ArticleInput>();
  for (const a of articles) if (a?.url) articlesByUrl.set(a.url, a);

  // ② 双路生成
  let llmFailed = false;
  let fallbackFull = false;
  let freshReport: DailyReport = emptyReport(date);
  // PASS1 执行失败（重试+拆半耗尽）的 url 集合——这些不是「AI 判定无价值」，
  // 回灌时必须保持未打标、打告警，绝不标 aiRelevant=false（防永久误杀）。
  const missFailed = new Set<string>();

  if (split.miss.length > 0) {
    try {
      freshReport = await generateDaily(
        split.miss.map((m) => m),
        date,
        { runner: opts.missRunner, pass1FailedCollector: missFailed },
      );
      // 软失败检测（关键）：runPass1/runPass2 在 LLM 异常时会吞掉异常、降级为空报告，
      // 不会向上抛。所以「未命中组非空但产出 0 条」才是 LLM 真实失败的信号——
      // 若只靠 catch 判失败，空产出会被当成「进了 LLM 但落选」→ 误标永久无价值（最严重漏损）。
      if (countItems(freshReport) === 0) {
        llmFailed = true;
        ctx.log.info("tagstore", "❌ 未命中组 LLM 产出为空（软失败），触发降级");
        if (fallbackFullEnabled()) {
          ctx.log.info("tagstore", "↩️ 回退：全量重跑（含已命中组），保证不漏损");
          try {
            freshReport = await generateDaily(all, date, { runner: opts.missRunner, pass1FailedCollector: missFailed });
            fallbackFull = true;
            // 全量仍空 → 仍失败（否则会落选误标）；成功才把它当真实结果
            llmFailed = countItems(freshReport) === 0;
            if (!llmFailed) split.hit = []; // 全量已覆盖，cached 组不再重复生成
          } catch (e2) {
            const m2 = e2 instanceof Error ? e2.message : String(e2);
            ctx.log.info("tagstore", `❌ 全量重跑也失败，降级为仅缓存组：${m2}`);
          }
        }
      }
    } catch (e) {
      // 兜底：极少数情况下 generateDaily 本身抛错（非 runner 内部吞掉的类型）
      llmFailed = true;
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log.info("tagstore", `❌ 未命中组 LLM 失败（抛错）：${msg}`);
      if (fallbackFullEnabled()) {
        ctx.log.info("tagstore", "↩️ 回退：全量重跑（含已命中组），保证不漏损");
        try {
          freshReport = await generateDaily(all, date, { runner: opts.missRunner, pass1FailedCollector: missFailed });
          fallbackFull = true;
          llmFailed = countItems(freshReport) === 0;
          if (!llmFailed) split.hit = [];
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          ctx.log.info("tagstore", `❌ 全量重跑也失败，降级为仅缓存组：${m2}`);
        }
      }
    }
  }

  let cachedReport: DailyReport = emptyReport(date);
  if (split.hit.length > 0) {
    const { summaryCache, relevantUrls } = toSkipRunnerArgs(split.hit);
    const skipRunner = makeSkipAiRunner(summaryCache, relevantUrls);
    cachedReport = await generateDaily(
      split.hit.map((h) => h.input),
      date,
      { runner: skipRunner },
    );
  }

  // ③ 合并
  const report = mergeReports(freshReport, cachedReport, date);

  // ④ 回灌（LLM 失败时不回写，避免误杀）
  let writeback = { added: 0, updated: 0, skipped: 0 };
  if (!llmFailed) {
    const missUrls = fallbackFull
      ? all.map((i) => i.url)
      : split.miss.map((i) => i.url);
    const records = harvestFromReport(report, {
      urls: missUrls,
      articlesByUrl,
      tagger: "pipeline",
      markDroppedAsIrrelevant: true,
      failedUrls: missFailed,
    });
    writeback = upsertRecords(store, records);
    const removed = pruneStore(store);
    saveTagStore(store);
    ctx.log.info(
      "tagstore",
      `回灌：新增 ${writeback.added} / 更新 ${writeback.updated} / 无变化 ${writeback.skipped}；清理过期 ${removed}`,
    );
  } else {
    ctx.log.info("tagstore", "⚠️ LLM 失败，本轮不回写标签库（避免误标无价值）");
  }

  const freshItems = countItems(freshReport);
  const cachedItems = countItems(cachedReport);
  const finalItems = countItems(report);
  ctx.log.info(
    "tagstore",
    `成稿对账：LLM 组 ${freshItems} + 复用组 ${cachedItems} = ${finalItems} 条（丢弃：无价值 ${split.droppedIrrelevant} / 脏数据 ${split.droppedInvalid}）`,
  );

  // 不漏损断言（软断言：只告警不中断，CI 可见）
  if (!llmFailed && finalItems < cachedItems) {
    console.warn(
      `[tagstore] ⚠️ 漏损告警：合并后 ${finalItems} < 复用组 ${cachedItems}，请检查合并逻辑`,
    );
  }

  return {
    report,
    stats: {
      input: all.length,
      reused: split.hit.length,
      llm: split.miss.length,
      droppedIrrelevant: split.droppedIrrelevant,
      droppedInvalid: split.droppedInvalid,
      freshItems,
      cachedItems,
      finalItems,
      fallbackFull,
      llmFailed,
      writeback,
    },
    store,
  };
}

/**
 * 阶段③内容生成的候选池：store 中窗口内被判定有价值的条目。
 * 供 exec side-output 生成「今日必读 / 洞察 + 口播稿」使用。
 */
export function relevantPoolFromStore(
  store: TagStoreFile,
  days = windowDays(),
  refDate = reportDate(),
): { url: string; title: string; summary?: string; publishedAt: string; tags?: string[] }[] {
  const w = windowBounds(refDate, days);
  const out: { url: string; title: string; summary?: string; publishedAt: string; tags?: string[] }[] = [];
  for (const rec of Object.values(store.records)) {
    if (!rec.aiRelevant) continue;
    if (!inWindow(rec.publishedAt, w)) continue;
    out.push({
      url: rec.rawUrl || rec.url,
      title: rec.title,
      summary: rec.summary,
      publishedAt: rec.publishedAt,
      tags: rec.tags,
    });
  }
  out.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  return out;
}

/** 阶段判定（供脚本与日志使用）。 */
export { currentPhase, reportDate, windowDays };
