/**
 * 分行相关性评分层 功能测试（客户中心护栏）
 *
 * 验证：评分器把「直击分行核心业务(住房金融/信贷/客群/财富/私行)的国家政策」顶到必读，
 * 把「与银行零售无关」的软资讯(获奖/出口) 沉到 drop；
 * 广州本地监管/合规事件 → 风险必读。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreBranchRelevance, rankByRelevance } from "../lib/ai/relevance-score";

// 真实同题报道（2026-08-28 央行、金监总局联合发文）
const MORTGAGE_40Y = {
  title: "央行、金监总局：个人住房贷款期限由最长30年延长至40年",
  category: "gz",
  subcategory: "cn-finance",
  sourceId: "21jingji-finance",
  summary: "个人住房贷款最长期限由30年延长至40年，存量房贷可协商重组。",
};

test("房贷40年：国家核心监管+分行核心业务 → 必读置顶（硬规则A）", () => {
  const r = scoreBranchRelevance(MORTGAGE_40Y);
  assert.equal(r.tier, "must_read");
  assert.equal(r.vertical, "must_read");
  assert.ok(r.override, "硬规则A应触发");
  // 住房金融已并入信贷（2026-08-29 用户拍板：信贷 = 房贷/消费贷/小微贷）
  assert.ok(r.businessLines.includes("信贷"));
});

test("美联储黄金跌：权威但非政策动作 → 仅为 insight，不占必读位", () => {
  const r = scoreBranchRelevance({
    title: "深夜，美联储主席发声！黄金大跌、芯片巨头重挫",
    category: "finance",
    subcategory: "cn-finance",
    sourceId: "sina-finance",
  });
  // 财富线命中但可行动性不足（市场数据，非政策动作）→ 封顶 insight
  assert.equal(r.tier, "insight");
  assert.ok(!r.businessLines.includes("信贷"));
});

test("房贷40年 评分应高于 美联储黄金跌（客户中心排序不被市场噪声压过）", () => {
  const a = scoreBranchRelevance(MORTGAGE_40Y).score;
  const b = scoreBranchRelevance({
    title: "深夜，美联储主席发声！黄金大跌、芯片巨头重挫",
    category: "finance",
    subcategory: "cn-finance",
    sourceId: "sina-finance",
  }).score;
  assert.ok(a > b, `房贷(${a}) 应高于 美联储黄金(${b})`);
});

test("信托地产新规（金监总局发文+房地产/信托）→ 必读", () => {
  const r = scoreBranchRelevance({
    title: "国家金融监督管理总局印发《信托公司开展房地产领域信托业务管理办法（试行）》",
    category: "finance",
    subcategory: "cn-finance",
    sourceId: "stcn",
  });
  assert.equal(r.tier, "must_read");
  assert.ok(r.businessLines.includes("信贷"));
});

test("消费贷贴息（信贷+贴息动作）→ 必读", () => {
  const r = scoreBranchRelevance({
    title: '实探消费贷贴息“扩围提额” 银行：系统已自动适配',
    category: "finance",
    subcategory: "cn-finance",
    sourceId: "sina-finance",
  });
  assert.equal(r.tier, "must_read");
  assert.ok(r.businessLines.includes("信贷"));
});

test("反例(用户红线)：科学探索奖获奖 → drop（与客群/财富/信贷无关）", () => {
  const r = scoreBranchRelevance({
    title: "科学探索奖50位青年获奖",
    category: "tech",
    subcategory: "tech",
    sourceId: "stcn",
  });
  assert.equal(r.tier, "drop");
});

test("反例(用户红线)：机器人出口动态 → 不进必读/商机", () => {
  const r = scoreBranchRelevance({
    title: "欧洲市场欢迎中国机器人",
    category: "tech",
    subcategory: "tech",
    sourceId: "sina-finance",
  });
  assert.ok(r.tier === "drop" || r.tier === "context");
  assert.ok(r.tier !== "must_read" && r.tier !== "insight");
});

test("交行广东分行罚单：广州本地监管事件 → 风险必读（硬规则B）", () => {
  const r = scoreBranchRelevance({
    title: "交通银行广东分行及三支行共被罚130万，涉个人贷款业务违规等",
    category: "finance",
    subcategory: "cn-finance",
    sourceId: "cnfin",
  });
  assert.equal(r.tier, "must_read");
  assert.equal(r.vertical, "risk");
  assert.ok(r.override, "硬规则B应触发");
  assert.ok(r.locality >= 0.9);
});

test("广州社零回暖：客群线+广州本地 → insight", () => {
  const r = scoreBranchRelevance({
    title: "广州7月社零同比增长5.2% 消费回暖",
    category: "gz",
    subcategory: "cn-finance",
    sourceId: "21jingji-finance",
  });
  assert.equal(r.tier, "insight");
  assert.ok(r.businessLines.includes("客群"));
  assert.ok(r.locality >= 1.0);
});

test("rankByRelevance：房贷40年在同批里排第一", () => {
  const ranked = rankByRelevance([
    { title: "深夜，美联储主席发声！黄金大跌、芯片巨头重挫", category: "finance", sourceId: "sina-finance" },
    MORTGAGE_40Y,
    { title: "科学探索奖50位青年获奖", category: "tech", sourceId: "stcn" },
    { title: "交通银行广东分行及三支行共被罚130万，涉个人贷款业务违规等", category: "finance", sourceId: "cnfin" },
  ]);
  assert.equal(ranked[0].article.title, MORTGAGE_40Y.title);
  assert.equal(ranked[0].relevance.tier, "must_read");
});
