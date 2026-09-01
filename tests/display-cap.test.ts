/**
 * applyDisplayCaps 的 gz 展示保底（2026-09-01 用户指令 #2）功能测试。
 *
 * 规则：
 *  - gz_local 不足 3 条时，从 biz_insight / policy_market 的 locale==="gz" 条目
 *    按价值分（valueScore）移入补足；
 *  - 宁缺毋滥：找不到相关候选就不补，绝不引入 locale!=="gz" 的「不相关」条目；
 *  - 被移走的条目从原板块删除（不重复展示）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyDisplayCaps } from "../lib/pipeline/display-cap";
import type { DailyReport, ReportItem } from "../lib/types";
import type { DailyContext } from "../lib/pipeline/context";

const ctx = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as DailyContext;

function mkItem(
  url: string,
  partial: Partial<ReportItem> & { locale: ReportItem["locale"] },
): ReportItem {
  return {
    url,
    title_cn: `标题-${url}`,
    source: "测试源",
    source_type: "media",
    date: "09/01",
    summary: "摘要",
    importance: 2,
    rank: 1,
    tags: [],
    ...partial,
  };
}

function emptyReport(): DailyReport {
  return {
    date: "2026-09-01",
    hero_line: "定调",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
}

test("gz 已满 3 条：保底不动，biz/policy 不被掏空", () => {
  const report = emptyReport();
  report.sections.gz_local = [
    mkItem("https://g/1", { locale: "gz", importance: 3 }),
    mkItem("https://g/2", { locale: "gz" }),
    mkItem("https://g/3", { locale: "gz" }),
  ];
  report.sections.biz_insight = [mkItem("https://b/1", { locale: "gz" })]; // 虽也是 gz，但 gz 已满不动
  report.sections.policy_market = [mkItem("https://p/1", { locale: "national" })];
  const out = applyDisplayCaps(report, ctx);
  assert.equal(out.sections.gz_local.length, 3, "gz 已足量不补");
  assert.equal(out.sections.biz_insight.length, 1, "biz 不被掏空");
  assert.equal(out.sections.policy_market.length, 1);
});

test("gz 不足 3 条：从 biz/policy 移入 locale=gz 条目补足到 3，原板块移除", () => {
  const report = emptyReport();
  report.sections.gz_local = [mkItem("https://g/1", { locale: "gz", importance: 3 })];
  report.sections.biz_insight = [
    mkItem("https://b/1", { locale: "gz" }),
    mkItem("https://b/2", { locale: "gz" }),
    mkItem("https://b/3", { locale: "national" }),
  ];
  const out = applyDisplayCaps(report, ctx);
  assert.equal(out.sections.gz_local.length, 3, "补足到 3");
  const urls = out.sections.gz_local.map((i) => i.url);
  assert.ok(urls.includes("https://b/1") && urls.includes("https://b/2"), "biz 的 gz 条目被移入");
  assert.equal(out.sections.biz_insight.length, 1, "被移走的不再出现在 biz");
  assert.equal(out.sections.biz_insight[0].url, "https://b/3", "national 条目留在 biz");
});

test("gz 为 0 且其他板块无 locale=gz 候选：宁缺毋滥，保持 0 且不动其他板块", () => {
  const report = emptyReport();
  report.sections.biz_insight = [
    mkItem("https://b/1", { locale: "national", importance: 3 }),
    mkItem("https://b/2", { locale: "overseas" }),
  ];
  report.sections.policy_market = [mkItem("https://p/1", { locale: "national" })];
  const out = applyDisplayCaps(report, ctx);
  assert.equal(out.sections.gz_local.length, 0, "无候选不硬凑");
  assert.equal(out.sections.biz_insight.length, 2, "不相关的条目不移动");
  assert.equal(out.sections.policy_market.length, 1);
});

test("只移 locale=gz：价值分更高的 national 条目不作为候选", () => {
  const report = emptyReport();
  report.sections.gz_local = [mkItem("https://g/1", { locale: "gz" })];
  report.sections.biz_insight = [
    mkItem("https://b/high", { locale: "national", importance: 3 }), // 高分但非 gz，不得补
    mkItem("https://b/gz1", { locale: "gz", importance: 1 }),
  ];
  const out = applyDisplayCaps(report, ctx);
  assert.equal(out.sections.gz_local.length, 2, "只补 1 条 gz");
  assert.ok(out.sections.gz_local.some((i) => i.url === "https://b/gz1"));
  assert.ok(!out.sections.gz_local.some((i) => i.url === "https://b/high"), "national 高分也不补");
  assert.equal(out.sections.biz_insight.length, 1, "national 留在 biz");
});

test("补足按价值分排序：候选多个时取价值最高的", () => {
  const report = emptyReport();
  report.sections.gz_local = [mkItem("https://g/1", { locale: "gz" })];
  report.sections.biz_insight = [
    mkItem("https://b/low", { locale: "gz", importance: 1 }),
    mkItem("https://b/mid", { locale: "gz", importance: 2 }),
    mkItem("https://b/high", { locale: "gz", importance: 3 }),
  ];
  const out = applyDisplayCaps(report, ctx);
  assert.equal(out.sections.gz_local.length, 3, "补足到 3");
  const gzUrls = out.sections.gz_local.map((i) => i.url);
  assert.ok(gzUrls.includes("https://b/high") && gzUrls.includes("https://b/mid"), "取价值最高两条");
  assert.ok(!gzUrls.includes("https://b/low"), "价值最低的留下");
  assert.equal(out.sections.biz_insight.length, 1);
  assert.equal(out.sections.biz_insight[0].url, "https://b/low");
});
