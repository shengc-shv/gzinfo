/**
 * 确定性校验器测试（文档第 4 节，13 条规则 + must_read 引用完整性）。
 * 校验器只证伪、不创作；单条内容永远丢得起，信任丢不起。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReport, type ValidationPool } from "../lib/ai/validator";
import type {
  DailyReport,
  ReportItem,
  ReportSectionKey,
  ReportMustRead,
  ReportInsight,
} from "../lib/types";

const RAW = "广州首套房贷利率降至3.5%，利好刚需购房。";
const HERO = "今日广州房贷利率下调，利好刚需购房。"; // 18 字，落在 15~70

function mk(over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: "https://x/a",
    title_cn: "广州房贷利率下调",
    source: "源",
    source_type: "media",
    date: "08/19",
    summary: "广州首套房贷利率降至3.5%。",
    importance: 2,
    rank: 1,
    tags: ["信贷"],
    locale: "national",
    ...over,
  };
}

function pool(rawByUrl: Record<string, string>): ValidationPool {
  return { get: (u) => (u in rawByUrl ? { raw_text: rawByUrl[u] } : undefined) };
}

/** 把给定条目放入指定板块，其余板块置空。 */
function reportWith(
  section: ReportSectionKey,
  items: ReportItem[],
  extra: Partial<DailyReport> = {},
): DailyReport {
  const sections: DailyReport["sections"] = {
    gz_local: [],
    biz_insight: [],
    policy_market: [],
    tech: [],
    ipo: [],
  };
  sections[section] = items;
  return {
    date: "2026-08-19",
    hero_line: HERO,
    must_read: [],
    insights: [],
    sections,
    ...extra,
  };
}

const blocksOf = (r: DailyReport, p: ValidationPool) =>
  validateReport(r, p).filter((i) => i.level === "block");
const warnsOf = (r: DailyReport, p: ValidationPool) =>
  validateReport(r, p).filter((i) => i.level === "warn");

test("基线：单一合法条目 + 合法 hero_line → 0 block / 0 warn", () => {
  const r = reportWith("biz_insight", [mk()]);
  assert.equal(blocksOf(r, pool({ "https://x/a": RAW })).length, 0);
  assert.equal(warnsOf(r, pool({ "https://x/a": RAW })).length, 0);
});

test("R1 URL 防幻觉：url 不在输入池 → block", () => {
  const r = reportWith("biz_insight", [mk({ url: "https://x/ghost" })]);
  const bs = blocksOf(r, pool({ "https://x/a": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R1")));
});

test("R2 地域证据防幻觉：locale=gz 但 evidence 非原文子串 → block", () => {
  const r = reportWith("gz_local", [
    mk({ url: "https://x/g", locale: "gz", locale_evidence: "上海", title_cn: "本地动态", summary: "本地活动举办。" }),
  ]);
  const bs = blocksOf(r, pool({ "https://x/g": "广州本地活动举办。" }));
  assert.ok(bs.some((i) => i.msg.includes("R2")));
});

test("R3 地域表述一致性：locale≠gz 但 summary 出现「广东企业」→ block", () => {
  const r = reportWith("biz_insight", [
    mk({ summary: "广东某公司发布新产品，值得关注。" }),
  ]);
  const bs = blocksOf(r, pool({ "https://x/a": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R3")));
});

test("R4 gz_local 纯洁性：板块内 locale≠gz → block", () => {
  const r = reportWith("gz_local", [mk({ locale: "national" })]);
  const bs = blocksOf(r, pool({ "https://x/a": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R4")));
});

test("R4 gz_local 纯洁性：locale=gz 但标题+摘要无广州关键词 → warn（不 block）", () => {
  const r = reportWith("gz_local", [
    mk({ url: "https://x/g", locale: "gz", locale_evidence: "广州", title_cn: "社区活动", summary: "社区举办文艺活动。" }),
  ]);
  const p = pool({ "https://x/g": "广州社区举办文艺活动。" });
  assert.equal(blocksOf(r, p).length, 0, "R2 通过（evidence 在原文）→ 不应 block");
  assert.ok(warnsOf(r, p).some((i) => i.msg.includes("R4")));
});

test("R5 importance 强制分布：全量 importance=3 共 4 条 → block", () => {
  const items = (["biz_insight", "policy_market", "tech", "ipo"] as ReportSectionKey[]).map((s, i) =>
    mk({ url: `https://x/${i}`, title_cn: `标题${i}`, importance: 3 }),
  );
  // 分别放入不同板块，避免触发「每板块≤1」
  const sections: DailyReport["sections"] = {
    gz_local: [],
    biz_insight: [items[0]],
    policy_market: [items[1]],
    tech: [items[2]],
    ipo: [items[3]],
  };
  const r: DailyReport = { date: "2026-08-19", hero_line: HERO, must_read: [], insights: [], sections };
  const bs = blocksOf(r, pool(Object.fromEntries(items.map((it) => [it.url, RAW]))));
  assert.ok(bs.some((i) => i.msg.includes("R5") && i.msg.includes("全量")));
});

test("R5 importance 强制分布：同板块 2 条 importance=3 → block", () => {
  const r = reportWith("biz_insight", [
    mk({ url: "https://x/1", title_cn: "一", importance: 3 }),
    mk({ url: "https://x/2", title_cn: "二", importance: 3 }),
  ]);
  const bs = blocksOf(r, pool({ "https://x/1": RAW, "https://x/2": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R5") && i.where.includes("sections.biz_insight")));
});

test("R6 违禁词：summary 含 BTC → block", () => {
  const r = reportWith("tech", [mk({ summary: "BTC 今日大涨。" })]);
  const bs = blocksOf(r, pool({ "https://x/a": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R6")));
});

test("R7 空话检测：summary 出现无关表述 → block", () => {
  const r = reportWith("biz_insight", [mk({ summary: "本条与银行零售业务无关联。" })]);
  const bs = blocksOf(r, pool({ "https://x/a": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R7")));
});

test("R8 数字防幻觉：summary 数字不在原文 → warn", () => {
  const r = reportWith("biz_insight", [mk({ summary: "利率降至3.5%，利好购房。" })]);
  // 原文只有「2026年」这个无关数字，不含 3.5
  const ws = warnsOf(r, pool({ "https://x/a": "根据2026年数据观察。" }));
  assert.ok(ws.some((i) => i.msg.includes("R8")));
});

test("R9 跨板块去重：两条标题高度相似 → block", () => {
  const items = [
    mk({ url: "https://x/1", title_cn: "广州房贷利率下调" }),
    mk({ url: "https://x/2", title_cn: "广州房贷利率下调" }),
  ];
  const sections: DailyReport["sections"] = {
    gz_local: [],
    biz_insight: [items[0]],
    policy_market: [items[1]],
    tech: [],
    ipo: [],
  };
  const r: DailyReport = { date: "2026-08-19", hero_line: HERO, must_read: [], insights: [], sections };
  const bs = blocksOf(r, pool({ "https://x/1": RAW, "https://x/2": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R9")));
});

test("R10 tag 封闭词表：非法 tag → block", () => {
  const r = reportWith("biz_insight", [mk({ tags: ["非法标签"] })]);
  const bs = blocksOf(r, pool({ "https://x/a": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R10")));
});

test("R11 商机结构完整性：impact 为空 → block", () => {
  const insights: ReportInsight[] = [{ topic: "话题", tags: ["信贷"], impact: "", action: "动作" }];
  const r = reportWith("biz_insight", [mk()], { insights });
  const bs = blocksOf(r, pool({ "https://x/a": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R11")));
});

test("R11 商机结构完整性：insights 超过 7 条 → block", () => {
  const insights: ReportInsight[] = Array.from({ length: 8 }, (_, i) => ({
    topic: `话题${i}`,
    tags: ["信贷"],
    impact: "影响",
    action: "动作",
  }));
  const r = reportWith("biz_insight", [mk()], { insights });
  const bs = blocksOf(r, pool({ "https://x/a": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R11") && i.msg.includes("上限 7")));
});

test("R12 hero_line：缺失 → block", () => {
  const r = reportWith("biz_insight", [mk()], { hero_line: "" });
  const bs = blocksOf(r, pool({ "https://x/a": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R12")));
});

test("R12 hero_line：字数 < 15 → block", () => {
  const r = reportWith("biz_insight", [mk()], { hero_line: "今日利率下调。" });
  const bs = blocksOf(r, pool({ "https://x/a": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("R12")));
});

test("R13 外文标题翻译：title_cn 连续拉丁词 ≥4 → warn", () => {
  const r = reportWith("tech", [mk({ title_cn: "The Quick Brown Fox Jump" })]);
  const ws = warnsOf(r, pool({ "https://x/a": RAW }));
  assert.ok(ws.some((i) => i.msg.includes("R13")));
});

test("must_read 引用完整性：url 不在成稿条目 → block", () => {
  const must: ReportMustRead[] = [{ url: "https://x/missing", why: "重要" }];
  const r = reportWith("biz_insight", [mk()], { must_read: must });
  const bs = blocksOf(r, pool({ "https://x/a": RAW }));
  assert.ok(bs.some((i) => i.msg.includes("must_read")));
});
