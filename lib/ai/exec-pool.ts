/**
 * 必读 / 商机洞察的「2 天窗口」输入池构建（2026-08-23 用户需求）。
 *
 * 背景：两阶段管线的 PASS2 只消费「本次进入管线的 kept 条目」来产出 must_read /
 * insights，导致昨天发布、今天已从 RSS 滚动列表掉落的优质条目被排除。用户要求
 * 必读与商机应基于「今天 + 昨天」两天内的信息形成。
 *
 * 做法：从两个来源拼出 2 天窗口的高信号条目：
 *  - report.sections：本次管线 PASS2 已富集摘要的「今天」条目（含今日 AI 摘要）；
 *  - history（article-history.json）：昨天（及更早）已打标 ai_relevant=true、有摘要的条目
 *    （RSS 掉落的昨日条目在这里仍可被检索到，弥补 feed 滚动丢失）。
 * 两者按 url 去重，窗口用 publishedAt 在 REPORT_TZ 下落在「今/昨」两天筛选，
 * 只保留 category ∈ {finance, gz}（必读=宏观政策、商机=广州业务）。
 *
 * 纯函数，便于单测；daily.ts 在生成报告后调用，结果喂 generateExecutiveSummary。
 */
import { getReportTz, todayKey } from "../utils";
import type { DailyReport, ReportSectionKey } from "../types";

/** 持久化历史库条目（article-history.json 单条子集）。 */
export interface ExecPoolHistoryEntry {
  publishedAt?: string | Date;
  category?: string;
  summary?: string;
  ai_relevant?: boolean;
  title?: string;
  subcategory?: string;
  url?: string;
}

/** 本次管线文章（scripts/daily.ts 的 ArticleInput 子集）。 */
export interface ExecPoolArticle {
  url: string;
  publishedAt?: string | Date;
  category?: string;
  title?: string;
  excerpt?: string;
  summary?: string;
}

/** 给 generateExecutiveSummary 的单条输入形态。 */
export interface ExecPoolItem {
  title: string;
  summary?: string;
  subcategory?: string;
  url?: string;
}

export interface ExecPoolResult {
  finance: ExecPoolItem[];
  gz: ExecPoolItem[];
}

/**
 * 把 ISO 日期串 / Date 在指定时区下归一化为 YYYY-MM-DD 日期键。
 * 无效日期返回 undefined（调用方据此跳过）。
 */
export function dateKeyOf(iso: string | Date | undefined, tz?: string): string | undefined {
  if (!iso) return undefined;
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** section → 必读/商机来源类别（只取宏观政策 finance 与广州业务 gz）。 */
const SECTION_TO_CAT: Record<ReportSectionKey, "finance" | "gz" | null> = {
  policy_market: "finance",
  gz_local: "gz",
  biz_insight: "gz",
  tech: null,
  ipo: null,
};

const RELEVANT_CAT = new Set(["finance", "gz"]);

export interface BuildTwoDayExecPoolOpts {
  history: Record<string, ExecPoolHistoryEntry>;
  articles: ExecPoolArticle[];
  report: DailyReport;
  /** 参照「今天」；默认取 REPORT_TZ 当前日期。注入便于单测。 */
  today?: string;
}

/**
 * 构建 2 天窗口（今天 + 昨天）的必读/商机输入池。
 * - 窗口边界以 REPORT_TZ 下的日期键比对，正确处理时区（如 Asia/Shanghai）。
 * - 今天条目取自 report.sections（已 AI 摘要）；昨天条目取自 history（ai_relevant 且有摘要）。
 * - 无 publishedAt / 超窗口 / 非 finance|gz 的条目一律排除。
 */
export function buildTwoDayExecPool(opts: BuildTwoDayExecPoolOpts): ExecPoolResult {
  const tz = getReportTz();
  const tk = opts.today ?? todayKey();
  // 昨天：以「今天 00:00 减 24h」再取日期键，规避 DST 边缘（Asia/Shanghai 无 DST）。
  const yk = opts.today
    ? shiftDayKey(opts.today, -1)
    : todayKey(new Date(Date.now() - 86_400_000));
  const inWindow = (iso: string | Date | undefined): boolean => {
    const k = dateKeyOf(iso, tz);
    return k === tk || k === yk;
  };

  // publishedAt 查表（url → publishedAt），优先 history、补 articles。
  const pubByUrl = new Map<string, string | Date>();
  for (const [url, e] of Object.entries(opts.history)) {
    if (e.publishedAt) pubByUrl.set(url, e.publishedAt);
  }
  for (const a of opts.articles) {
    if (a.publishedAt) pubByUrl.set(a.url, a.publishedAt);
  }

  // 汇总「有摘要」的候选（今日来自 report.sections，昨日来自 history）。
  const items = new Map<
    string,
    { title: string; summary: string; cat: "finance" | "gz"; subcategory?: string }
  >();
  // 今日 sections 来源 url 集合：这些条目天然属于「今天」，窗口判定时即使
  // pubByUrl 查不到 publishedAt 也视为在窗口内（避免今日条目被误跳过）。
  const todayUrls = new Set<string>();

  // 今日：report.sections（PASS2 已富集摘要）
  for (const sec of Object.keys(opts.report.sections) as ReportSectionKey[]) {
    const cat = SECTION_TO_CAT[sec];
    if (!cat) continue;
    for (const it of opts.report.sections[sec]) {
      if (!it.summary?.trim()) continue;
      todayUrls.add(it.url);
      items.set(it.url, {
        title: it.title_cn || it.title_orig || "",
        summary: it.summary,
        cat,
      });
    }
  }

  // 昨日（及更早，但窗口会滤掉）：history 中已打标相关、有摘要
  for (const [url, e] of Object.entries(opts.history)) {
    if (items.has(url)) continue;
    const cat = RELEVANT_CAT.has(e.category ?? "") ? (e.category as "finance" | "gz") : null;
    if (!cat) continue;
    if (e.ai_relevant !== true) continue;
    if (!e.summary?.trim()) continue;
    items.set(url, {
      title: e.title || "",
      summary: e.summary,
      cat,
      ...(e.subcategory ? { subcategory: e.subcategory } : {}),
    });
  }

  // 窗口过滤 + 分类拆分
  const finance: ExecPoolItem[] = [];
  const gz: ExecPoolItem[] = [];
  for (const [url, info] of items) {
    const p = pubByUrl.get(url);
    if (p) {
      if (!inWindow(p)) continue;
    } else if (!todayUrls.has(url)) {
      // 无 publishedAt 且非今日 sections 来源（多来自 history）→ 无法判定窗口，跳过
      continue;
    }
    const entry: ExecPoolItem = { title: info.title, summary: info.summary, url };
    if (info.subcategory) entry.subcategory = info.subcategory;
    (info.cat === "finance" ? finance : gz).push(entry);
  }

  return { finance, gz };
}

/**
 * 收集「今天 + 昨天」两天的**可评分**文章池（供评分层兜底 / 护栏使用）。
 *
 * 与 buildTwoDayExecPool 的区别：本函数**不要求条目已有 summary**
 * （SKIP_AI 下历史条目普遍无摘要，buildTwoDayExecPool 会因无摘要全部滤掉），
 * 因此可在零 LLM 下驱动 scoreBranchRelevance 兜底生成必读/商机。
 *
 * 必要性（2026-08-29 实测）：用户 6-8 点跑，跨天判重后「今天」常只剩 10 余条新条目，
 * 且多为低信号 → 只看今天的兜底会产出空必读。昨日白天的重要条目虽被判重剔除出当日池，
 * 但仍在历史库中，必须捞回才能覆盖「今天+昨天」两天。
 *
 * 来源：本次抓取 articles（今天）+ 历史库 history（补回昨日）。按 url 去重。
 */
export interface ScorablePoolEntry {
  title: string;
  category?: string;
  subcategory?: string;
  source?: string;
  sourceId?: string;
  summary?: string;
  url?: string;
  locale?: string;
}

export function collectTwoDayArticles(opts: {
  history?: Record<string, ExecPoolHistoryEntry>;
  articles?: ExecPoolArticle[];
  today?: string;
}): ScorablePoolEntry[] {
  const tz = getReportTz();
  const tk = opts.today ?? todayKey();
  const yk = shiftDayKey(tk, -1);
  const out = new Map<string, ScorablePoolEntry>();
  const inWindow = (iso: string | Date | undefined): boolean => {
    const k = dateKeyOf(iso, tz);
    return k === tk || k === yk;
  };

  // 今天：本次抓取（经窗口/判重后的保留条目）
  for (const a of opts.articles ?? []) {
    if (!a.url || !inWindow(a.publishedAt)) continue;
    const x = a as unknown as { subcategory?: string; source?: string; sourceId?: string; locale?: string };
    out.set(a.url, {
      title: a.title ?? "",
      category: a.category,
      ...(x.subcategory ? { subcategory: x.subcategory } : {}),
      ...(x.source ? { source: x.source } : {}),
      ...(x.sourceId ? { sourceId: x.sourceId } : {}),
      ...(a.summary ? { summary: a.summary } : {}),
      ...(x.locale ? { locale: x.locale } : {}),
      url: a.url,
    });
  }
  // 昨天（及今天）：历史库补回被跨天判重剔除的条目
  for (const [url, e] of Object.entries(opts.history ?? {})) {
    if (out.has(url) || !inWindow(e.publishedAt)) continue;
    const x = e as unknown as { source?: string; sourceId?: string; locale?: string };
    out.set(url, {
      title: e.title ?? "",
      category: e.category,
      ...(e.subcategory ? { subcategory: e.subcategory } : {}),
      ...(x.source ? { source: x.source } : {}),
      ...(x.sourceId ? { sourceId: x.sourceId } : {}),
      ...(e.summary ? { summary: e.summary } : {}),
      ...(x.locale ? { locale: x.locale } : {}),
      url,
    });
  }
  return [...out.values()];
}

/** YYYY-MM-DD 加减 n 天，返回 YYYY-MM-DD（纯字符串运算，规避时区）。 */
function shiftDayKey(key: string, deltaDays: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + deltaDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt);
}
