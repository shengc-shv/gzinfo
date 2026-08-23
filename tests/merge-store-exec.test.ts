/**
 * mergeStoredExecutive（SKIP_AI 执行摘要回填）功能测试。
 * 验证（2026-08-21 修复 store.json 复用断链）：
 *  - store 的 must_read{title,why} 按标题回匹配 report.sections 的 url（Dice≥0.5）
 *  - 无匹配的 must_read 丢弃（宁缺毋滥，避免空链接卡片）
 *  - insights 的 tag[] 适配为 tags[]，topic/impact/action 照搬
 *  - 违禁词过滤：命中 BANNED_WORDS（含加密资产）的 must_read/insights 不回流
 *  - hero_line 在 report 缺省时回填
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeStoredExecutive } from "../lib/output/render";
import type { DailyReport } from "../lib/types";

const emptyReport: DailyReport = {
  date: "2026-08-21",
  hero_line: "今日定调：LPR 维持不变但年内下调预期升温。",
  must_read: [],
  insights: [],
  sections: {
    gz_local: [],
    biz_insight: [],
    policy_market: [
      {
        url: "https://a/lpr",
        title_cn: "8月LPR保持不变，今年房贷还能否下调？",
        source: "央视财经",
        source_type: "official" as const,
        date: "08/21",
        summary: "LPR 不变但下调预期升温。",
        importance: 3 as const,
        rank: 1,
        tags: ["信贷"],
        locale: "national" as const,
      },
      {
        url: "https://a/gold",
        title_cn: "黄金，多极时代的新底仓？",
        source: "央视财经",
        source_type: "official" as const,
        date: "08/21",
        summary: "黄金避险需求上升。",
        importance: 2 as const,
        rank: 2,
        tags: ["财富"],
        locale: "national" as const,
      },
    ],
    tech: [],
    ipo: [],
  },
};

const storeExec = {
  hero_line: "今日主线：LPR 预期与黄金避险。",
  must_read: [
    { title: "8月LPR不变，房贷或续降", why: "LPR维持不变但年内下调预期升温，影响按揭存量竞争。" }, // 应回匹配 https://a/lpr
    { title: "加密资产疯涨，风险积聚", why: "加密市场大涨，居民另类投资偏好升温。" }, // 违禁词 → 丢弃
    { title: "标题完全不存在", why: "无匹配应丢弃。" }, // 无匹配 → 丢弃
  ],
  insights: [
    { topic: "房贷下调预期", impact: "LPR下调预期影响按揭客户行为。", action: "动态调整房贷定价。", tag: ["信贷"] },
    { topic: "加密资产配置", impact: "客户另类投资偏好。", action: "风险提示。", tag: ["财富"] }, // 违禁词 → 丢弃
    { topic: "黄金资产配置", impact: "避险保值需求上升。", action: "做好贵金属供给。", tag: ["财富"] },
  ],
};

test("must_read 按标题回匹配 url（Dice≥0.5），无匹配丢弃", () => {
  const report = mergeStoredExecutive(
    JSON.parse(JSON.stringify(emptyReport)),
    JSON.parse(JSON.stringify(storeExec)),
  );
  assert.equal(report.must_read.length, 1, "仅 1 条回匹配成功（加密/无匹配被滤）");
  assert.equal(report.must_read[0].url, "https://a/lpr");
  assert.ok(report.must_read[0].why.includes("LPR"));
});

test("insights 适配 tag[]→tags[]，违禁词过滤", () => {
  const report = mergeStoredExecutive(
    JSON.parse(JSON.stringify(emptyReport)),
    JSON.parse(JSON.stringify(storeExec)),
  );
  assert.equal(report.insights.length, 2, "2 条保留（加密被滤）");
  const topics = report.insights.map((i) => i.topic);
  assert.ok(topics.includes("房贷下调预期"));
  assert.ok(topics.includes("黄金资产配置"));
  assert.deepEqual(report.insights[0].tags, ["信贷"]);
  assert.ok(!JSON.stringify(report.insights).includes("加密"), "加密内容不回流");
});

test("hero_line 仅当 report 缺省时回填", () => {
  const noHero = { ...emptyReport, hero_line: "" };
  const r1 = mergeStoredExecutive(JSON.parse(JSON.stringify(noHero)), JSON.parse(JSON.stringify(storeExec)));
  assert.equal(r1.hero_line, "今日主线：LPR 预期与黄金避险。");
  const r2 = mergeStoredExecutive(JSON.parse(JSON.stringify(emptyReport)), JSON.parse(JSON.stringify(storeExec)));
  assert.equal(r2.hero_line, emptyReport.hero_line, "已有 hero_line 不被覆盖");
});

test("store 无 hero_line 时用 must_read 首条生成今日定调（替代 SKIP_AI 弱兜底）", () => {
  const noHeroExec = { ...storeExec, hero_line: "" };
  const noHeroReport = { ...emptyReport, hero_line: "" };
  const r = mergeStoredExecutive(JSON.parse(JSON.stringify(noHeroReport)), JSON.parse(JSON.stringify(noHeroExec)));
  assert.ok(r.hero_line, "应生成今日定调");
  assert.ok(r.hero_line.includes("今日关注"), "以「今日关注」开头");
  assert.ok(r.hero_line.includes("LPR"), "引用 must_read 首条标题");
  assert.ok(!r.hero_line.includes("今日更新"), "不再是 SKIP_AI 弱兜底");
});

test("report 已有 SKIP_AI 弱兜底「今日更新 N 条资讯」时也覆盖为 store 定调", () => {
  const weakHero = { ...emptyReport, hero_line: "今日更新 5 条资讯：直击WRC丨智平方张鹏" };
  const r = mergeStoredExecutive(JSON.parse(JSON.stringify(weakHero)), JSON.parse(JSON.stringify(storeExec)));
  assert.equal(r.hero_line, "今日主线：LPR 预期与黄金避险。", "store 有 hero_line 时覆盖弱兜底");
  assert.ok(!r.hero_line.includes("今日更新"), "弱兜底被替换");
});

test("report 已有 HERO_FALLBACK「今日暂无可推送重点」时也覆盖为 must_read 首条定调", () => {
  const fallbackHero = { ...emptyReport, hero_line: "今日暂无可推送重点，详见各板块资讯。" };
  const noHeroExec = { ...storeExec, hero_line: "" };
  const r = mergeStoredExecutive(JSON.parse(JSON.stringify(fallbackHero)), JSON.parse(JSON.stringify(noHeroExec)));
  assert.ok(r.hero_line, "应生成今日定调");
  assert.ok(r.hero_line.includes("今日关注"), "用 must_read 首条生成今日定调");
  assert.ok(r.hero_line.includes("LPR"));
  assert.ok(!r.hero_line.includes("今日暂无可推送"), "HERO_FALLBACK 被替换");
});

test("store 全违禁/全无匹配 → 不污染 report", () => {
  const bad = {
    hero_line: "",
    must_read: [{ title: "加密资产疯涨", why: "加密市场大涨" }],
    insights: [{ topic: "币圈热潮", impact: "x", action: "y" }],
  };
  const report = mergeStoredExecutive(JSON.parse(JSON.stringify(emptyReport)), bad as never);
  assert.equal(report.must_read.length, 0);
  assert.equal(report.insights.length, 0);
});

test("insights 的 sources 从 store 原样透传（生成时已回链，不臆造）", () => {
  // store 无 sources → 不挂来源（避免挂错链接）
  const r = mergeStoredExecutive(JSON.parse(JSON.stringify(emptyReport)), JSON.parse(JSON.stringify(storeExec)));
  for (const i of r.insights) assert.equal(i.sources, undefined, "store 无 sources 则不臆造来源");
  // 显式 sources 透传
  const explicit = mergeStoredExecutive(
    JSON.parse(JSON.stringify(emptyReport)),
    { hero_line: "", must_read: [], insights: [{ topic: "x", impact: "y", action: "z", sources: [{ title: "手填", url: "https://manual/1" }] }] },
  );
  assert.equal(explicit.insights[0].sources?.[0].url, "https://manual/1");
});
