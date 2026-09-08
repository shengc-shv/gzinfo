/**
 * AI 管线入口（PR4）。
 *
 * 抽取自 daily.ts main 中：
 * - toPass1Input（已抽到 ./pass1-input，解循环依赖）
 * - generateDaily 调用（两阶段管线 + 13 条校验）
 *
 * 旁路：SKIP_AI 模式由 ctx.mode 派发 runner，无需 main 构造。
 * 历史/账本/资产相关仍由 main 持有（避免循环依赖）。
 *
 * 晚间预分析的复用由 lib/ai/pipeline.ts 内部读取 data/article-history.json
 * 摘要缓存承担（次日正式运行命中即复用，零额外处理）；本入口只负责派发
 * SKIP_AI 本地合成与全量 LLM 两条路径。
 */

import type { ArticleInput, DailyReport } from "../types";
import type { Pass1Input } from "../ai/pass1";
import { generateDaily, makeSkipAiRunner } from "../ai/pipeline";
import { toPass1Input } from "./pass1-input";
import type { DailyContext } from "./context";
import { FETCH_WINDOW_DAYS, type HistoryStore } from "../output/history";
import { isWithinCalendarDays } from "../utils";

/**
 * 执行两阶段 AI 管线。
 *
 * - SKIP_AI 模式：从 ctx.mode 拿 summaryCache + relevantUrls → makeSkipAiRunner（零 LLM）
 * - AI 模式：直接走 generateDaily 全量（其内部读取 article-history 摘要缓存复用）
 *
 * 失败抛错（与原 main 行为一致：管线失败 = 整个 daily 失败）。
 */
export async function runAiPipeline(
  articles: ArticleInput[],
  ctx: DailyContext,
): Promise<DailyReport> {
  const inputs: Pass1Input[] = articles.map(toPass1Input);
  ctx.log.info(
    "ai",
    `进入两阶段 AI 管线：${inputs.length} 条（PASS1 筛选 + PASS2 成稿 + 校验回炉/降级）`,
  );

  // SKIP_AI：完全本地合成，零 LLM（原行为，最高优先级）
  if (ctx.mode.kind === "skip-ai") {
    const runner = makeSkipAiRunner(ctx.mode.summaryCache, ctx.mode.relevantUrls);
    try {
      return await generateDaily(inputs, ctx.date, { runner });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`[daily] 管线生成失败：${msg}`);
    }
  }

  try {
    // 全 AI 模式下复用 pre1 预分析成果：把 article-history 中 ai_relevant=true 且
    // 已有 summary、且发布时间落在抓取窗口内的条目抽出，作为 PASS2 的 prefillCache。
    // 命中条目在 PASS2 直接确定性复用 summary，不调 LLM，降低调用费用。
    const prefillCache = buildPrefillCache(ctx.history);
    const report = await generateDaily(inputs, ctx.date, { prefillCache });
    const totalKept = (Object.values(report.sections) as { length: number }[]).reduce(
      (n, s) => n + s.length,
      0,
    );
    ctx.log.info(
      "ai",
      `管线产出：必读 ${report.must_read.length} 条 / 商机 ${report.insights.length} 条 / 正文 ${totalKept} 条（预分析复用 ${prefillCache.size} 条 summary）`,
    );
    return report;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[daily] 管线生成失败：${msg}`);
  }
}

/**
 * 从 article-history 构建 prefillCache（url→summary），供全 AI 模式 PASS2 复用。
 * 仅纳入：ai_relevant===true + 有非空 summary + 发布时间落在抓取窗口内（最近 2 天）。
 * 窗口对齐 history.ts 的 isFreshEntry 主路径，确保只复用「昨晚 pre1 打标」的近期成果，
 * 不碰历史库中更早的条目。
 */
function buildPrefillCache(history: HistoryStore): Map<string, string> {
  const cache = new Map<string, string>();
  for (const [url, e] of Object.entries(history)) {
    if (e?.ai_relevant !== true) continue;
    const s = e.summary?.trim();
    if (!s) continue;
    if (!e.publishedAt) continue;
    if (!isWithinCalendarDays(e.publishedAt, FETCH_WINDOW_DAYS)) continue;
    cache.set(url, s);
  }
  return cache;
}
