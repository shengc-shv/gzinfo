/**
 * IPO 源「新鲜度哨兵」共享实现（2026-09-10 回检 P0-3）。
 *
 * 背景：IPO 各源都是「接口抓取成功 ≠ 数据新鲜」——北交所实测过 `pageSize` 漏传导致
 * 静默命中陈旧分桶、滞后 13 天无人察觉（2026-09-10 实锤）。此前只有 bse-audit 自带
 * 哨兵，其余 5 源（sse/szse/csrcfd/hk-filing/listed-check）静默变旧时**没有任何信号**，
 * CI 日志一律显示「完成，共 N 条」。
 *
 * 本模块把哨兵抽成公共实现，各源在 `run()` 末尾用「本次抓到的全部日期」调用
 * `warnIfStale(源名, dates)`：最新日期滞后今天超过阈值即打 `::warning::`，
 * 让 GitHub Actions 在日志与注解里都一眼可见（区分「源真没动态」与「源坏了」）。
 */

import { BaseCrawler } from "../base-crawler";

/** 新鲜度阈值（天）：最新数据滞后今天超过该值即告警。 */
export const STALE_LAG_DAYS = 3;

/** 本地日期串 YYYY-MM-DD（与 szse-audit.windowFloor 同一时区口径，供哨兵比对）。 */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 两个 YYYY-MM-DD 的自然日差（b - a，天）。 */
export function dayGap(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00`) - Date.parse(`${a}T00:00:00`)) / 86400000);
}

/**
 * 新鲜度检查：`dates` 为本次抓到的全部真实日期（YYYY-MM-DD，含被窗口过滤掉的）。
 * - 0 条日期 → 告警（接口改版/分桶异常/被反爬，都会表现成「抓成功但没数据」）；
 * - 最新日期滞后 > lagDays → 告警（数据老旧，大概率上游行为变化）。
 * 返回是否告警，便于单测断言。
 */
export function checkStale(
  name: string,
  dates: string[],
  opts: { lagDays?: number } = {},
): boolean {
  const lagDays = opts.lagDays ?? STALE_LAG_DAYS;
  if (dates.length === 0) {
    console.warn(`::warning:: [${name}] ⚠️ 新鲜度告警：本次 0 条有效日期，接口或分桶可能异常`);
    return true;
  }
  const newest = dates.reduce((a, b) => (b > a ? b : a));
  const lag = dayGap(newest, localDay());
  if (lag > lagDays) {
    console.warn(
      `::warning:: [${name}] ⚠️ 新鲜度告警：最新日期 ${newest} 滞后 ${lag} 天（阈值 ${lagDays}），` +
        `数据可能已变旧，请核查接口行为`,
    );
    return true;
  }
  return false;
}

/** 便捷入口：给 BaseCrawler 子类在 run() 末尾调用（源名取 crawler.name）。 */
export function warnIfStale(crawler: BaseCrawler, dates: string[], lagDays?: number): boolean {
  return checkStale(crawler.name, dates, { lagDays });
}
