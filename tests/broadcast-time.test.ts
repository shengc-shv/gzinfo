/**
 * 播报时刻（broadcastAt）与时间范围工具回归测试（2026-09-02 需求）。
 *
 * 需求：以 9:00 为界区分「客户演示数据」与「测试/验证数据」，支持按时间段
 * 查看 / 导出 / 清理。时间基准 = 报告页面生成时刻（播报与展示绑定、几乎同时）。
 *
 * 覆盖：
 *  1. format/parse 往返一致，输出带时区偏移（+08:00），非 UTC（Z）
 *  2. partitionByHour：9:00 整点为界（<9 演示 / >=9 测试），未知时刻独立分区
 *  3. inTimeRange / filterByTimeRange：闭区间，未知默认保留（includeUnknown）
 *  4. pruneByTimeRange：区间内删除、未知时刻保守保留（不误删）
 *  5. summarizeByHour 统计口径
 *  6. rememberBroadcast 集成：新播报自动记录 broadcastAt（≈ 当前时刻）
 *
 * 纯函数测试：构造数据，不依赖 data/ 真实记忆库。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  broadcastAtFromDateAndSeconds,
  broadcastHour,
  filterByTimeRange,
  formatBroadcastAt,
  inTimeRange,
  isTestBroadcastAt,
  parseBroadcastAt,
  partitionByHour,
  pruneByTimeRange,
  summarizeByHour,
} from "../lib/memory/broadcast-time";
import {
  beginDay,
  emptyMemory,
  rememberBroadcast,
  type BroadcastSample,
  type EventMemoryStore,
} from "../lib/memory/event-memory";

const TZ = "Asia/Shanghai";

/** 构造带 samples 的最小事件记录（类型层面满足 EventMemoryStore）。 */
function storeWithSamples(
  events: Array<{ id: string; samples: BroadcastSample[] }>,
  today?: { date: string; entries: BroadcastSample[] },
): EventMemoryStore {
  const ev: EventMemoryStore = emptyMemory();
  for (const e of events) {
    const rec = {
      id: e.id,
      samples: e.samples,
      anchors: [],
      topicTags: [],
      broadcastCount: 1,
      peakScore: 0,
      broadcastedTexts: [],
      broadcastedFacts: [],
      sections: [],
      anglesUsed: [],
      firstBroadcastAt: "2026-09-02",
      lastBroadcastAt: "2026-09-02",
    } as unknown as EventMemoryStore["events"][string];
    ev.events[e.id] = rec;
  }
  if (today) ev.today = { date: today.date, entries: today.entries };
  return ev;
}

const sample = (broadcastAt: string | undefined, title = "t"): BroadcastSample => ({
  date: "2026-09-02",
  section: "hero",
  title,
  ...(broadcastAt ? { broadcastAt } : {}),
});

test("formatBroadcastAt：输出带 +08:00 偏移的 ISO 8601，非 UTC（Z）", () => {
  const d = new Date("2026-09-02T15:39:47.000Z"); // = 北京 23:39:47
  const s = formatBroadcastAt(d, TZ);
  assert.match(s, /^2026-09-02T23:39:47\+08:00$/);
  // 往返一致：解析回同一时刻
  assert.equal(parseBroadcastAt(s), d.getTime());
  // 无时间戳 / 非法 → null
  assert.equal(parseBroadcastAt(undefined), null);
  assert.equal(parseBroadcastAt("not-a-date"), null);
});

test("broadcastAtFromDateAndSeconds：日期+当天秒数 → 正确时刻，秒数进位自动跨日", () => {
  assert.equal(
    broadcastAtFromDateAndSeconds("2026-09-02", 23 * 3600 + 39 * 60 + 47, TZ),
    "2026-09-02T23:39:47+08:00",
  );
  // 超过 24h 自动进位到下一天
  const next = broadcastAtFromDateAndSeconds("2026-09-02", 25 * 3600, TZ);
  assert.match(next, /^2026-09-03T01:00:00\+08:00$/);
});

test("partitionByHour：以 9:00 为界——<9 演示、>=9 测试、未知单独分区", () => {
  const store = storeWithSamples(
    [
      {
        id: "e1",
        samples: [
          sample("2026-09-02T08:00:00+08:00", "演示1"),
          sample("2026-09-02T08:59:59+08:00", "演示2"),
          sample("2026-09-02T09:00:00+08:00", "测试1"),
          sample("2026-09-02T12:00:00+08:00", "测试2"),
          sample(undefined, "未知时刻"),
        ],
      },
    ],
    { date: "2026-09-02", entries: [sample("2026-09-02T10:00:00+08:00", "today测试")] },
  );
  const p = partitionByHour(store, 9, TZ);
  const titles = (s: EventMemoryStore): string[] => [
    ...Object.values(s.events ?? {}).flatMap((r) => r.samples.map((x) => x.title)),
    ...(s.today?.entries ?? []).map((x) => x.title),
  ];
  assert.deepEqual(titles(p.before), ["演示1", "演示2"]);
  assert.deepEqual(titles(p.after), ["测试1", "测试2", "today测试"]);
  assert.deepEqual(titles(p.unknown), ["未知时刻"]);
});

test("filterByTimeRange：闭区间筛选；无时间戳默认保留、可显式排除", () => {
  const store = storeWithSamples([
    {
      id: "e1",
      samples: [
        sample("2026-09-02T08:30:00+08:00", "早"),
        sample("2026-09-02T12:00:00+08:00", "中"),
        sample("2026-09-02T18:00:00+08:00", "晚"),
        sample(undefined, "未知"),
      ],
    },
  ]);
  // 闭区间 [12:00, 12:00] 只含「中」
  const mid = filterByTimeRange(store, {
    from: "2026-09-02T12:00:00+08:00",
    to: "2026-09-02T12:00:00+08:00",
  });
  const midTitles = Object.values(mid.events ?? {})[0].samples.map((s) => s.title);
  assert.deepEqual(midTitles, ["中", "未知"]); // 未知默认保留
  // includeUnknown:false → 只剩「中」
  const strict = filterByTimeRange(
    store,
    { from: "2026-09-02T12:00:00+08:00", to: "2026-09-02T12:00:00+08:00" },
    { includeUnknown: false },
  );
  assert.deepEqual(
    Object.values(strict.events ?? {})[0].samples.map((s) => s.title),
    ["中"],
  );
  // 空区间（什么都不给）→ 全部保留
  const all = filterByTimeRange(store, {});
  assert.equal(Object.values(all.events ?? {})[0].samples.length, 4);
});

test("pruneByTimeRange：删除区间内留痕，无时间戳保守保留（不误删）", () => {
  const store = storeWithSamples([
    {
      id: "e1",
      samples: [
        sample("2026-09-02T08:30:00+08:00", "演示数据"),
        sample("2026-09-02T10:00:00+08:00", "测试数据"),
        sample(undefined, "未知"),
      ],
    },
  ]);
  const pruned = pruneByTimeRange(store, { from: "2026-09-02T09:00:00+08:00" });
  const kept = Object.values(pruned.events ?? {})[0].samples.map((s) => s.title);
  assert.deepEqual(kept, ["演示数据", "未知"]); // 测试数据被清，未知保留
  // 无 unknown 时全清 → 整条事件移除，不留空壳
  const noUnknown = storeWithSamples([
    {
      id: "e1",
      samples: [sample("2026-09-02T08:30:00+08:00", "演示数据"), sample("2026-09-02T10:00:00+08:00", "测试数据")],
    },
  ]);
  const allGone = pruneByTimeRange(noUnknown, { from: "2026-09-02T00:00:00+08:00" });
  assert.equal(Object.keys(allGone.events ?? {}).length, 0);
});

test("summarizeByHour：统计口径含 events.samples 与 today.entries", () => {
  const store = storeWithSamples(
    [
      {
        id: "e1",
        samples: [sample("2026-09-02T08:00:00+08:00"), sample("2026-09-02T10:00:00+08:00")],
      },
    ],
    { date: "2026-09-02", entries: [sample("2026-09-02T23:39:47+08:00")] },
  );
  const st = summarizeByHour(store, 9, TZ);
  assert.deepEqual(st, {
    before: { events: 1, samples: 1 },
    after: { events: 1, samples: 2 },
    unknown: { events: 0, samples: 0 },
  });
});

test("inTimeRange / broadcastHour：非法或缺失时刻不参与判定", () => {
  assert.equal(inTimeRange("2026-09-02T10:00:00+08:00", { from: "2026-09-02T09:00:00+08:00" }), true);
  assert.equal(inTimeRange("2026-09-02T08:00:00+08:00", { from: "2026-09-02T09:00:00+08:00" }), false);
  assert.equal(inTimeRange(undefined, { from: "2026-09-02T09:00:00+08:00" }), false);
  assert.equal(broadcastHour("2026-09-02T23:39:47+08:00", TZ), 23);
  assert.equal(broadcastHour(undefined, TZ), null);
});

test("isTestBroadcastAt：9:00 为界（>=9 测试）；无时间戳保守按正式（false）", () => {
  assert.equal(isTestBroadcastAt("2026-09-02T08:59:59+08:00", 9, TZ), false);
  assert.equal(isTestBroadcastAt("2026-09-02T09:00:00+08:00", 9, TZ), true);
  assert.equal(isTestBroadcastAt("2026-09-02T23:39:47+08:00", 9, TZ), true);
  assert.equal(isTestBroadcastAt("2026-09-02T06:41:21+08:00", 9, TZ), false);
  // 未知 / 非法 → 正式（保守参与去重，防重复播报）
  assert.equal(isTestBroadcastAt(undefined, 9, TZ), false);
  assert.equal(isTestBroadcastAt("not-a-date", 9, TZ), false);
});

test("beginDay 结算：无交付信号 → 昨天播报一律不结算（9:00 启发式已退役）", () => {
  // 2026-09-03 语义更新：微信推送改手动后，「是否真交付」以 deliveries 为准，
  // 时刻（9 点前后）不再判定正式性 —— 9 点前的 build 重试与 9 点后的人工补发
  // 都可能是正式版本。无交付记录 = 昨天从未被人工确认推送 → 一律不结算
  // （宁漏勿误：次日同源新闻允许重播，也不让没发出去的内容冷却掉真实发布）。
  // 本用例反向覆盖旧启发式的典型误判：9:00 前播报（旧逻辑必结算）若无交付仍不结算。
  const store: EventMemoryStore = {
    version: 1,
    updatedAt: "2026-09-02",
    events: {},
    today: {
      date: "2026-09-02",
      entries: [
        sample("2026-09-02T23:39:47+08:00", "测试播报A"), // 9 点后（旧：测试）
        sample("2026-09-02T08:00:00+08:00", "正式播报B"), // 9 点前（旧：正式）
        sample(undefined, "未知时刻C"), // 时刻未知（旧：保守按正式）
      ],
    },
  };
  const out = beginDay(store, "2026-09-03");
  assert.equal(
    Object.keys(out.events ?? {}).length,
    0,
    "无交付信号：A/B/C 一律不结算进长期记忆（不参与冷却）",
  );
  // 新一天暂存区已清空待写入
  assert.ok(out.today, "today 应存在");
  assert.equal(out.today!.date, "2026-09-03");
  assert.equal(out.today!.entries.length, 0);
});

test("rememberBroadcast 集成：新播报自动记录 broadcastAt（≈当前时刻）", () => {
  const store = emptyMemory();
  const out = rememberBroadcast(store, {
    cand: { title: "今日定调：六大行息差企稳" },
    section: "hero",
    date: "2026-09-02",
  });
  const entry = out.today?.entries[0];
  assert.ok(entry, "today.entries 应有新播报");
  const t = parseBroadcastAt(entry?.broadcastAt);
  assert.ok(t !== null, "broadcastAt 应被自动写入且可解析");
  // 与当前时刻相差应小于 5 分钟（自动记录 ≈ 播报时刻）
  assert.ok(Math.abs(t - Date.now()) < 5 * 60_000, `broadcastAt 应接近当前时刻，实际 ${entry?.broadcastAt}`);
  // 保留既有字段结构不变（date/section/title）
  assert.equal(entry.date, "2026-09-02");
  assert.equal(entry.section, "hero");
  assert.equal(entry.title, "今日定调：六大行息差企稳");
});
