/**
 * 过滤管线类型定义（PR3）。
 *
 * 设计原则：
 * - 每个 stage 是纯函数：(articles, ctx) => articles
 * - 不 mutate 入参 articles（返回新数组或同数组）
 * - 阶段顺序由 stages.ts 声明；调换顺序 = 改 1 行
 * - 阶段可被 `enabled` 旁路（环境变量控制）
 * - 阶段日志通过 ctx.log 统一（PR5 全面接管 console.log；本 PR 阶段 console.log 仍保留以维持输出格式）
 */

import type { ArticleInput } from "../../types";
import type { HistoryStore } from "../../output/history";
import type { Tier, Logger } from "../context";

/** 过滤阶段共享上下文（不可变快照）。 */
export interface FilterContext {
  /** 运行日期（todayKey）。 */
  date: string;
  /** sourceId → tier 索引（来自 ctx.tierBySource）。 */
  tierBySource: Map<string, Tier>;
  /** L1 history 缓存（来自 ctx.history）；供 cross-day-dedup 使用。 */
  history: HistoryStore;
  /** 全部 sourceId 集合；供 per-source cap 使用。 */
  allSourceIds: Set<string>;
  /** 阶段日志。 */
  log: Logger;
}

/** 过滤阶段接口。 */
export interface FilterStage {
  /** 阶段名（用于日志与 dry-run 报告）。 */
  name: string;
  /** 条件：返回 false 时跳过该 stage（保留原数组、不打日志）。 */
  enabled?(ctx: FilterContext): boolean;
  /** 实际过滤逻辑：纯函数，返回新数组。 */
  apply(articles: ArticleInput[], ctx: FilterContext): ArticleInput[];
}
