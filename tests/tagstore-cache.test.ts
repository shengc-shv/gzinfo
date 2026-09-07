import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emptyStore,
  buildRecord,
  mergeRecord,
  upsertRecords,
  pruneStore,
  lookup,
  storeStats,
  type TagRecord,
} from "../lib/tagstore/store";
import { splitByCache, toSkipRunnerArgs } from "../lib/tagstore/split";
import { mergeReports, harvestFromReport, countItems } from "../lib/tagstore/merge";
import type { Pass1Input } from "../lib/ai/pass1";
import type { ArticleInput, DailyReport } from "../lib/types";

// M4 · TagStore 缓存复用流水线：守卫式写入 / 幂等 / 分流 / 合并不漏损。
// 用户 2026-09-07 明确验收标准：①参数化 ②预分析与正式跑都不漏损 ③无预分析时等价全量 LLM。

const NOW = "2026-09-07T12:00:00.000Z";

function rec(over: Partial<TagRecord> = {}): TagRecord {
  return {
    id: "id-" + (over.url ?? "u1"),
    url: "https://x.com/a",
    rawUrl: "https://x.com/a",
    titleFp: "tfp1",
    contentFp: "cfp1",
    title: "标题A",
    publishedAt: NOW,
    firstSeenAt: NOW,
    taggedAt: NOW,
    tagger: "workbuddy",
    schema: 1,
    aiRelevant: true,
    summary: "银行零售视角解读",
    hits: 1,
    ...over,
  };
}

function input(url: string, title = "标题"): Pass1Input {
  return {
    url,
    title,
    source: "stcn",
    date: "09/07",
    raw_text: "正文摘要",
    category: "finance",
  };
}

function article(url: string, over: Partial<ArticleInput> = {}): ArticleInput {
  return {
    url,
    title: "标题",
    source: "stcn",
    sourceId: "stcn",
    excerpt: "摘要",
    publishedAt: new Date(NOW) as unknown as ArticleInput["publishedAt"],
    ...over,
  } as ArticleInput;
}

function report(items: { url: string; section: keyof DailyReport["sections"] }[]): DailyReport {
  const r: DailyReport = {
    date: "2026-09-07",
    hero_line: "定调",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
  for (const { url, section } of items) {
    r.sections[section].push({
      url,
      title_cn: "标题",
      source: "stcn",
      source_type: "media",
      date: "09/07",
      summary: "成稿摘要",
      importance: 2,
      rank: r.sections[section].length + 1,
      tags: [],
      locale: "national",
    });
  }
  return r;
}

// ───────────────────────── 守卫式写入 ─────────────────────────

test("mergeRecord: 高信任可覆盖低信任（pipeline > workbuddy）", () => {
  const prev = rec({ tagger: "workbuddy", summary: "旧解读" });
  const next = rec({ tagger: "pipeline", summary: "新解读" });
  assert.equal(mergeRecord(prev, next).summary, "新解读");
});

test("mergeRecord: 低信任不得覆盖高信任，只补齐缺失字段", () => {
  const prev = rec({ tagger: "pipeline", summary: "权威解读", section: "biz_insight" });
  const next = rec({ tagger: "workbuddy", summary: "离线解读", businessLines: ["财富"] });
  const out = mergeRecord(prev, next);
  assert.equal(out.summary, "权威解读", "已有权威摘要不得被覆盖");
  assert.equal(out.section, "biz_insight");
  assert.deepEqual(out.businessLines, ["财富"], "缺失字段应被补齐");
});

test("mergeRecord: 无值字段绝不覆盖有值字段", () => {
  const prev = rec({ summary: "有值" });
  const next = rec({ summary: "" });
  assert.equal(mergeRecord(prev, next).summary, "有值");
});

test("mergeRecord: firstSeenAt 永远取最早", () => {
  const prev = rec({ firstSeenAt: "2026-09-06T00:00:00.000Z" });
  const next = rec({ firstSeenAt: NOW });
  assert.equal(mergeRecord(prev, next).firstSeenAt, "2026-09-06T00:00:00.000Z");
});

test("mergeRecord: schema 升级后新记录全量覆盖", () => {
  const prev = rec({ schema: 1, summary: "旧口径" });
  const next = rec({ schema: 2, summary: "新口径" });
  assert.equal(mergeRecord(prev, next).summary, "新口径");
});

// ───────────────────────── 幂等 ─────────────────────────

test("upsertRecords: 同一记录重复写入 → 第二次无变化（严格幂等）", () => {
  const store = emptyStore();
  const r = buildRecord({
    url: "https://x.com/a",
    title: "标题A",
    publishedAt: NOW,
    aiRelevant: true,
    summary: "解读",
    tagger: "workbuddy",
  })!;
  const s1 = upsertRecords(store, [r]);
  const s2 = upsertRecords(store, [r]);
  assert.deepEqual(s1, { added: 1, updated: 0, skipped: 0 });
  assert.deepEqual(s2, { added: 0, updated: 0, skipped: 1 }, "重复写入不得产生变化");
  assert.equal(Object.keys(store.records).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(store)), JSON.parse(JSON.stringify(store)));
});

test("buildRecord: 无真实发布时间 → 拒绝入库（时间真实性红线）", () => {
  assert.equal(
    buildRecord({ url: "https://x.com/a", title: "t", publishedAt: "", aiRelevant: true, tagger: "workbuddy" }),
    null,
  );
  assert.equal(
    buildRecord({ url: "", title: "t", publishedAt: NOW, aiRelevant: true, tagger: "workbuddy" }),
    null,
  );
});

test("upsertRecords: 过期条目不入库", () => {
  const store = emptyStore();
  const old = buildRecord({
    url: "https://x.com/old",
    title: "旧闻",
    publishedAt: "2020-01-01T00:00:00.000Z",
    aiRelevant: true,
    tagger: "workbuddy",
  })!;
  const s = upsertRecords(store, [old]);
  assert.equal(s.skipped, 1);
  assert.equal(Object.keys(store.records).length, 0);
});

test("pruneStore: 清理过期并重建 titleIndex", () => {
  const store = emptyStore();
  const fresh = buildRecord({ url: "https://x.com/new", title: "新", publishedAt: NOW, aiRelevant: true, tagger: "workbuddy" })!;
  const old = buildRecord({ url: "https://x.com/old", title: "旧", publishedAt: "2020-01-01T00:00:00.000Z", aiRelevant: true, tagger: "workbuddy" })!;
  store.records[fresh.id] = fresh;
  store.records[old.id] = old;
  store.titleIndex[old.titleFp] = old.id;
  const removed = pruneStore(store);
  assert.equal(removed, 1);
  assert.equal(Object.keys(store.records).length, 1);
  assert.equal(store.titleIndex[old.titleFp], undefined, "titleIndex 应同步清理");
});

// ───────────────────────── 查询（双主键） ─────────────────────────

test("lookup: 一级键 URL 命中", () => {
  const store = emptyStore();
  const r = buildRecord({ url: "https://x.com/a?utm_source=wx", title: "标题A", publishedAt: NOW, aiRelevant: true, tagger: "workbuddy" })!;
  upsertRecords(store, [r]);
  // 带 utm 的同一 URL 应命中同一条
  assert.ok(lookup(store, "https://x.com/a", "标题A"));
});

test("lookup: URL 漂移时用标题指纹兜底命中", () => {
  const store = emptyStore();
  const r = buildRecord({ url: "https://x.com/old-path", title: "广州银行业上半年增长", publishedAt: NOW, aiRelevant: true, tagger: "workbuddy" })!;
  upsertRecords(store, [r]);
  const hit = lookup(store, "https://x.com/new-path", "广州银行业上半年增长");
  assert.ok(hit, "标题指纹应兜底命中");
  assert.equal(hit!.id, r.id);
});

test("lookup: schema 不一致视为失效，需重打", () => {
  const store = emptyStore();
  const r = buildRecord({ url: "https://x.com/a", title: "标题A", publishedAt: NOW, aiRelevant: true, tagger: "workbuddy" })!;
  upsertRecords(store, [r]);
  store.records[r.id].schema = 99;
  assert.equal(lookup(store, "https://x.com/a", "标题A"), undefined);
});

// ───────────────────────── 分流 ─────────────────────────

test("splitByCache: 命中/未命中/无价值 三路分流正确", () => {
  const store = emptyStore();
  upsertRecords(store, [
    buildRecord({ url: "https://x.com/hit", title: "有价值", publishedAt: NOW, aiRelevant: true, tagger: "workbuddy" })!,
    buildRecord({ url: "https://x.com/no", title: "无价值", publishedAt: NOW, aiRelevant: false, tagger: "workbuddy" })!,
  ]);
  const res = splitByCache(
    [input("https://x.com/hit", "有价值"), input("https://x.com/no", "无价值"), input("https://x.com/new", "新条目"), input("", "脏数据")],
    store,
  );
  assert.equal(res.hit.length, 1, "有价值命中 → 复用组");
  assert.equal(res.miss.length, 1, "未命中 → LLM 组");
  assert.equal(res.droppedIrrelevant, 1, "已判无价值 → 丢弃");
  assert.equal(res.droppedInvalid, 1, "无 URL → 脏数据");
});

test("splitByCache: 空 store → 全部走 LLM（等价现状全量）", () => {
  const res = splitByCache([input("https://x.com/a"), input("https://x.com/b")], emptyStore());
  assert.equal(res.miss.length, 2);
  assert.equal(res.hit.length, 0);
});

test("toSkipRunnerArgs: 用管线原始 url 建白名单（非规范化 url）", () => {
  const store = emptyStore();
  const r = buildRecord({ url: "https://x.com/a?utm_source=wx", title: "T", publishedAt: NOW, aiRelevant: true, summary: "解读", tagger: "workbuddy" })!;
  upsertRecords(store, [r]);
  const { hit } = splitByCache([input("https://x.com/a?utm_source=wx", "T")], store);
  const { relevantUrls, summaryCache } = toSkipRunnerArgs(hit);
  assert.ok(relevantUrls.has("https://x.com/a?utm_source=wx"), "必须是管线看到的原始 url");
  assert.equal(summaryCache.get("https://x.com/a?utm_source=wx"), "解读");
});

// ───────────────────────── 合并不漏损 ─────────────────────────

test("mergeReports: 两组条目全部保留（不漏损）", () => {
  const fresh = report([
    { url: "https://x.com/1", section: "gz_local" },
    { url: "https://x.com/2", section: "biz_insight" },
  ]);
  const cached = report([
    { url: "https://x.com/3", section: "policy_market" },
    { url: "https://x.com/4", section: "gz_local" },
  ]);
  const merged = mergeReports(fresh, cached, "2026-09-07");
  assert.equal(countItems(merged), countItems(fresh) + countItems(cached), "合并后条数 = 两组之和");
  assert.equal(merged.sections.gz_local.length, 2);
  assert.equal(merged.sections.policy_market.length, 1);
});

test("mergeReports: rank 重排从 1 开始且连续", () => {
  const fresh = report([{ url: "https://x.com/1", section: "gz_local" }]);
  const cached = report([{ url: "https://x.com/2", section: "gz_local" }]);
  const merged = mergeReports(fresh, cached, "2026-09-07");
  assert.deepEqual(merged.sections.gz_local.map((i) => i.rank), [1, 2]);
});

test("mergeReports: hero_line 以真 LLM 产出优先", () => {
  const fresh = report([]);
  fresh.hero_line = "LLM 定调";
  const cached = report([]);
  cached.hero_line = "缓存定调";
  assert.equal(mergeReports(fresh, cached, "d").hero_line, "LLM 定调");
  assert.equal(mergeReports({ ...report([]), hero_line: "" }, cached, "d").hero_line, "缓存定调");
});

// ───────────────────────── 回灌 ─────────────────────────

test("harvestFromReport: 成稿条目标 true，未成稿条目标 false", () => {
  const r = report([{ url: "https://x.com/1", section: "biz_insight" }]);
  const urls = ["https://x.com/1", "https://x.com/2"];
  const byUrl = new Map(urls.map((u) => [u, article(u)]));
  const records = harvestFromReport(r, { urls, articlesByUrl: byUrl, tagger: "pipeline", markDroppedAsIrrelevant: true });
  assert.equal(records.length, 2);
  assert.equal(records.find((x) => x.url === "https://x.com/1")!.aiRelevant, true);
  assert.equal(records.find((x) => x.url === "https://x.com/2")!.aiRelevant, false);
});

test("harvestFromReport: LLM 失败时（markDropped=false）不标记无价值，避免永久误杀", () => {
  const r = report([{ url: "https://x.com/1", section: "biz_insight" }]);
  const urls = ["https://x.com/1", "https://x.com/2"];
  const byUrl = new Map(urls.map((u) => [u, article(u)]));
  const records = harvestFromReport(r, { urls, articlesByUrl: byUrl, tagger: "pipeline", markDroppedAsIrrelevant: false });
  assert.equal(records.length, 1, "未成稿条目不得回写");
  assert.equal(records[0].aiRelevant, true);
});

test("harvestFromReport: 无发布时间的条目不回灌（时间真实性红线）", () => {
  const r = report([{ url: "https://x.com/1", section: "biz_insight" }]);
  const a = article("https://x.com/1");
  (a as unknown as Record<string, unknown>).publishedAt = undefined;
  const records = harvestFromReport(r, {
    urls: ["https://x.com/1"],
    articlesByUrl: new Map([["https://x.com/1", a]]),
    tagger: "pipeline",
    markDroppedAsIrrelevant: true,
  });
  assert.equal(records.length, 0);
});

test("storeStats: 统计有价值条目与打标者分布", () => {
  const store = emptyStore();
  upsertRecords(store, [
    buildRecord({ url: "https://x.com/a", title: "A", publishedAt: NOW, aiRelevant: true, tagger: "workbuddy" })!,
    buildRecord({ url: "https://x.com/b", title: "B", publishedAt: NOW, aiRelevant: false, tagger: "llm" })!,
  ]);
  const s = storeStats(store);
  assert.equal(s.total, 2);
  assert.equal(s.relevant, 1);
  assert.equal(s.byTagger.workbuddy, 1);
  assert.equal(s.byTagger.llm, 1);
});
