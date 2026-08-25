/**
 * 共享领域类型（M3-B 迁移自已删除的 lib/ai/pipeline.ts 的类型部分）。
 *
 * pipeline.ts 的运行时实现（generateDailyReport / selectRoundRobin / callOnce）
 * 已确认全仓无调用（daily.ts 注释「已移除以省钱」），整文件删除；4 个被
 * daily/history/render 等依赖的类型保留于此。
 */
import type { RawArticle } from "./sources/types";
import type { SourceTier } from "./sources/tiers";
import type { TickerAnalysis } from "./trading/signals";
import type { CryptoGlobalStats } from "./trading/coingecko";
import type { FearGreedSnapshot } from "./trading/fear-greed";
import type { TradingCommentary, WatchlistPick } from "./ai/trading-commentary";

export interface BriefItem {
  title: string;
  url: string;
  source: string;
  summary: string;
  importance: number;
}

// —— 新管线 schema（2026-08-21 改造：两阶段 AI + 13 条确定性校验）——
// 对外 report 以 sections 驱动渲染；AI 只创作、代码校验证伪。

export type ReportSectionKey =
  | "gz_local"
  | "biz_insight"
  | "policy_market"
  | "tech"
  | "ipo";

export type SourceType = "official" | "media";
export type Locale = "gz" | "national" | "overseas";

/** 单条成稿条目（最终落盘结构，无内部字段）。 */
export interface ReportItem {
  /** 必填，逐字来自输入池。 */
  url: string;
  /** 必填，外文标题必须翻译为中文。 */
  title_cn: string;
  /** 可选，外文原标题。 */
  title_orig?: string;
  /** 必填。 */
  source: string;
  /** official | media。 */
  source_type: SourceType;
  /** MM/DD。 */
  date: string;
  /** 必填，≤90字，结构=发生了什么+关键数字+所以呢。 */
  summary: string;
  /** 3=今日必知 / 2=默认展示 / 1=折叠区。 */
  importance: 1 | 2 | 3;
  /** 板块内排序，从1开始，由代码生成不交给模型。 */
  rank: number;
  /** 封闭词表。 */
  tags: string[];
  /** gz | national | overseas。 */
  locale: Locale;
  /** locale=gz 时必填，必须是该条 raw_text 的逐字子串。 */
  locale_evidence?: string;
  /** 源权威等级（T1/T1.5/T2），由 mergeRollingIntoReport 透传，供同权威等级标题去重。 */
  tier?: SourceTier;
}

export interface ReportInsight {
  topic: string;
  tags: string[];
  impact: string;
  action: string;
  /** 来源链接（1-多个）：①/②/③ 标记点击打开。来自 LLM 引源或按相似度回链报告内真实文章 URL。 */
  sources?: Array<{ title: string; url: string }>;
  related_url?: string;
}

export interface ReportMustRead {
  url: string;
  why: string;
  /** 可选：AI 生成的精炼标题（store.json 携带）。渲染优先用它，缺则按 url 回查 sections 标题，再不行回退 url。 */
  title?: string;
}

export interface ReportSections {
  gz_local: ReportItem[];
  biz_insight: ReportItem[];
  policy_market: ReportItem[];
  tech: ReportItem[];
  ipo: ReportItem[];
}

/** 股市解读单卡：涨跌概况 + 关键板块（口播友好、无零售/对公引申）。 */
export interface MarketCard {
  /** 涨跌概况（1-2 句）：主要指数涨跌方向与幅度 + 最关键驱动因素。 */
  overview: string;
  /** 关键板块（3-5 个）：「板块名：一句话」强弱描述。 */
  sectors: string[];
  /** 口播稿（纯口语）：涨跌概况+关键板块浓缩，≤120 字，可直接朗读。 */
  spoken?: string;
}

/** 昨日股市复盘三卡（美股 / A股 / 港股）。 */
export interface StockRecap {
  us: MarketCard;
  aShare: MarketCard;
  hk: MarketCard;
}

export interface DailyReport {
  date: string;
  /** 今日定调一句话，15~70字，必填（为空时由管线兜底）。 */
  hero_line?: string;
  must_read: ReportMustRead[];
  insights: ReportInsight[];
  sections: ReportSections;
  /** Optional trading-signals section, present when scripts/daily.ts ran successfully. */
  trading?: TradingSection;
  /** Optional 昨日股市复盘三卡（美股/A股/港股），由 lib/ai/stock-recap.ts 生成。 */
  stock_recap?: StockRecap;
}

export interface TradingSection {
  // SKIP_AI / LLM 失败恢复路径下以下字段可能缺失 → 全部可选
  market_overview?: string;
  watchlist?: WatchlistPick[];
  risk_caveat?: string;
  generated_at: string;
  tickers: TickerAnalysis[];
  crypto_fear_greed?: FearGreedSnapshot;
  crypto_global?: CryptoGlobalStats;
}

export interface ArticleInput extends RawArticle {
  source: string;
  /** 外文标题中文化（2026-08-21 重构 #20）：仅今日必读/商机洞察选中的条目由主编回写中文标题 */
  title_cn?: string;
}
