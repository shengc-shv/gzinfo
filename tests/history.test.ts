/**
 * article-history（lib/output/history.ts）边界测试：
 * 7 天窗口边界 / 空数组 / 重复 URL / 时间字段优先级 / buildRolling 行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pruneHistory,
  buildRolling,
  type HistoryEntry,
  type HistoryStore,
} from "../lib/output/history";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function mk(url: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    title: url,
    url,
    sourceId: "test-src",
    source: "测试源",
    category: "finance",
    firstSeenAt: iso(Date.now()),
    lastSeenAt: iso(Date.now()),
    ...over,
  };
}

test("pruneHistory: 抓取窗口边界——窗口内保留、窗口外剔除", () => {
  const now = Date.now();
  const store: HistoryStore = {
    fresh: mk("fresh", { publishedAt: iso(now - 1 * DAY) }), // 1天 → 保留
    boundary: mk("boundary", { publishedAt: iso(now - 1 * DAY) }), // 昨天（日历窗口内 今天+昨天）→ 保留
    stale: mk("stale", { publishedAt: iso(now - 3 * DAY) }), // 3天 → 剔除
  };
  const out = pruneHistory(store);
  assert.ok(out.fresh, "1天前应保留");
  assert.ok(out.boundary, "昨天(日历窗口内)应保留");
  assert.ok(!out.stale, "3天前应剔除");
});

test("pruneHistory: 无 publishedAt 直接剔除（时间红线，不回退 lastSeenAt）", () => {
  const now = Date.now();
  const out = pruneHistory({
    "seen-recent": mk("seen-recent", {
      publishedAt: undefined,
      lastSeenAt: iso(now - 1 * DAY),
    }),
    "seen-old": mk("seen-old", {
      publishedAt: undefined,
      lastSeenAt: iso(now - 10 * DAY),
    }),
  });
  assert.deepEqual(out, {}, "无 publishedAt 不论 lastSeenAt 新旧均剔除");
});

test("pruneHistory: 空输入返回空对象，不抛错", () => {
  assert.deepEqual(pruneHistory({}), {});
});

test("buildRolling: 空历史 + 今日 → 仅今日（fetchedToday=true）", () => {
  const today = [
    {
      url: "a",
      title: "A",
      sourceId: "s",
      source: "S",
      category: "finance" as const,
      excerpt: "",
      publishedAt: new Date(),
    },
  ];
  const out = buildRolling(today, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].fetchedToday, true);
});

test("buildRolling: 今日文章 publishedAt 超7天窗口 → 丢弃", () => {
  const today = [
    {
      url: "old",
      title: "O",
      sourceId: "s",
      source: "S",
      category: "finance" as const,
      excerpt: "",
      publishedAt: new Date(Date.now() - 9 * DAY),
    },
  ];
  assert.deepEqual(buildRolling(today, {}), []);
});

test("buildRolling: URL 冲突今日胜出，并继承历史 AI 分析（subcategory/relevant/summary）", () => {
  const now = Date.now();
  const h: HistoryStore = {
    dup: mk("dup", {
      subcategory: "gz-credit",
      subcategories: ["gz-credit", "gz-wealth"],
      ai_relevant: true,
      summary: "历史AI摘要",
      publishedAt: iso(now - DAY),
    }),
  };
  const today = [
    {
      url: "dup",
      title: "今日新标题",
      sourceId: "s",
      source: "S",
      category: "finance" as const,
      excerpt: "",
      publishedAt: new Date(now - 30 * 60_000),
    },
  ];
  const out = buildRolling(today, h);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "今日新标题", "今日标题胜出");
  assert.equal(out[0].subcategory, "gz-credit", "继承历史 subcategory");
  assert.deepEqual(out[0].subcategories, ["gz-credit", "gz-wealth"], "继承历史多标签 subcategories");
  assert.equal(out[0].relevant, true, "继承历史 relevant");
  assert.equal(out[0].summary, "历史AI摘要", "今日无摘要时继承历史摘要");
});

test("buildRolling: 历史中重复 URL 只保留一条", () => {
  const now = Date.now();
  const h: HistoryStore = {
    dup1: mk("dup", { publishedAt: iso(now - 2 * DAY), title: "旧版" }),
    dup2: mk("dup", { publishedAt: iso(now - 1 * DAY), title: "新版" }),
  };
  const out = buildRolling([], h);
  const dups = out.filter((a) => a.url === "dup");
  assert.equal(dups.length, 1, "重复 URL 在滚动列表应去重");
});

test("buildRolling: 历史条目 lastSeenAt=今天 → 标记 fetchedToday=true（预分析/当天早跑内容当天展示）", () => {
  const dayAgo = iso(Date.now() - 86_400_000);
  const h: HistoryStore = {
    // 预分析/今天早跑写入：lastSeenAt 今天，publishedAt 1 天前（在 2 天抓取窗口内）
    pre: mk("https://x/pre", {
      subcategory: "cn-policy",
      ai_relevant: true,
      summary: "公积金政策解读",
      publishedAt: iso(Date.now() - 1 * 86_400_000),
    }),
    // 昨天写入：lastSeenAt 昨天 → 不标记当天（publishedAt 仍在窗口内）
    old: mk("https://x/old", {
      lastSeenAt: dayAgo,
      publishedAt: iso(Date.now() - 1 * 86_400_000),
    }),
  };
  const out = buildRolling([], h);
  const pre = out.find((a) => a.url === "https://x/pre");
  const old = out.find((a) => a.url === "https://x/old");
  assert.equal(pre?.fetchedToday, true, "lastSeenAt=今天 的历史条目应标记为当天展示");
  assert.ok(pre?.subcategory === "cn-policy" && pre?.summary === "公积金政策解读", "应继承 AI 分析字段");
  assert.equal(old?.fetchedToday, false, "lastSeenAt=昨天 的历史条目不标记当天");
});
