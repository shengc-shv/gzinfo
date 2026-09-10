/**
 * IPO 官方源共享工具（P2-3 架构理顺，2026-09-10 回检收尾）。
 *
 * 收敛前 `windowFloor` / `shortName` / `GD_CITIES` 都定义在 `szse-audit.ts` 内，
 * 被 `sse-audit.ts` / `bse-audit.ts` / `hk-filing.ts` **跨源 import** —— 深交所爬虫
 * 事实上成了「共享工具模块」，一旦该源被下架，其余三源会连带编译失败。
 * 现抽为独立模块，各源平等引用。
 */
import { IPO_SOURCE_WINDOW_DAYS } from "../../../ipo-config";

/** 广东城市词（regloc 仅到省时，借企业名兜底判定广东）。 */
export const GD_CITIES = [
  "广州", "深圳", "东莞", "佛山", "珠海", "中山", "惠州", "江门", "汕头",
  "湛江", "肇庆", "梅州", "汕尾", "河源", "阳江", "清远", "潮州", "揭阳", "云浮", "顺德",
];

/** 短名：剥企业组织形式后缀。 */
export function shortName(full: string): string {
  return String(full || "")
    .replace(/股份有限公司$/, "")
    .replace(/有限责任公司$/, "")
    .replace(/有限公司$/, "");
}

/**
 * 窗口下界（早停阈值）：今天 - days 天（近 N 天 = 日差 ≤ N）；
 * 若落在周六/周日则回退至最近工作日（三所审核只在交易日更新，避免截断周五更新）。
 * @param now 基准日（默认当前时间）；@param days 窗口天数（默认 IPO_SOURCE_WINDOW_DAYS）
 */
export function windowFloor(now: Date = new Date(), days: number = IPO_SOURCE_WINDOW_DAYS): string {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const d = new Date(now.getTime() - days * 24 * 3600 * 1000);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1); // 回退周末
  return fmt(d);
}
