/**
 * AI 开关层（M3-F）：SKIP_AI 的唯一读取点。
 *
 * 语义：SKIP_AI=true 时跳过所有 LLM 调用（凭证校验/分类/摘要富集/执行摘要/
 * 交易点评），仅复用历史缓存与 ai-assets 中的 AI 产物渲染报告。供 test2.yml
 * 做「不重新触发 AI、基于已有 AI 历史重新生成并推送报告」的失败恢复流程。
 * 默认关闭，不影响正常 daily 流程。
 *
 * 各阶段可通过 shouldSkip(stage) 语义化判断；stage 维度同时被 M2-③ 的
 * AI 调用埋点复用（backend/stage/ok/ms）。
 */
export type AiStage =
  | "enrich" // 富集摘要（GitHub/X/论文/finance/politics/gd-ipo）
  | "classify" // 条目级 LLM 分类
  | "executive" // 执行摘要
  | "stock-recap" // 股市解读三卡（昨日股市复盘）
  | "trading" // 交易点评
  | "credentials" // 启动凭证校验
  | "pass1" // 两阶段管线：PASS1 筛选分类
  | "pass2" // 两阶段管线：PASS2 总编辑成稿
  | "other";

/** AI 是否启用（SKIP_AI !== "true"）。 */
export function aiEnabled(): boolean {
  return process.env.SKIP_AI !== "true";
}

/** 该阶段是否应跳过（SKIP_AI 模式下全部跳过）。 */
export function shouldSkip(_stage: AiStage): boolean {
  return !aiEnabled();
}

/** 与 SKIP_AI 同义（兼容旧引用，行为不变）。 */
export const SKIP_AI_FLAG: boolean = !aiEnabled();
