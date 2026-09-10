/**
 * IPO 窗口常量——**全链路唯一来源**（P2-3 收敛，2026-09-10 回检收尾）。
 *
 * 收敛前散落 4 处、且语义重复：
 *   - `IPO_VOICE_WINDOW_DAYS` 重复定义于 `pipeline/side-outputs/gd-ipo.ts` 与 `memory/event-memory.ts`
 *     （改一处不生效 → 真隐患）；
 *   - `IPO_SOURCE_WINDOW_DAYS` 定义在 `sources/crawlers/sources/szse-audit.ts`，却被
 *     `hk-filing.ts` 跨模块 import（sse/bse 亦从该文件取 windowFloor）；
 *   - `CSRC_WINDOW_DAYS` 私有于 `csrcfd.ts`，值同为 7。
 *
 * 本文件零 import（纯数据），可被 lib/ 任意层引用而不引入循环依赖。
 *
 * 口径（用户 2026-09-10 拍板）：**日差 ≤ N**（今天-N ~ 今天），不是「含今天共 N 个日历日」。
 * 实锤：上交所主板「广东龙行天下」（updateDate 09-03，相对 09-10 日差恰为 7）必须在列表内。
 */

/** 口播 + 今日必读横滑窗口（天，日差 ≤ N）：只播最新动向。 */
export const IPO_VOICE_WINDOW_DAYS = 2;

/** 底部「广东IPO动态」完整列表窗口（天）：与源层抓取窗对齐，保证列表不被压成 1 天量。 */
export const IPO_LIST_WINDOW_DAYS = 7;

/** 源层抓取窗口（天）：三所审核动态 / 证监会辅导 / 港交所递表的统一回溯下限。 */
export const IPO_SOURCE_WINDOW_DAYS = 7;
