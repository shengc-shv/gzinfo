export type Category = "tech" | "finance" | "politics" | "gd-ipo" | "ipo" | "gz" | "stocks";
export type SourceType = "rss" | "api" | "scrape";
import type { SourceTier } from "./tiers";

export interface SourceDef {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  category: Category;
  /**
   * Group key within a category. Render order/labels are defined per
   * category in lib/output/render.ts. Categories without a registered
   * order render flat (no L2 tabs).
   */
  subcategory?: string;
  /**
   * When true, the rss fetcher shells out to curl instead of using
   * Node's undici. Required for hosts that TLS-fingerprint Node
   * (Cloudflare's "Just a moment…" challenge — LinuxDo, Reddit, etc.)
   */
  useCurl?: boolean;
  enabled?: boolean;
  /**
   * Source content language. Default treated as "en". When this equals
   * the active REPORT_LOCALE, the summary-enrichment step skips this
   * source — its content is already in the target language, so an LLM
   * "summary" would just be a slightly-shorter rewrite.
   */
  lang?: "zh" | "en";
  /**
   * Report locales this source participates in. Defaults to ["zh", "en"]
   * (both) when omitted. Set to ["zh"] for Chinese-only sources whose
   * content is meaningless to English-mode readers (V2EX/LinuxDo/etc.),
   * or ["en"] for English-community sources used to replace Chinese ones
   * when REPORT_LOCALE=en. The registry filters by REPORT_LOCALE at load.
   */
  locales?: ("zh" | "en")[];
  /**
   * Optional human-readable note explaining why a source is disabled or
   * any context useful for fork users. Ignored at runtime.
   */
  notes?: string;
  /**
   * Optional keyword filter list. When present, only items whose title or
   * body matches at least one keyword (case-insensitive) are kept.
   * Omit or leave empty to return all items unfiltered.
   */
  keywords?: string[];
  /**
   * 源角色（M3-D）：crawled-input = 爬虫产物路由源（url 为 file:// 占位，
   * 实际数据由 TS 爬虫 lib/sources/crawlers/* 产出、经 lib/ingest/merge.ts 归一化接入；
   * 保留在 config 仅为 groupRaw 的 knownSourceIds 白名单识别）。缺省为普通源。
   */
  role?: "crawled-input" | string;
  /**
   * 源等级（T6）：T1=官方一手（政府/央行/监管）、T1.5=准官方·机构一手（交易所/
   * 行业协会/官方背景机构）、T2=媒体·智库。采集层声明，归一化层透传进 RawArticle，
   * 渲染层差异化标识。缺省按 T2 处理。
   */
  tier?: SourceTier;
}

export interface RawArticle {
  sourceId: string;
  title: string;
  url: string;
  excerpt?: string;
  publishedAt?: Date;
  /**
   * 采集时间（信息被抓取的时间）。仅当 publishedAt 缺失时作为回退：
   * 窗口过滤（filterByWindow/filterRecentDays）与排序统一按
   * `publishedAt ?? fetchedAt` 处理（2026-08-19 用户确认：
   * 没有发布时间的采用信息采集时间）。
   * - 抓取/爬虫条目：本次抓取时补 new Date()；
   * - 历史条目：回退为 lastSeenAt（最近一次被采集/确认的时间）。
   */
  fetchedAt?: Date;
  category: Category;
  /**
   * LLM-generated summary in the active REPORT_LOCALE language. For zh
   * reports this is the Chinese translation/summary of an English source;
   * for en reports it'd be the English summary of a non-English source.
   */
  summary?: string;
  /**
   * Structured one-line metadata to display above the excerpt — currently
   * used by GitHub Trending for "Language · ★stars · forks · stars today".
   */
  meta?: string;
  /**
   * Set by the report entrypoint (daily.ts / dry-run.ts) after merging the
   * rolling 30-day history. `true` = fetched in the current run (shown under
   * the "当天" tab); absent/false = carried from previous runs' history
   * (shown under the "过去30天" tab). Never set by fetchers.
   */
  fetchedToday?: boolean;
  /**
   * 条目级子标签（AI/启发式逐条分类结果，覆盖注册表源级 subcategory）。
   * 由分析脚本写入历史库，buildRolling 透传；groupRaw 优先用它路由子标签。
   */
  subcategory?: string;
  /**
   * 条目级多标签（AI 分类结果，多值：一条信息可影响多个业务线）。
   * 非空时 groupRaw 按数组多归桶；与 subcategory 二选一（subcategories 优先）。
   */
  subcategories?: string[];
  /**
   * 条目级相关性（AI/启发式判断）：false = 与银行业务无关，渲染时过滤。
   */
  relevant?: boolean;
  /**
   * Populated by render's cross-source story dedup: when several sources
   * cover the same story inside a merged subgroup, the kept item lists the
   * other source names here so the renderer can show "多家来源" (multi-source).
   * Never set by fetchers.
   */
  alsoFrom?: string[];
  /**
   * 源等级（T6）：由采集层声明、归一化层透传。渲染层据此差异化标识来源权威性。
   */
  tier?: SourceTier;
}
