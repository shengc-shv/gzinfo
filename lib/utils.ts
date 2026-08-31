/**
 * Resolve the timezone used for date-keyed filenames AND for date strings
 * rendered in HTML. Defaults to the system local timezone — set
 * `REPORT_TZ` (any IANA name, e.g. "America/Los_Angeles", "Europe/Berlin",
 * "Asia/Shanghai", or "UTC") to override.
 *
 * Lazy on purpose: `scripts/daily.ts` loads `.env.local` AFTER its
 * imports execute, so capturing the value at module init would freeze it
 * before dotenv has run. Each call site reads `process.env` fresh.
 */
export function getReportTz(): string | undefined {
  return process.env.REPORT_TZ?.trim() || undefined;
}

export function todayKey(d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: getReportTz(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

/**
 * 日历日窗口判定（2026-08-31 修复「29号信息混入31号报告」根因）。
 * 条目的发布日期在报告时区(REPORT_TZ)下 ∈ {今天, 今天-1, ……, 今天-(days-1)}
 * 即在窗口内。替代原 48h 滑动窗口（Date.now()-days*86400000），后者在早间 run
 * 会把「前天」条目（如 31号早跑时 29号发布的条目距当时仅 1.3–2 天）误判为有效，
 * 导致 29号信息混入 31号报告。用户 2026-08-29 明确漏斗三=今天新增+昨天有效
 * （days=2 → 今天+昨天）。
 * 无 publishedAt（时间红线）→ 返回 false。
 */
export function isWithinCalendarDays(
  publishedAt: Date | string | undefined,
  days: number,
  now: Date = new Date(),
): boolean {
  if (!publishedAt) return false; // 时间红线：无真实发布时间 → 不在窗口
  const t =
    typeof publishedAt === "string"
      ? new Date(publishedAt).getTime()
      : publishedAt.getTime();
  if (Number.isNaN(t)) return false;
  const allowed = new Set<string>();
  let cursor = now.getTime();
  for (let i = 0; i < days; i++) {
    allowed.add(todayKey(new Date(cursor)));
    cursor -= 86_400_000; // 减 24h（报告时区无夏令时，日期键正确递减）
  }
  return allowed.has(todayKey(new Date(t)));
}

/**
 * 从 URL 路径提取发布日期（YYYY-MM-DD）。支持 20260820 / 2026-08-20 / 2026/08/20
 * 等常见日期形态；无日期或非法日期返回 undefined（2026-08-20 由 merge.ts 迁入，供
 * dispatch 直抓源与爬虫源统一兜底——sina-money/21jingji 等首页列表无内联日期，但
 * 文章 URL 含日期，可借此补齐 publishedAt）。
 */
export function extractDateFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/(\d{4})[-/]?(\d{1,2})[-/]?(\d{1,2})/);
  if (!m) return undefined;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
