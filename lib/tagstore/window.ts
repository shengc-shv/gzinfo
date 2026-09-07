/**
 * 时间窗口与跨天边界。
 *
 * 统一口径：所有窗口边界都在 REPORT_TZ（默认 Asia/Shanghai）的**本地自然日**上切分，
 * 避免 UTC 与北京时间的日期错位（项目曾因 TZ 未展开导致定时路径从未发布）。
 *
 * 约定（days=2，即「近两天」）：
 *   报告日 T 的窗口 = [T-1 00:00 本地, T+1 00:00 本地)
 *   即覆盖 T-1 全天 + T 当天已发布的部分。
 *
 * 跨天逻辑（**不依赖固定触发钟点**）：
 *   - 预分析：T-1 任意时刻触发，抓到 T-1 已发布的条目 → 打标写入 store（不做窗口过滤）
 *   - 正式运行：T 任意时刻触发，抓到 T-1 + T 的条目 → 已入库的命中 store（零 LLM），
 *     仅「上次预分析之后新增」的条目走 LLM
 *   - 阶段由 `PIPELINE_PHASE`（pre / formal）**显式指定**，绝不从当前钟点推断
 *     —— 用户可能在 19:00 跑预分析，也可能 08:10 跑正式，钟点不可作为判据。
 *   - 同一阶段一天内可多次触发，结果幂等（守卫式写入 + URL/标题双主键）。
 */

/** 报告时区：与线上 REPORT_TZ 一致，禁止用单引号包裹（历史 bug）。 */
export const REPORT_TZ = process.env.REPORT_TZ?.trim() || "Asia/Shanghai";

const pad = (n: number) => String(n).padStart(2, "0");

/** 取某个 UTC 时刻在 REPORT_TZ 下的本地日期（YYYY-MM-DD）。 */
export function dateInTz(ms: number, tz: string = REPORT_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "01";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 现在在 REPORT_TZ 下的本地日期。 */
export function todayInTz(tz: string = REPORT_TZ): string {
  return dateInTz(Date.now(), tz);
}

/** 求某 UTC 时刻所在时区的偏移（毫秒）。 */
function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const hour = get("hour") === 24 ? 0 : get("hour");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return asUtc - ms;
}

/** 本地自然日 00:00 对应的 UTC 毫秒（含 DST 二次校正）。 */
export function localMidnightMs(ymd: string, tz: string = REPORT_TZ): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0);
  const off = tzOffsetMs(guess, tz);
  const ts = guess - off;
  // DST 边界下偏移可能变化，用校正后的时刻重算一次
  const off2 = tzOffsetMs(ts, tz);
  return off2 === off ? ts : guess - off2;
}

/** 本地日期加减天数（返回 YYYY-MM-DD）。 */
export function addDays(ymd: string, n: number, tz: string = REPORT_TZ): string {
  const ms = localMidnightMs(ymd, tz) + n * 86_400_000;
  return dateInTz(ms, tz);
}

export interface WindowBounds {
  /** 含下界（ISO，本地 00:00）。 */
  from: string;
  /** 不含上界（ISO，本地 00:00）。 */
  to: string;
  /** 窗口覆盖的本地日期列表（旧→新）。 */
  days: string[];
}

/**
 * 计算报告日的窗口边界。
 * @param reportDate 报告日 YYYY-MM-DD
 * @param days 窗口天数（2 = 昨天 + 今天）
 */
export function windowBounds(
  reportDate: string,
  days = 2,
  tz: string = REPORT_TZ,
): WindowBounds {
  const span = Math.max(1, Math.floor(days));
  const fromYmd = addDays(reportDate, -(span - 1), tz);
  const toYmd = addDays(reportDate, 1, tz);
  const dayList: string[] = [];
  for (let i = 0; i < span; i++) dayList.push(addDays(fromYmd, i, tz));
  return {
    from: new Date(localMidnightMs(fromYmd, tz)).toISOString(),
    to: new Date(localMidnightMs(toYmd, tz)).toISOString(),
    days: dayList,
  };
}

/** 判断 ISO 时间是否落在窗口内（半开区间 [from, to)）。 */
export function inWindow(iso: string | undefined, w: WindowBounds): boolean {
  if (!iso) return false; // 时间真实性红线：无发布时间不进窗口
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const from = Date.parse(w.from);
  const to = Date.parse(w.to);
  return t >= from && t < to;
}

/**
 * 记录是否已过期（超出保留期）。
 * 保留期 = 窗口天数 + 缓冲 1 天，避免边界抖动导致刚出窗口又被清理。
 */
export function isExpired(iso: string | undefined, nowMs: number, retainDays = 3): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return nowMs - t > retainDays * 86_400_000;
}
