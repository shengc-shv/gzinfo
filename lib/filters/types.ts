/**
 * 关键词漏斗类型契约（M1）。
 *
 * 对应 sources.keywords.json（银行零售业务关键词体系 v4）的结构 + 过滤结果类型。
 * 本文件只做类型定义，不做实现。
 */
import type { SourceTier } from "../sources/tiers";

/** 单个业务维度规则（dimensions.*）。 */
export interface DimensionRule {
  label?: string;
  tier?: string; // "core" | "opportunity" 等，语义由配置定义
  weekly?: boolean; // true = 命中进周报池，不混入日报
  strong_keywords?: string[];
  weak_keywords?: string[];
  /** weak 关键词 → 必须共现的词（弱词仅凭自身不足命中）。 */
  cooccurrence_for_weak?: Record<string, string[]>;
  /** 命中即强制剔除该维度。 */
  exclude?: string[];
  note?: string;
}

/** 商机追踪器（opportunity_tracker.*）。 */
export interface OpportunityTracker {
  label?: string;
  priority?: "S" | "A" | "B";
  strong_triggers?: string[];
  triggers?: string[];
  /** 命中要求地域命中（geo tier1 词出现在文本中）。 */
  geo_lock?: boolean;
  geo_required?: boolean;
  /** 标题出现任一城市名则跳过该追踪器。 */
  exclude_if_in_title?: string[];
  action?: string;
  fields?: string[];
}

/** 风险追踪器（risk_tracker.*，B-1）：行长 5 分钟决策的"威胁"维度。 */
export interface RiskTracker {
  label?: string;
  /** 风险等级：S=重大（监管罚单/资本风险） A=重要（信用事件/政策收紧） B=关注（同业风险） */
  priority?: "S" | "A" | "B";
  /** 触发词：标题或正文命中任一即触发 */
  strong_triggers?: string[];
  triggers?: string[];
  /** 命中要求地域命中（geo tier1 词出现在文本中）。默认 false — 风险通常跨地域传播 */
  geo_lock?: boolean;
  /** 标题出现任一城市名则跳过 */
  exclude_if_in_title?: string[];
  /** 行动建议：行长听到后的"该让谁做什么" */
  action?: string;
  /** 需收集的字段（按部门排查时用） */
  fields?: string[];
}

/** sources.keywords.json 顶层结构。 */
export interface KeywordConfig {
  version?: number;
  note?: string;
  meta?: {
    markets?: string[];
    organization?: string;
    daily_flow_target?: string;
    opportunity_target?: string;
  };
  global_exclude?: Record<string, string[]>;
  geo_filter?: {
    tier1_exact?: string[];
    tier2_risky?: string[];
    weight?: { tier1_hit?: number; tier2_only?: number };
  };
  dimensions?: Record<string, DimensionRule>;
  opportunity_tracker?: Record<string, OpportunityTracker>;
  /** B-1：风险追踪器（关键词层风险识别，与 AI 层 risk 段双轨） */
  risk_tracker?: Record<string, RiskTracker>;
  filter_rules?: {
    matching_mode?: string;
    multi_dimension?: { enabled?: boolean; strategy?: string };
    deduplication?: { enabled?: boolean; rule?: string; threshold?: number; max_per_theme?: number };
    bucket_allocation?: Record<string, unknown>;
  };
  ml_enhancement?: Record<string, unknown>;
  changelog?: string[];
}

/** 漏斗输入：一条待判文章（来自归一化层，只读）。 */
export interface RawArticleInput {
  title: string;
  /** 正文/摘要（excerpt），weak 共现与商机匹配会用到。 */
  content?: string;
  sourceId: string;
  url?: string;
  /** 归一化 region 分流结果（gz / gd / …），当前过滤以文本地域判定为准，此字段仅透传。 */
  region?: string;
  /**
   * 文章分类（归一化层 category）。参考区（tech / ipo / gd-ipo / politics）
   * 不参与银行零售维度过滤（参考区是展示窗口，有独立 AI enrich），
   * 仅扫描商机追踪器；finance / gz 走完整漏斗。
   */
  category?: string;
  /** 源等级（T6 透传），供 bucket_allocation 分池参考。 */
  tier?: SourceTier;
}

export type FilterBucket = "daily" | "opportunity" | "weekly" | "dropped";

export interface FilterResult {
  /** 硬过滤：false 即丢弃，不进任何 AI 调用。 */
  pass: boolean;
  /** 综合权重分（geo + 维度 + 商机加分），供排序/复审参考。 */
  score: number;
  /** 命中的维度 key 列表（多维度，multi_dimension: all_hit）。 */
  dimensions: string[];
  /**
   * 命中的商机追踪器列表（多值：一条信息可进多个商机池）。
   * 按优先级 S > A > B 排序；无命中时为 undefined。
   */
  opportunities?: Array<{
    tracker: string;
    priority: "S" | "A" | "B";
    label: string;
    fields: string[];
    action: string;
  }>;
  /**
   * B-1：命中的风险追踪器列表（与 opportunities 并存 — 一条新闻可同时是商机和风险）。
   * 风险无 geo_lock 默认值（除部分显式开启）— 风险通常跨地域传播，本行需对照自查。
   */
  risks?: Array<{
    tracker: string;
    priority: "S" | "A" | "B";
    label: string;
    fields: string[];
    action: string;
  }>;
  /**
   * B-3：灰度命中（弱关键词命中但 cooccurrence 未匹配）。
   * 标记但不阻断 — AI 接收此标记后可在 prompt 中按"灰度"降级处理（少选 / 不选）。
   * 当前主战场在 L0 之后一律放行进 AI（2026-08-22 决策），gray 仅作信号、不 drop。
   */
  gray?: boolean;
  /** 命中的关键词/触发词（用于调试与测试断言）。 */
  matched: string[];
  bucket: FilterBucket;
}
