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
  /** 股市消息清单维度（底部「股市动态」面板用）：a-share / hk / us，供筛选条过滤。 */
  market?: "a-share" | "hk" | "us";
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
  /** 行情指数（新浪行情 API，非 LLM）：收盘点位 + 涨跌幅（带符号）。 */
  indices?: { name: string; value: string; changePct?: string }[];
  /** 卡脚小字备注（2026-08-25 用户拍板，替代来源链接按钮）：信息来源网站 + 数据时间 + 交叉验证网站。 */
  meta?: {
    /** 信息来源网站（该市场主源名，取自输入条目 source，非 LLM 生成） */
    source: string;
    /** 数据时间（该市场输入条目最新日期 YYYY-MM-DD） */
    date: string;
    /** 交叉验证网站（该市场第二独立源名） */
    crossCheck: string;
  };
  /** 大盘解读权威源（2026-08-29 用户：港股大盘解读应锚定新浪财经等收评/总结报告）。
   *  取输入中标题含「收评/综述/复盘」的港股条目，附标题+链接，卡内展示「直接看原报告」入口。 */
  sourceReport?: { title: string; url: string };
}

/** 昨日股市复盘三卡（美股 / A股 / 港股）。 */
export interface StockRecap {
  us: MarketCard;
  aShare: MarketCard;
  hk: MarketCard;
  /** 行情数据来源与取值日（新浪行情 / 上一交易日），卡脚备注用，随 store 持久化、SKIP_AI 复用。 */
  quoteChannel?: string;
  quoteDate?: string;
  /**
   * 股市数据所属交易日状态（2026-08-30 用户：周末/周一报告应提示为上一开盘日数据）。
   * - isMarketClosed：报告生成日是否非交易日（六/日/一）；此时股市数据为上一交易日收盘。
   * - reportDate：报告生成日 YYYY-MM-DD。
   * - dataDate：数据实际所属交易日（= 上一交易日）YYYY-MM-DD。
   * - note：页面展示文案（如「周末及周一休市时段，以下行情为上一交易日（8月28日 周五）收盘数据」）；交易日为空串。
   * - spokenNote：口播专用日期说明（2026-08-30 用户：口播须说清是上个交易日几月几号的情况，
   *   故**交易日也必须带日期**，与 note 只在非交易日有内容不同）。由 computeMarketStatus 单一产出。
   */
  marketStatus?: {
    isMarketClosed: boolean;
    reportDate: string;
    dataDate: string;
    /** @deprecated 保留兼容旧 store.json；新逻辑用 spokenNote。 */
    note?: string;
    spokenNote?: string;
  };
}

/** 股市消息清单单条（底部「股市动态」面板，按 A股/港股/美股 过滤）。
 *  由 raw 抓取条目直接转换，非 AI 生成；承载「具体的板块细节与细节新闻」下沉到消息卡片清单。 */
export interface StockNewsItem extends ReportItem {
  /** 市场维度：a-share | hk | us，供筛选条过滤。 */
  market: "a-share" | "hk" | "us";
}

/** 今日风险（M 层：行长 5 分钟核心决策信息之一）。
 *  与 insights 对称：1 个最值得警惕的事件 + 依据 + 影响 + 建议。
 *  影响按部门拆解（个贷/财富/私行/公司/风控），让行长听到后知道"该让哪个部门做什么"。 */
export interface RiskItem {
  /** 风险主题（≤15 字，如"央行重申防止资金空转"） */
  topic: string;
  /** 依据（1 句，事件本身，不写"市场波动"这类虚词） */
  evidence: string;
  /** 本行影响（按部门拆解，40-60 字） */
  impact: string;
  /** 建议动作（具体可执行，40-60 字） */
  action: string;
  /** 关联条目 URL（从输入 finance/gz 中按相似度回匹配） */
  url?: string;
  /** 来源权威等级（T1 央妈/T1.5 监管/T2 媒体） */
  source?: "T1" | "T1.5" | "T2";
  /** 来源链接（1-3 条，类似 insights.sources） */
  sources?: Array<{ title: string; url: string }>;
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
  /** Optional 股市消息清单（底部「股市动态」面板）：三市场原始新闻条目，按 A股/港股/美股 过滤。非 AI 生成。 */
  stock_news?: StockNewsItem[];
  /** M 层：今日风险（1 条最值得警惕）。与 must_read/insights 同源（exec summary LLM），用于音频「风险预警」段。 */
  risk?: RiskItem;
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
  /**
   * IPO 内容态（2026-08-31 3漏斗整改 commit②，红线：过滤行为不得依赖源分类字符串）。
   * 归一化入口（fetchAllSources 按 category=gd-ipo/ipo、toMergeArticle 按 routeRegion 结果）
   * 在采集期一次性标注；过滤层据此豁免单机构/标题相似度/跨天去重/源层窗口，替代原先
   * 硬编码 `a.category === "gd-ipo" || a.category === "ipo"` 的脆弱写法。
   */
  isIpo?: boolean;
}
