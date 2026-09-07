/**
 * 新闻标签仓库（Tag Store）—— 跨天复用的 AI 打标缓存。
 *
 * 存在的理由：生产管线每天对「进管线的条目」全量调用 LLM（PASS1 分类 + PASS2 成稿）。
 * 而 T-1 20:00 的预分析已经对当天条目打过标，T 08:00 正式运行时这批条目再次进管线
 * → 重复烧钱。Tag Store 把「条目 → AI 判定」固化成可跨天复用的资产，正式运行只对新
 * 增条目调 LLM。
 *
 * 设计红线（与项目既有红线一致）：
 * - **时间真实性**：无真实发布时间（publishedAt 缺失）的条目一律不入库，不用抓取日兜底。
 * - **无状态源**：入库记录不携带源分类作为最终归属；section/locale 由内容判定产生。
 * - **只增不改**：既有字段不允许被覆盖为更差的值（守卫式写入），条目只可新增/补齐。
 * - **历史库互不干涉**：本仓库独立落盘 data/tag-store.json，不改写 article-history.json。
 */

import type { ReportSectionKey, Locale } from "../types";

/** 打标者：决定记录的信任等级与是否可被覆盖。 */
export type Tagger = "workbuddy" | "llm" | "pipeline";

/**
 * 信任等级（数字越大越权威）：pipeline（生产 LLM 成稿）> llm（生产/预分析 LLM）
 * > workbuddy（离线分析）。用于守卫式写入——低信任记录不得覆盖高信任记录。
 */
export const TAGGER_RANK: Record<Tagger, number> = {
  workbuddy: 1,
  llm: 2,
  pipeline: 3,
};

/** 打标 schema 版本：判定口径变更时递增，旧版本记录自动失效重打。 */
export const TAG_SCHEMA = 1;

/** 单条新闻的 AI 标签记录。 */
export interface TagRecord {
  /** 主键：规范化 URL 的 sha1 前 16 位。 */
  id: string;
  /** 规范化后的 URL（去 utm / 锚点 / 尾斜杠 / 协议差异）。 */
  url: string;
  /** 原始 URL（用于渲染外链，保持用户看到的样子）。 */
  rawUrl: string;
  /** 标题指纹：归一化标题的 sha1 前 12 位，URL 漂移时的兜底主键。 */
  titleFp: string;
  /** 内容指纹：标题 + 摘要前 80 字，跨源同事件合并的判据。 */
  contentFp: string;
  title: string;
  sourceId?: string;
  source?: string;
  /** 真实发布时间（ISO）。**缺失则整条不入库**——时间真实性红线。 */
  publishedAt: string;
  /** 首次进入 store 的时间（ISO）。 */
  firstSeenAt: string;
  /** 最近一次有效打标时间（ISO）。 */
  taggedAt: string;
  /** 打标者。 */
  tagger: Tagger;
  /** 打标 schema 版本。 */
  schema: number;
  /** 是否有新闻价值（对应历史库的 ai_relevant）。 */
  aiRelevant: boolean;
  /** 银行零售视角解读（对应历史库的 summary）。 */
  summary?: string;
  /** 板块归属（内容判定结果，非源分类）。 */
  section?: ReportSectionKey;
  /** 地域归属（内容判定结果）。 */
  locale?: Locale;
  /** 主题标签。 */
  tags?: string[];
  /** 重要度（1/2/3）。 */
  importance?: 1 | 2 | 3;
  /** 命中业务线（客群 / 财富 / 私人银行 / 信贷）。 */
  businessLines?: string[];
  /** 命中过几次（保留字段，不累加以保证幂等）。 */
  hits?: number;
  /**
   * 单独保留期（天）：IPO 等在过滤层有 7 天窗口豁免的长周期条目需放宽，
   * 否则会被默认 3 天保留期误清（2026-09-07 实跑发现）。缺省用全局 3 天。
   */
  retainDays?: number;
}

/** 落盘结构。 */
export interface TagStoreFile {
  /** 文件结构版本。 */
  version: 1;
  /** 当前生效的打标 schema。 */
  schema: number;
  updatedAt: string;
  /** 最近一次覆盖的窗口 [from, to)（ISO），用于可观测性。 */
  window?: { from: string; to: string };
  /** id → 记录。 */
  records: Record<string, TagRecord>;
  /** titleFp → id，URL 变化时的二次匹配索引。 */
  titleIndex: Record<string, string>;
}

/** 空 store（首次运行 / 文件损坏时返回）。 */
export function emptyStore(): TagStoreFile {
  return {
    version: 1,
    schema: TAG_SCHEMA,
    updatedAt: new Date().toISOString(),
    records: {},
    titleIndex: {},
  };
}

/** 业务线枚举（与项目业务相关性红线一致）。 */
export const BUSINESS_LINES = ["客群", "财富", "私人银行", "信贷"] as const;
export type BusinessLine = (typeof BUSINESS_LINES)[number];
