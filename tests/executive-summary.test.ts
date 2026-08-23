/**
 * resolveInsightSources（商机洞察来源回链）功能测试。
 * 验证：生成时按相似度从当日 finance+gz 精选池回链 1-3 条真实来源；
 * 相关项命中、无关项拒绝、无 url 的输入不参与。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveInsightSources } from "../lib/ai/executive-summary";

const inputs = [
  { title: "8月LPR保持不变，今年房贷还能否下调？", summary: "LPR 不变但下调预期升温。", url: "https://a/lpr" },
  { title: "黄金，多极时代的新底仓？", summary: "黄金避险需求上升。", url: "https://a/gold" },
];

test("相关洞察回链到正确来源，无关洞察不挂来源", () => {
  const r = resolveInsightSources("房贷下调预期", "LPR下调预期影响按揭客户行为。", "动态调整房贷定价。", inputs);
  assert.equal(r.length, 1, "房贷洞察应命中 1 条");
  assert.equal(r[0].url, "https://a/lpr", "命中 LPR 政策原文");
  assert.equal(resolveInsightSources("AI芯片突破", "算力提升", "关注。", inputs).length, 0, "无关不挂来源");
});

test("无 url 的输入不参与回链", () => {
  const r = resolveInsightSources("房贷下调预期", "x", "y", [
    { title: "8月LPR保持不变今年房贷还能否下调", summary: "s", url: "" },
  ]);
  assert.equal(r.length, 0);
});

test("多来源时按相似度取前 3 条", () => {
  const pool = [
    { title: "南沙金融30条落地", summary: "利好对公", url: "https://n/1" },
    { title: "南沙跨境结算试点", summary: "跨境", url: "https://n/2" },
    { title: "南沙自贸区扩区", summary: "扩区", url: "https://n/3" },
    { title: "南沙人才政策", summary: "人才", url: "https://n/4" },
    { title: "黄金避险", summary: "避险", url: "https://a/gold" },
  ];
  const r = resolveInsightSources("南沙金融利好对公", "对公存款迎窗口", "加大营销", pool);
  assert.ok(r.length >= 1 && r.length <= 3, "来源数在 1-3");
  assert.ok(r.every((s) => s.url.startsWith("https://n/")), "仅命中南沙相关来源");
});

test("改写表述的单源洞察也能回链（共享 bigram 门槛接住）", () => {
  const pool = [
    { title: "存1年=存2年=存3年，存款利率罕见“持平”", summary: "长期限存款利率出现倒挂后的拉平。", url: "https://a/deposit-flat" },
    { title: "30个托位、12月龄即可入托！广州南沙普惠托育园", summary: "托育。", url: "https://a/tuoyu" },
  ];
  // 「存款利率期限拉平」与「存1年=存2年=存3年，存款利率罕见持平」同主题但措辞改写
  const hit = resolveInsightSources("存款利率期限拉平", "长期限存款定价趋同", "关注存款流失", pool);
  assert.equal(hit.length, 1, "应命中存款利率原文（单源）");
  assert.equal(hit[0].url, "https://a/deposit-flat");
  // 共享 bigram 门槛必须挡掉完全无关（托育园）的错源
  const wrong = resolveInsightSources("小微融资协调机制升级", "影响普惠客群", "加大投放", pool);
  assert.equal(wrong.length, 0, "无任何共享字符片段→不臆造错源");
});

