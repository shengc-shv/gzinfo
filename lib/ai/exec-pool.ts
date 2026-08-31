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
import { scoreBranchRelevance } from "./relevance-score";

/** 持久化历史库条目（article-history.json 单条子集）。 */
export interface ExecPoolHistoryEntry {
  publishedAt?: string | Date;
  category?: string;
  summary?: string;
  /** 采集到的原文摘要。未打标条目普遍无 summary，用 excerpt 兜底（实测 305/305 有 excerpt）。 */
  excerpt?: string;
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
  /** 中文化标题（ArticleInput 有；仅今日必读/商机选中的条目会被回写） */
  title_cn?: string;
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
  /**
   * 广东地区 IPO 动态（2026-08-31 新增）。
   * 单独一路：IPO 在审企业状态更新稀疏（几天一更），用 7 天窗口而非 finance/gz 的 2 天。
   * 喂给 exec 提示词的 guangdong_ipo 槽位（该槽位此前从未拿到过输入 → LLM 恒回 null，
   * 口播只能靠 audio.ts 的确定性兜底）。
   */
  ipo: ExecPoolItem[];
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

/**
 * 严格池低于该条数时启用「宽松兜底池」。
 *
 * 2026-08-31 实测：同一天重复运行 CI 时跨天判重会把抓取几乎全部剔除（155 → 8 条），
 * PASS2 几乎无产出；而严格池要求「AI 摘要 + ai_relevant=true」，两天窗口内仅 5 条满足
 * （264 条未打标、仅 5 条有 summary）→ exec 池接近空 → generateExecutiveSummary 按
 * 「无则 null、不要编造」恒回 null → 定调/必读/商机全部落空，与下方展示的滚动并入
 * 条目严重不一致（展示 18 条、 exec 池 0 条）。
 * 取 3：少于 3 条时 LLM 无法形成有意义的定调与必读。
 */
const MIN_STRICT_ITEMS = 3;

/** 宽松兜底池上限，控制 LLM 提示词体积（实测两天窗口内约 132 条候选）。 */
const MAX_RELAXED_ITEMS = 24;

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

  // 兜底：严格池过薄 → 用「今天 + 昨天」两天汇总补齐（2026-08-31 修复）。
  // 噪声控制沿用展示层滚动并入（D-008）的三态门槛，避免灌入个股半年报/外文股市噪声。
  if (finance.length + gz.length < MIN_STRICT_ITEMS) {
    const used = new Set<string>();
    for (const it of [...finance, ...gz]) if (it.url) used.add(it.url);
    for (const r of buildRelaxedTwoDayPool(opts, tz, tk, yk, used)) {
      (r.cat === "finance" ? finance : gz).push(r.item);
    }
  }

  return { finance, gz, ipo: buildIpoPool(opts) };
}

/**
 * 宽松兜底池：从「今天 articles + 昨天/今天 history」捞回两天窗口内的 finance|gz 条目。
 *
 * 与严格池的区别：**不要求 AI 摘要、不要求 ai_relevant=true** —— 实测两天窗口内
 * 275 条里 264 条未打标、仅 5 条有 summary，严格口径几乎全灭。摘要用
 * `summary || excerpt || title` 兜底（history 305/305 有 excerpt，且为真实内容）。
 *
 * 噪声控制沿用展示层 D-008 的三态门槛：
 *   ai_relevant=true 放行 / false 硬排除 / 未打标需 scoreBranchRelevance().tier !== "drop"。
 * 排序：有 AI 摘要优先 → 档位（must_read > insight > context）→ 分行相关性分数。
 */
function buildRelaxedTwoDayPool(
  opts: BuildTwoDayExecPoolOpts,
  /** 报告时区；REPORT_TZ 未设置时为 undefined（Intl 回落到系统时区，与 dateKeyOf 一致）。 */
  tz: string | undefined,
  /** 今天日期键。单测注入 today 时可能为 undefined，此时窗口比较恒 false（保守）。 */
  tk: string | undefined,
  yk: string | undefined,
  used: Set<string>,
): Array<{ cat: "finance" | "gz"; item: ExecPoolItem }> {
  const inWindow = (iso: string | Date | undefined): boolean => {
    const k = dateKeyOf(iso, tz);
    // 无发布时间 → 无法判定是否落在两天窗口内，一律不纳入（遵守「时间真实性」红线，
    // 绝不用抓取时间兜底）。
    if (!k) return false;
    return k === tk || k === yk;
  };
  const TIER_PRIO: Record<string, number> = { must_read: 0, insight: 1, context: 2, drop: 3 };
  const seen = new Set<string>();
  const cands: Array<{
    cat: "finance" | "gz";
    item: ExecPoolItem;
    hasSummary: boolean;
    prio: number;
    score: number;
  }> = [];

  const consider = (
    raw: {
      url?: string;
      title?: string;
      summary?: string;
      excerpt?: string;
      category?: string;
      subcategory?: string;
      publishedAt?: string | Date;
      ai_relevant?: boolean;
    },
    /** true=今日抓取条目（天然属"今天"，仅在有发布时间且超窗口时排除）；
     *  false=历史库条目（走严格窗口 + 硬排除）。今日旁路对应 report.sections 的
     *  todayUrls：避免"无发布时间"被 inWindow 误杀导致 2 天池静默落空。 */
    fromToday: boolean,
  ): void => {
    const url = raw.url;
    if (!url || seen.has(url) || used.has(url)) return;
    const cat = RELEVANT_CAT.has(raw.category ?? "") ? (raw.category as "finance" | "gz") : null;
    if (!cat) return;
    if (fromToday) {
      // 今日抓取：有发布时间但超 2 天窗口才排除；无发布时间（时间红线不允许补抓取日）
      // 一律按"今天"纳入，与 todayUrls 旁路口径一致，杜绝"今日抓取内容被静默丢弃"。
      if (raw.publishedAt) {
        const k = dateKeyOf(raw.publishedAt, tz);
        if (k !== tk && k !== yk) return;
      }
    } else {
      if (raw.ai_relevant === false) return; // 硬排除（历史已判为不相关）
      if (!inWindow(raw.publishedAt)) return; // 只看今天 + 昨天
    }
    const summary = (raw.summary ?? "").trim();
    const scored = scoreBranchRelevance({
      title: raw.title ?? "",
      ...(summary ? { summary } : {}),
      ...(raw.category ? { category: raw.category } : {}),
      ...(raw.subcategory ? { subcategory: raw.subcategory } : {}),
    });
    // 三态门槛（与展示层滚动并入同口径）：已打标 true 放行；未打标需非 drop 档。
    if (raw.ai_relevant !== true && scored.tier === "drop") return;
    seen.add(url);
    cands.push({
      cat,
      item: {
        title: raw.title ?? "",
        summary: summary || (raw.excerpt ?? "").trim() || raw.title || "",
        url,
      },
      hasSummary: !!summary,
      prio: TIER_PRIO[scored.tier] ?? 2,
      score: scored.score,
    });
  };

  // 今天：本次抓取（经 9 道过滤后保留的条目）—— 按"今日"纳入（见 consider 的 fromToday 旁路）
  for (const a of opts.articles) {
    const x = a as unknown as { subcategory?: string };
    consider(
      {
        url: a.url,
        title: a.title_cn || a.title,
        ...(a.summary ? { summary: a.summary } : {}),
        ...(a.excerpt ? { excerpt: a.excerpt } : {}),
        ...(a.category ? { category: a.category } : {}),
        ...(x.subcategory ? { subcategory: x.subcategory } : {}),
        ...(a.publishedAt ? { publishedAt: a.publishedAt } : {}),
      },
      true,
    );
  }
  // 昨天（以及今天被跨天判重剔除的）：历史库补回 —— 走严格窗口 + 硬排除
  for (const [url, e] of Object.entries(opts.history)) {
    consider(
      {
        url,
        ...(e.title ? { title: e.title } : {}),
        ...(e.summary ? { summary: e.summary } : {}),
        ...(e.excerpt ? { excerpt: e.excerpt } : {}),
        ...(e.category ? { category: e.category } : {}),
        ...(e.subcategory ? { subcategory: e.subcategory } : {}),
        ...(e.publishedAt ? { publishedAt: e.publishedAt } : {}),
        ...(e.ai_relevant === undefined ? {} : { ai_relevant: e.ai_relevant }),
      },
      false,
    );
  }

  cands.sort((a, b) => {
    if (a.hasSummary !== b.hasSummary) return a.hasSummary ? -1 : 1;
    if (a.prio !== b.prio) return a.prio - b.prio;
    return b.score - a.score;
  });
  return cands.slice(0, MAX_RELAXED_ITEMS).map((c) => ({ cat: c.cat, item: c.item }));
}

/**
 * 广东地区 IPO 池（7 天窗口，独立于 finance/gz 的 2 天窗口）。
 *
 * 为什么单独一路（2026-08-31）：
 *  - IPO 在审企业状态更新稀疏（东财在审表实测几天一更），2 天窗口会把绝大多数
 *    在审动态滤掉 —— 与过滤层「gd-ipo 按 7 天窗口豁免」同一理由。
 *  - `SECTION_TO_CAT.ipo = null`：IPO 不是必读/商机素材，只是口播 guangdong_ipo 段
 *    与板块展示用，因此不并入 finance/gz，避免污染必读/商机。
 *
 * 来源（按优先级）：report.sections.ipo（今日 side-output 构建 + 历史滚动并入）
 * → 不足时补 opts.articles 里的 gd-ipo/ipo 条目（摘要可能为空，用 excerpt 兜底）。
 */
function buildIpoPool(opts: BuildTwoDayExecPoolOpts): ExecPoolItem[] {
  const cutoff = Date.now() - 7 * 86_400_000;
  const inIpoWindow = (iso: string | Date | undefined): boolean => {
    if (!iso) return true; // 无 publishedAt：今日 sections/本次抓取的条目不因此丢
    const t = new Date(iso).getTime();
    return Number.isNaN(t) || t >= cutoff;
  };
  const out = new Map<string, ExecPoolItem>();

  for (const it of opts.report.sections.ipo ?? []) {
    if (!it.url) continue;
    const summary = (it.summary || "").trim();
    if (!summary) continue;
    out.set(it.url, { title: it.title_cn || it.title_orig || "", summary, url: it.url });
  }
  // 今日抓取的 gd-ipo/ipo 条目（sections 里可能还没有 —— 取决于 side-output 执行顺序）
  for (const a of opts.articles) {
    const cat = a.category ?? "";
    if (cat !== "gd-ipo" && cat !== "ipo") continue;
    if (!a.url || out.has(a.url)) continue;
    if (!inIpoWindow(a.publishedAt)) continue;
    out.set(a.url, {
      title: a.title_cn || a.title || "",
      summary: (a.summary || a.excerpt || "").slice(0, 120),
      url: a.url,
    });
  }
  return [...out.values()].slice(0, 20);
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
  // 今日抓取条目天然属"今天"：有发布时间且超 2 天窗口才排除；无发布时间按"今天"纳入
  // （时间红线不补抓取日，但也不能因缺发布时间被静默丢弃，否则 SKIP_AI 兜底池随之落空）。
  for (const a of opts.articles ?? []) {
    if (!a.url) continue;
    if (a.publishedAt && !inWindow(a.publishedAt)) continue;
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
