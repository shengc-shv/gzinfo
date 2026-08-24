/**
 * 管线编排（文档第 6/7 节）：归一化 → PASS1 → PASS2 重试循环 → 仍不过则降级 → finalize。
 *
 * 设计原则（文档第 0 节）：AI 负责创作，但每条创作必须能被代码证伪；
 * 校验不过打回重写，重写不过降级丢弃——单条内容永远丢得起，信任丢不起。
 */
import { runPass1, type LlmRunner, type Pass1Input } from "./pass1";
import { runPass2, ensureSchema, finalizeRanks } from "./pass2";
import { rollUpTags } from "../classify/tag-rollup";
import {
  validateReport,
  ALLOWED_TAGS,
  BANNED_WORDS,
  SECTIONS,
  type Issue,
  type ValidationPool,
} from "./validator";
import { extractJson } from "./json-util";
import type { DailyReport, ReportItem, ReportSectionKey } from "../types";
import { titleSimilarity } from "../ingest/dedup-similar";

const MAX_PASS2_RETRY = 2;
const R9_THRESHOLD = 0.8;
const HERO_FALLBACK = "今日暂无可推送重点，详见各板块资讯。";

/** SKIP_AI 模式（无 LLM）下的文章原始分类 → 板块启发式映射。 */
function categoryToSection(cat?: string): ReportSectionKey {
  switch (cat) {
    case "tech":
      return "tech";
    case "ipo":
    case "gd-ipo":
      return "ipo";
    case "gz":
      return "biz_insight"; // 无法判断 locale，保守归业务启示
    case "finance":
    case "politics":
      return "policy_market";
    default:
      return "biz_insight";
  }
}

/**
 * SKIP_AI 确定性降级 runner 工厂：不调用任何 LLM，纯靠输入池字段构造合法 JSON。
 * - PASS1（提示为裸数组、元素含 category 无 section）：全部 keep，按原始 category 启发式归板块。
 * - PASS2（提示为裸数组、元素含 section + raw_text）：照抄字段；
 *   summary 优先取 cache（预分析回填的 article-history.json 摘要），否则取 raw_text 前 90 字；
 *   importance 恒 2。
 * 使 SKIP_AI 模式（CI 失败恢复 / 预分析取全量 / 用户本地预览）仍能产出可读报告。
 *
 * @param cache url→已分析摘要（来自 data/article-history.json / ai-assets）。
 *             使「预加载分析报告」后 SKIP_AI 重跑能直接展示预填解读，零重复 AI。
 *
 * 注意：runPass1 / runPass2 把文章/保留条目以**裸 JSON 数组**注入提示（见 buildPass1User/
 * buildPass2User 的 __ARTICLES_JSON__ / __ITEMS_JSON__），因此此处必须抽取「第一个平衡
 * JSON 数组」并按 `section` 字段区分两阶段，不能用 parsed.items（裸数组无 items 键）。
 */
export function makeSkipAiRunner(
  cache: Map<string, string> = new Map(),
  relevantUrls?: Set<string>,
): LlmRunner {
  return async (_system, userPrompt) => {
    let arr: any[] = [];
    try {
      const parsed = JSON.parse(extractJson(userPrompt));
      if (Array.isArray(parsed)) arr = parsed;
      else if (Array.isArray(parsed?.items)) arr = parsed.items;
    } catch {
      arr = [];
    }
    if (arr.length === 0) {
      return JSON.stringify({ items: [] });
    }
    const isPass2 = arr[0]?.section !== undefined;
    if (!isPass2) {
      // PASS1：元素含 category，无 section。
      // 2026-08-22 修复：SKIP_AI 不再「全部 keep」——若提供了 relevantUrls（历史库
      // ai_relevant=true 的 url 集合），只保留其中的条目，与 render mergeRolling 的
      // 「未打标/无关一律不并入」口径一致，防止今天新抓的非 L0 垃圾（绿色算力/
      // 银行中报/科技公司业绩）在预览/发布时混入板块。未提供时保持旧行为（全 keep，
      // 供无缓存兜底/测试）。
      const keepAll = !relevantUrls;
      return JSON.stringify({
        items: arr
          .filter((it: any) => keepAll || relevantUrls.has(it.url))
          .map((it: any) => ({
            url: it.url,
            keep: true,
            // gz_hint 提权（2026-08-21）：标题含广州锚词 → 广州本地板块 + locale=gz，
            // 否则 gz 保守归业务启示（无法判断 locale 时宁缺毋滥）。
            section: it.gz_hint ? "gz_local" : categoryToSection(it.category),
            source_type: "media",
            locale: it.gz_hint ? "gz" : "national",
            locale_evidence: it.gz_hint ? (it.title || "").slice(0, 40) : "",
            tags: rollUpTags(it),
            title_cn: it.title || "",
            title_orig: "",
            importance_candidate: 2,
          })),
      });
    }
    // PASS2：元素含 section + raw_text → 照抄字段，summary 优先用预填缓存
    const sections: Record<ReportSectionKey, any[]> = {
      gz_local: [],
      biz_insight: [],
      policy_market: [],
      tech: [],
      ipo: [],
    };
    for (const it of arr) {
      const sec: ReportSectionKey = SECTIONS.includes(it.section) ? it.section : "biz_insight";
      const cached = cache.get(it.url);
      sections[sec].push({
        url: it.url,
        title_cn: it.title_cn || "",
        title_orig: it.title_orig || "",
        source: it.source || "",
        source_type: it.source_type || "media",
        date: it.date || "",
        summary: cached ?? (it.raw_text || "").slice(0, 90),
        importance: 2,
        tags: Array.isArray(it.tags) ? it.tags : [],
        locale: it.locale || "national",
        locale_evidence: it.locale_evidence || "",
      });
    }
    // SKIP_AI 无 AI 写 hero_line：用首条标题兜底一条 15~70 字定调，避免 R4 空 hero_line block。
    const heroTitle = arr[0]?.title_cn || arr[0]?.title_orig || "";
    const hero_line = heroTitle ? `今日更新 ${arr.length} 条资讯：${heroTitle}`.slice(0, 70) : "";
    return JSON.stringify({ hero_line, must_read: [], insights: [], sections });
  };
}

/** 向后兼容：无缓存的默认 SKIP_AI runner（测试 / 兜底用）。 */
export const skipAiRunner: LlmRunner = makeSkipAiRunner();

export interface PipelineOptions {
  /** 注入 mock LLM 便于测试。 */
  runner?: LlmRunner;
  /** 回炉次数上限（文档 MAX_PASS2_RETRY=2）。 */
  maxPass2Retry?: number;
}

/** 把 block 问题清单格式化为回炉 prompt 片段。 */
export function formatFeedback(blockers: Issue[]): string {
  return blockers
    .map((b, i) => `${i + 1}. 【${b.msg}】涉及《${b.where}》`)
    .join("\n");
}

/** 构造校验池（url → raw_text）。 */
function buildPool(inputs: Pass1Input[]): ValidationPool {
  const m = new Map<string, { raw_text: string }>();
  for (const i of inputs) m.set(i.url, { raw_text: i.raw_text });
  return {
    get: (url: string) => m.get(url),
  };
}

/**
 * 正文指纹归一化：折叠空白 + 转小写。仅当去除无关字符后仍 >80 字才返回有效指纹，
 * 避免把「短摘要/空正文」的多条不同文章误判为同一篇而误删。
 */
function contentFingerprint(s: string): string {
  const n = s.replace(/\s+/g, " ").trim().toLowerCase();
  return n.length > 80 ? n : "";
}

/**
 * AI 前置低成本过滤（零 LLM 调用）：在把文章池交给 PASS1 之前先砍掉两类本就会被丢弃的条目，
 * 省下对应的 AI token。
 *  - 违禁词（BANNED_WORDS）命中：原逻辑要到 PASS1 早筛才丢，现提前拦截，输出零变化。
 *  - 完全相同正文（归一化指纹一致，常因同源多端转发/镜像）：只保留首条，避免重复分析同一篇。
 * 返回过滤后输入与丢弃计数（仅用于日志）。
 */
export function preFilterForAi(inputs: Pass1Input[]): {
  kept: Pass1Input[];
  droppedBanned: number;
  droppedDup: number;
} {
  const seen = new Set<string>();
  const kept: Pass1Input[] = [];
  let droppedBanned = 0;
  let droppedDup = 0;
  for (const it of inputs) {
    const blob = `${it.title ?? ""}\n${it.raw_text ?? ""}`;
    if (BANNED_WORDS.some((w) => blob.includes(w))) {
      droppedBanned++;
      continue;
    }
    const fp = contentFingerprint(it.raw_text ?? "");
    if (fp) {
      if (seen.has(fp)) {
        droppedDup++;
        continue;
      }
      seen.add(fp);
    }
    kept.push(it);
  }
  return { kept, droppedBanned, droppedDup };
}

function allItems(report: DailyReport): ReportItem[] {
  return SECTIONS.flatMap((s) => report.sections[s]);
}
function allUrls(report: DailyReport): Set<string> {
  return new Set(allItems(report).map((i) => i.url));
}

function bannedIn(text: string): boolean {
  return BANNED_WORDS.some((w) => text.includes(w));
}

/** 降级步骤①：跨板块相似标题去重，保留先出现者，丢弃其余。 */
function degradeDedup(report: DailyReport): void {
  const seen: Array<{ title: string; key: string }> = [];
  for (const sec of SECTIONS) {
    const kept: ReportItem[] = [];
    for (const it of report.sections[sec]) {
      const t = it.title_cn || it.title_orig || "";
      const dup = seen.find(
        (s) =>
          (s.title && t && titleSimilarity(s.title, t) > R9_THRESHOLD) ||
          (s.key && it.url === s.key),
      );
      if (dup) continue;
      seen.push({ title: t, key: it.url });
      kept.push(it);
    }
    report.sections[sec] = kept;
  }
}

/** 降级步骤③：importance 强制分布（全量 ≤3，每板块 ≤1；must_read 命中优先保 3）。 */
function degradeImportance(report: DailyReport): void {
  const mustSet = new Set(report.must_read.map((m) => m.url).filter(Boolean));
  // 每板块 ≤1
  for (const sec of SECTIONS) {
    let threes = 0;
    for (const it of report.sections[sec]) {
      if (it.importance === 3) {
        threes++;
        if (threes > 1) it.importance = 2;
      }
    }
  }
  // 全量 ≤3：must_read 命中优先
  const all = allItems(report).sort((a, b) => {
    const am = mustSet.has(a.url) ? 1 : 0;
    const bm = mustSet.has(b.url) ? 1 : 0;
    return bm - am;
  });
  let threes = 0;
  for (const it of all) {
    if (it.importance === 3) {
      threes++;
      if (threes > 3) it.importance = 2;
    }
  }
}

/** 通过 URL 或标题在报告中定位并删除某条（降级步骤②）。 */
function dropItemByWhere(report: DailyReport, where: string): void {
  for (const sec of SECTIONS) {
    report.sections[sec] = report.sections[sec].filter(
      (it) => it.url !== where && (it.title_cn || "") !== where,
    );
  }
}

/**
 * 降级（文档第 7.2 节，绝不带病上线，粒度从细到粗）。
 * 返回是否发生任何修改（便于测试）。
 */
export function degrade(report: DailyReport, blockers: Issue[]): DailyReport {
  // ① R9 去重
  degradeDedup(report);
  // ② 单条内容错误（where 为条目标题或 url）
  for (const b of blockers) {
    if (/R2|R3|R7|R10|R1/.test(b.msg)) dropItemByWhere(report, b.where);
  }
  // ③ R5 importance 超限
  degradeImportance(report);
  // ④ 违禁词兜底：逐条序列化扫描 sections 与 insights，命中即丢
  for (const sec of SECTIONS) {
    report.sections[sec] = report.sections[sec].filter(
      (it) => !bannedIn(JSON.stringify(it)),
    );
  }
  report.insights = report.insights.filter((it) => !bannedIn(JSON.stringify(it)));
  // ⑤ insights 兜底：impact/action 为空的丢弃，截断至 5
  report.insights = report.insights
    .filter((it) => it.impact?.trim() && it.action?.trim())
    .slice(0, 5);
  // ⑥ R10 非法 tag 兜底（清理而非丢条）
  for (const sec of SECTIONS) {
    const allowed = new Set<string>(ALLOWED_TAGS);
    for (const it of report.sections[sec]) {
      it.tags = it.tags.filter((t) => allowed.has(t));
    }
  }
  // ⑦ hero_line 兜底
  const h = report.hero_line?.trim() ?? "";
  const n = [...h].length;
  if (!h || n < 15 || n > 70) {
    const first = report.must_read[0];
    if (first?.url) {
      const it = allItems(report).find((x) => x.url === first.url);
      if (it) report.hero_line = `今日关注：${it.title_cn || it.title_orig || ""}`.slice(0, 70);
    }
    if (!report.hero_line || [...(report.hero_line || "")].length < 15) {
      report.hero_line = HERO_FALLBACK;
    }
  }
  // ⑧ must_read 兜底：剔除指向已删除条目的引用，截断至 5
  const urls = allUrls(report);
  report.must_read = report.must_read
    .filter((m) => !m.url || urls.has(m.url))
    .slice(0, 5);
  return report;
}

/**
 * 主入口：生成当日报告。
 * @param inputs 经归一化 + 关键词漏斗预筛后的文章池
 * @param date YYYY-MM-DD
 */
export async function generateDaily(
  inputs: Pass1Input[],
  date: string,
  opts: PipelineOptions = {},
): Promise<DailyReport> {
  const runner = opts.runner;
  const maxRetry = opts.maxPass2Retry ?? MAX_PASS2_RETRY;
  const pool = buildPool(inputs);

  // AI 前置低成本过滤（零 LLM）：违禁词 + 同正文指纹去重，省 token
  const pre = preFilterForAi(inputs);
  if (pre.droppedBanned > 0 || pre.droppedDup > 0) {
    console.log(
      `[pipeline] 🤖 AI 前置过滤: 输入 ${inputs.length} → ${pre.kept.length} 条（违禁词 ${pre.droppedBanned} / 同内容重复 ${pre.droppedDup}，零 LLM 成本）`,
    );
  }

  // 空输入（PASS1 全丢弃）→ 合法空报告，不抛异常
  const kept = await runPass1(pre.kept, runner);
  if (kept.length === 0) {
    return {
      date,
      hero_line: HERO_FALLBACK,
      must_read: [],
      insights: [],
      sections: {
        gz_local: [],
        biz_insight: [],
        policy_market: [],
        tech: [],
        ipo: [],
      },
    };
  }

  let report: DailyReport = { date, hero_line: "", must_read: [], insights: [], sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] } };
  let blockers: Issue[] = [];

  // PASS2 重试循环（首次 + maxRetry 次回炉）；全部失败则进入降级
  for (let attempt = 1; attempt <= maxRetry + 1; attempt++) {
    const feedback = blockers.length ? formatFeedback(blockers) : "";
    report = await runPass2(kept, runner!, feedback);
    report.date = date;
    ensureSchema(report);
    finalizeRanks(report);
    const issues = validateReport(report, pool);
    blockers = issues.filter((i) => i.level === "block");
    if (blockers.length === 0) break;
    console.warn(
      `[pipeline] PASS2 第 ${attempt} 次存在 ${blockers.length} 条 block（回炉/降级）`,
    );
  }

  if (blockers.length > 0) {
    console.warn(`[pipeline] 进入降级路径，block ${blockers.length} 条`);
    report = degrade(report, blockers);
    ensureSchema(report);
    finalizeRanks(report);
  }

  return report;
}
