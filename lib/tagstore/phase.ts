/**
 * 阶段与报告日判定。
 *
 * ⚠️ 用户明确澄清：20:00 / 08:00 只是举例，**实际触发时刻不固定**（可能 19:00，
 * 也可能 08:10）。因此：
 * - 阶段**只能**由 `PIPELINE_PHASE` 环境变量显式指定，**禁止**从当前钟点推断；
 * - 窗口只按报告日的本地自然日切分，与触发时刻无关；
 * - 同一天重复触发同一阶段，结果必须幂等。
 */

import { todayInTz } from "./window";

export type Phase = "pre" | "formal";

/**
 * 当前阶段。缺省 formal（保持既有生产行为，避免误开预分析路径）。
 * 取值：pre（晚间预分析）/ formal（次日正式运行）。
 */
export function currentPhase(): Phase {
  const v = process.env.PIPELINE_PHASE?.trim().toLowerCase();
  return v === "pre" ? "pre" : "formal";
}

/**
 * 报告日（YYYY-MM-DD，REPORT_TZ 本地日）。
 * 可用 `REPORT_DATE=2026-09-08` 显式指定（测试 / 补跑用）；缺省取当前本地日。
 */
export function reportDate(): string {
  const v = process.env.REPORT_DATE?.trim();
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return todayInTz();
}

/** 窗口天数（默认 2 = 近两天）。 */
export function windowDays(): number {
  const n = Number(process.env.TAG_WINDOW_DAYS?.trim() ?? "2");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}
