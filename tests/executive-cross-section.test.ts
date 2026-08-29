import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dedupeExecutiveCrossSection,
  type ExecutiveSummary,
} from "../lib/ai/executive-summary";

function base(): ExecutiveSummary {
  return {
    must_read: [
      { title: "个人房贷期限延至40年", why: "房贷新政影响", url: "https://e1" },
      { title: "央行降准0.5个百分点", why: "流动性宽松", url: "https://e2" },
    ],
    insights: [
      { topic: "公积金代缴新政", impact: "影响", action: "建议动作", tag: ["财富"] },
    ],
  };
}

test("B7：risk 与 must_read 同事件 → 丢弃 risk", () => {
  const exec = base();
  exec.risk = {
    topic: "房贷期限延至40年新规落地",
    evidence: "央行公告",
    impact: "对个贷影响",
    action: "风控部应关注",
    source: "T1",
  };
  const out = dedupeExecutiveCrossSection(exec);
  assert.equal(out.risk, undefined, "同一房贷40年事件不应既必读又风险");
});

test("B7：risk 与 insights 同事件 → 丢弃 risk", () => {
  const exec = base();
  exec.risk = {
    topic: "公积金代缴新政影响",
    evidence: "广州公积金中心通知",
    impact: "对代发影响",
    action: "个金部应跟进",
    source: "T1",
  };
  const out = dedupeExecutiveCrossSection(exec);
  assert.equal(out.risk, undefined, "与商机同事件的 risk 应被丢弃");
});

test("B7：risk 与必读/商机无重叠 → 保留 risk", () => {
  const exec = base();
  exec.risk = {
    topic: "某股份行理财暴雷被监管通报",
    evidence: "金融监管总局通报",
    impact: "对财富销售影响",
    action: "财富部应排查",
    source: "T1",
  };
  const out = dedupeExecutiveCrossSection(exec);
  assert.ok(out.risk, "不相关风险应保留");
  assert.equal(out.risk!.topic, "某股份行理财暴雷被监管通报");
});

test("B7：本就无 risk → 原样返回", () => {
  const exec = base();
  const out = dedupeExecutiveCrossSection(exec);
  assert.equal(out.risk, undefined);
  assert.equal(out.must_read.length, 2);
  assert.equal(out.insights.length, 1);
});
