/**
 * daily 主流程运行上下文类型（M2 重构，PR1 引入）。
 *
 * 设计原则：
 * - 显式优于隐式：所有运行期依赖（日志、源列表、缓存、模式）一次性打包为 ctx
 * - SKIP_AI 模式统一：ctx.mode 派发，避免散落在 main() 里的 if 分支
 * - 字段最小化：只放"跨阶段共享"的字段；阶段局部状态留在各阶段函数内
 *
 * 演进：
 * - PR1：仅类型 + ConsoleLogger 默认实现；main 仍以 console.log 为主
 * - PR4：mode.runner 类型补齐，模式差异由 ctx.mode 派发
 * - PR5：全面接管 console.log → ctx.log
 */

import type { SourceDef } from "../sources/types";
import type { SourceTier } from "../sources/tiers";
import type { HistoryStore } from "../output/history";
import type { AiAssetStore } from "../ai/assets";

export type Tier = SourceTier;

/** 每日运行模式：AI 正常 / 跳过 AI（复用缓存与 store） */
export type DailyMode =
  | { kind: "ai" }
  | {
      kind: "skip-ai";
      /** 摘要缓存：article-history.json + ai-assets 合并后的 url → summary */
      summaryCache: Map<string, string>;
      /** 相关性白名单：history 中 ai_relevant===true 的 url 集合（SKIP_AI 下挡非 L0 垃圾） */
      relevantUrls: Set<string>;
    };

/** 阶段日志接口（PR5 全面接管 console.log；PR1 仅供 bootstrap 与后续阶段使用）。 */
export interface Logger {
  info(stage: string, msg: string, meta?: Record<string, unknown>): void;
  warn(stage: string, msg: string, meta?: Record<string, unknown>): void;
  error(stage: string, msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Console logger 默认实现：与现有 console.log 格式对齐（`[prefix] [stage] msg`）。
 * PR1 阶段 main 内的 console.log 暂保留原文案以避免外部消费者受影响；
 * 本 logger 仅在 bootstrap 等新增位置使用。
 */
export class ConsoleLogger implements Logger {
  constructor(private readonly prefix: string = "[daily]") {}

  info(stage: string, msg: string, meta?: Record<string, unknown>): void {
    const tail = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    console.log(`${this.prefix} [${stage}] ${msg}${tail}`);
  }
  warn(stage: string, msg: string, meta?: Record<string, unknown>): void {
    const tail = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    console.warn(`${this.prefix} [${stage}] ${msg}${tail}`);
  }
  error(stage: string, msg: string, meta?: Record<string, unknown>): void {
    const tail = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    console.error(`${this.prefix} [${stage}] ${msg}${tail}`);
  }
}

/**
 * daily 主流程运行上下文。
 *
 * 由 bootstrap() 构造；主流程各阶段只读或更新 history/aiAssets 字段。
 * 单次运行实例，不跨日复用。
 */
export interface DailyContext {
  /** 运行启动时间（用于阶段耗时统计，PR5 接 log）。 */
  startTime: Date;
  /** todayKey() 结果，TZ 感知。 */
  date: string;
  /** 模式：AI / 跳过 AI。 */
  mode: DailyMode;
  /** 当前 locale 下的源注册表（已 locale 过滤）。 */
  sources: SourceDef[];
  /** sourceId → tier 索引，一次构建、多处复用（main 中曾重复构建两次）。 */
  tierBySource: Map<string, Tier>;
  /** L1 缓存：30 天滚动 + AI 摘要复用。 */
  history: HistoryStore;
  /** L2 账本：append-only，付费 AI 产物永不丢。 */
  aiAssets: AiAssetStore;
  /** 阶段日志器。 */
  log: Logger;
}
