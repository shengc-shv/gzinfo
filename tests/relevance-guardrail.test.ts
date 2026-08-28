import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExecutiveFromScores,
  applyRelevanceGuardrail,
  type ExecutiveSummary,
} from "../lib/ai/executive-summary.ts";

// 真实形态文章（字段对齐 ArticleInput：source 而非 sourceId）
const A_40Y = {
  title: "央行两部门：房贷最长可贷40年",
  source: "21jingji-finance",
  category: "finance",
  subcategory: "cn-finance",
  summary: "个人住房贷款期限由最长30年延长至最长40年",
  url: "https://x/40y",
};
const A_SUBSIDY = {
  title: "银行落实贷款贴息新政 财政资金激活消费与实体经济",
  source: "stcn",
  category: "finance",
  subcategory: "cn-finance",
  url: "https://x/subsidy",
};
const A_AWARD = {
  title: "科学探索奖50位青年获奖",
  source: "stcn",
  category: "finance",
  subcategory: "cn-finance",
  url: "https://x/award",
};
const A_FINE = {
  title: "交通银行广东分行及三支行共被罚130万，涉个人贷款业务违规等",
  source: "stcn",
  category: "finance",
  subcategory: "cn-finance",
  url: "https://x/fine",
};

test("buildExecutiveFromScores：房贷40年确定性置顶必读，获奖类沉底", () => {
  const exec = buildExecutiveFromScores([A_40Y, A_SUBSIDY, A_AWARD, A_FINE], "2026-08-28");
  const titles = exec.must_read.map((m) => m.title);
  // 房贷40年 必在必读且排第 1
  assert.ok(titles.length >= 1, "必读不应为空");
  assert.equal(titles[0], A_40Y.title, "房贷40年应置顶必读 #1");
  // 科技获奖（用户红线反例）不得进入必读
  assert.ok(!titles.includes(A_AWARD.title), "获奖类不应进必读");
  // 风险卡应捕获交行广东罚单（override-B 风险向）
  assert.ok(exec.risk && exec.risk.topic.includes("交通银行"), "风险卡应含交行广东罚单");
  // 必读每条都应带 url（mergeStoredExecutive 才能回填到报告内条目）
  for (const m of exec.must_read) assert.ok(m.url, `必读「${m.title}」应带 url`);
});

test("applyRelevanceGuardrail：LLM 把房贷40年埋到第3，护栏重排回顶部", () => {
  const exec: ExecutiveSummary = {
    hero_line: "今日市场综述",
    must_read: [
      { title: A_SUBSIDY.title, why: "贴息新政", url: A_SUBSIDY.url },
      { title: "某市场数据波动解读", why: "数据回顾", url: "https://x/data" },
      { title: A_40Y.title, why: "房贷期限延长", url: A_40Y.url },
    ],
    insights: [],
  };
  const guarded = applyRelevanceGuardrail(exec, [A_40Y, A_SUBSIDY]);
  assert.equal(guarded.must_read[0].title, A_40Y.title, "护栏应把房贷40年重排至必读 #1");
  // 原有 3 条不应丢失（仅重排）
  assert.equal(guarded.must_read.length, 3, "护栏不应丢条，只重排");
});

test("applyRelevanceGuardrail：LLM 漏选房贷40年，护栏强制顶入", () => {
  const exec: ExecutiveSummary = {
    hero_line: "今日市场综述",
    must_read: [{ title: A_SUBSIDY.title, why: "贴息新政", url: A_SUBSIDY.url }],
    insights: [],
  };
  const guarded = applyRelevanceGuardrail(exec, [A_40Y, A_SUBSIDY]);
  const titles = guarded.must_read.map((m) => m.title);
  assert.ok(titles.includes(A_40Y.title), "硬规则条目即便 LLM 漏选也应被强制顶入必读");
  assert.equal(guarded.must_read[0].title, A_40Y.title, "强制顶入项应置顶");
});
