/**
 * 播报时刻（broadcastAt）与时间范围工具。
 *
 * 背景（2026-09-02 需求）：每条记忆需要记录「被播报的具体时刻」，以便
 *  - 以 9:00 为界区分**客户演示数据**与**测试/验证数据**；
 *  - 按时间段分别查看、导出或清理某一批记忆。
 *
 * 时间基准的说明：播报与展示是绑定的、几乎同时产生的，因此**报告页面的
 * 生成时刻**即可作为该批播报的时刻基准——无需额外分析播报内部生成时间。
 * 回填历史记录时以对应报告的生成时间为基准（见 scripts/backfill-broadcast-at.ts）。
 *
 * 设计原则：
 *  1. `broadcastAt` 是**可选**字段，缺失不影响任何既有读取逻辑（向后兼容）；
 *  2. 所有筛选/清理函数返回**新 store**，不修改入参；
 *  3. 时刻未知的记录在「清理」时一律保留（保守：宁可多留，不误删）。
 *
 * 依赖方向：本文件只 `import type` 自 event-memory（编译期），避免运行时循环依赖。
 */

import type {
  BroadcastSample,
  EventMemoryStore,
  EventRecord,
} from "./event-memory";

/** 记忆时间戳所用时区（MEMORY_TZ 优先，其次 REPORT_TZ，兜底北京时间）。 */
export function memoryTimeZone(): string {
  return process.env.MEMORY_TZ || process.env.REPORT_TZ || "Asia/Shanghai";
}

/** 某时刻在指定时区的「墙上时间」各部分（自动处理夏令时）。 */
function tzParts(
  d: Date,
  tz: string,
): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(d)) {
    if (x.type !== "literal") p[x.type] = x.value;
  }
  const pad2 = (v: string | undefined): number => Number(v ?? "0");
  return {
    y: pad2(p.year),
    mo: pad2(p.month),
    d: pad2(p.day),
    h: pad2(p.hour) % 24, // Intl 在午夜可能返回 24
    mi: pad2(p.minute),
    s: pad2(p.second),
  };
}

/** 指定时区相对 UTC 的偏移分钟数（东八区为 +480）。 */
export function tzOffsetMinutes(d: Date, tz: string = memoryTimeZone()): number {
  const p = tzParts(d, tz);
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUTC - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * 生成 ISO 8601 带时区偏移的播报时刻，如 `2026-09-02T23:39:47+08:00`。
 *
 * 刻意不用 `toISOString()`：它输出 UTC（`Z` 结尾），会丢失本地时刻语义，
 * 无法据此判断「是不是 9 点前播的」。
 */
export function formatBroadcastAt(
  d: Date = new Date(),
  tz: string = memoryTimeZone(),
): string {
  const p = tzParts(d, tz);
  const off = tzOffsetMinutes(d, tz);
  const abs = Math.abs(off);
  return (
    `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}` +
    `${off >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 由「日期 + 当天秒数」构造播报时刻（回填用，秒数超出 24h 自动进位）。 */
export function broadcastAtFromDateAndSeconds(date: string, secondsOfDay: number, tz: string = memoryTimeZone()): string {
  // 用 UTC 正午作为锚点求偏移，避免夏令时切换日的歧义
  const anchor = new Date(`${date}T12:00:00Z`);
  const off = tzOffsetMinutes(anchor, tz);
  const ms = Date.parse(`${date}T00:00:00Z`) + secondsOfDay * 1000 - off * 60_000;
  return formatBroadcastAt(new Date(ms), tz);
}

/** 解析播报时刻为毫秒时间戳；缺失或非法返回 null。 */
export function parseBroadcastAt(iso: string | undefined | null): number | null {
  if (!iso || typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** 取播报时刻在指定时区的小时（0-23）；无时间戳返回 null。 */
export function broadcastHour(
  iso: string | undefined,
  tz: string = memoryTimeZone(),
): number | null {
  const t = parseBroadcastAt(iso);
  if (t === null) return null;
  return tzParts(new Date(t), tz).h;
}

/** 时间区间（闭区间，ISO 8601 字符串；缺省端表示不限）。 */
export interface TimeRange {
  from?: string;
  to?: string;
}

/** 判断某播报时刻是否落在区间内；无时间戳返回 false（不参与筛选）。 */
export function inTimeRange(iso: string | undefined, r: TimeRange): boolean {
  const t = parseBroadcastAt(iso);
  if (t === null) return false;
  if (r.from) {
    const f = parseBroadcastAt(r.from);
    if (f !== null && t < f) return false;
  }
  if (r.to) {
    const e = parseBroadcastAt(r.to);
    if (e !== null && t > e) return false;
  }
  return true;
}

/** 记录结构是否可用于时间筛选（轻量校验，避免依赖 event-memory 的运行时导出）。 */
function hasSamples(rec: unknown): rec is EventRecord {
  return !!rec && typeof rec === "object" && Array.isArray((rec as EventRecord).samples);
}

/**
 * 按谓词过滤每一条播报留痕（samples 与 today.entries 同时处理）。
 *
 * 事件级只保留命中的 samples；若某事件所有留痕都被滤除，则整条事件移除，
 * 避免残留「空壳事件」污染匹配。
 */
function filterSamples(
  store: EventMemoryStore,
  keep: (s: BroadcastSample) => boolean,
): EventMemoryStore {
  const events: Record<string, EventRecord> = {};
  for (const [id, rec] of Object.entries(store.events ?? {})) {
    if (!hasSamples(rec)) continue; // 损坏记录跳过
    const samples = rec.samples.filter((s) => s && keep(s));
    if (samples.length === 0) continue;
    events[id] = { ...rec, samples };
  }
  const out: EventMemoryStore = { version: 1, updatedAt: store.updatedAt, events };
  if (store.today) {
    out.today = { date: store.today.date, entries: store.today.entries.filter((s) => s && keep(s)) };
  }
  return out;
}

/**
 * 按播报时刻区间**筛选**记忆（返回新 store，不改入参）。
 *
 * @param opts.includeUnknown 无时间戳的记录是否保留（默认 true，保守不丢数据）。
 */
export function filterByTimeRange(
  store: EventMemoryStore,
  range: TimeRange,
  opts: { includeUnknown?: boolean } = {},
): EventMemoryStore {
  const includeUnknown = opts.includeUnknown ?? true;
  return filterSamples(store, (s) => {
    if (parseBroadcastAt(s.broadcastAt) === null) return includeUnknown;
    return inTimeRange(s.broadcastAt, range);
  });
}

/**
 * 按播报时刻区间**清理**记忆（删除区间内的留痕，返回新 store）。
 *
 * 无时间戳的记录**不会被删除**——宁可多留，也不误删无法归类的记忆。
 */
export function pruneByTimeRange(store: EventMemoryStore, range: TimeRange): EventMemoryStore {
  return filterSamples(store, (s) => {
    if (parseBroadcastAt(s.broadcastAt) === null) return true;
    return !inTimeRange(s.broadcastAt, range);
  });
}

/** 以「当天某小时」为界的三组划分结果。 */
export interface MemoryPartition {
  /** 演示/正式数据：播报时刻 < cutoffHour。 */
  before: EventMemoryStore;
  /** 测试/验证数据：播报时刻 >= cutoffHour。 */
  after: EventMemoryStore;
  /** 时刻未知（无 broadcastAt）的记录。 */
  unknown: EventMemoryStore;
}

/**
 * 以当天指定小时（默认 9:00，北京时间）为界划分记忆。
 *
 * 用途：区分「9 点前客户演示时产生的记忆」与「9 点后测试重跑产生的记忆」，
 * 便于分别查看、导出或清理。
 */
export function partitionByHour(
  store: EventMemoryStore,
  cutoffHour: number = 9,
  tz: string = memoryTimeZone(),
): MemoryPartition {
  const bucketOf = (s: BroadcastSample): keyof MemoryPartition => {
    const h = broadcastHour(s.broadcastAt, tz);
    if (h === null) return "unknown";
    return h < cutoffHour ? "before" : "after";
  };
  return {
    before: filterSamples(store, (s) => bucketOf(s) === "before"),
    after: filterSamples(store, (s) => bucketOf(s) === "after"),
    unknown: filterSamples(store, (s) => bucketOf(s) === "unknown"),
  };
}

/** 分区统计摘要（便于快速查看与决策）。 */
export interface MemoryTimeStats {
  before: { events: number; samples: number };
  after: { events: number; samples: number };
  unknown: { events: number; samples: number };
}

/** 统计各分区的事件数与留痕数。 */
export function summarizeByHour(
  store: EventMemoryStore,
  cutoffHour: number = 9,
  tz: string = memoryTimeZone(),
): MemoryTimeStats {
  const p = partitionByHour(store, cutoffHour, tz);
  const stat = (s: EventMemoryStore): { events: number; samples: number } => ({
    events: Object.keys(s.events ?? {}).length,
    samples:
      Object.values(s.events ?? {}).reduce((n, r) => n + (r.samples?.length ?? 0), 0) +
      (s.today?.entries.length ?? 0),
  });
  return { before: stat(p.before), after: stat(p.after), unknown: stat(p.unknown) };
}

/** 列出全部播报留痕及其时刻（按时间升序，便于导出与人工核对）。 */
export function listBroadcasts(
  store: EventMemoryStore,
  tz: string = memoryTimeZone(),
): Array<{ eventId: string; title: string; broadcastAt?: string; hour: number | null; section: string }> {
  const rows: Array<{ eventId: string; title: string; broadcastAt?: string; hour: number | null; section: string }> = [];
  for (const [id, rec] of Object.entries(store.events ?? {})) {
    if (!hasSamples(rec)) continue;
    for (const s of rec.samples) {
      rows.push({
        eventId: id,
        title: s.title,
        ...(s.broadcastAt ? { broadcastAt: s.broadcastAt } : {}),
        hour: broadcastHour(s.broadcastAt, tz),
        section: s.section,
      });
    }
  }
  for (const s of store.today?.entries ?? []) {
    rows.push({
      eventId: "(today)",
      title: s.title,
      ...(s.broadcastAt ? { broadcastAt: s.broadcastAt } : {}),
      hour: broadcastHour(s.broadcastAt, tz),
      section: s.section,
    });
  }
  rows.sort((a, b) => {
    const ta = parseBroadcastAt(a.broadcastAt);
    const tb = parseBroadcastAt(b.broadcastAt);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1; // 未知时刻排最后
    if (tb === null) return -1;
    return ta - tb;
  });
  return rows;
}
