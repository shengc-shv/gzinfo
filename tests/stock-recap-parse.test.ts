/**
 * 股市复盘「分级解析降级」+ 提示词压缩（2026-09-05 #147 实锤修复）
 *
 * 现象：CI 早间一次发布，日志 `[recap] ... Colon expected at position 891`
 *      —— LLM 输出被截断/结构损坏 → 原实现「整体 JSON.parse → jsonrepair
 *      → 一失败就 return null」，把**已经完整生成的市场（含 sectors 板块）一起丢掉**，
 *      页面只剩指数合成的 overview，即用户看到的「股市板块没有数据」。
 * 修复：分四级抢救（整体 → jsonrepair → 逐市场平衡括号 → 逐市场字段正则），
 *      全失败才降级为行情指数合成三卡。同时把三市场重复表述的提示词
 *      从 ~2.8k 字压到 ~1k 字，降低输入体积与输出被截断概率。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseRecapLoose,
  extractBalancedObject,
  salvageMarketByFields,
  RECAP_RULES,
} from "../lib/ai/stock-recap";

const US = `"us":{"overview":"美股三大指数集体收涨","sectors":["半导体：英伟达财报后大涨","能源：油价回落走弱"],"spoken":"美股集体收涨，半导体领涨。"}`;
const ASHARE = `"aShare":{"overview":"A股沪指涨0.53%","sectors":["贵金属：避险需求走强"],"spoken":"A股沪指涨0.53%，贵金属走强。"}`;
const HK = `"hk":{"overview":"恒指收报18234点，跌0.62%","sectors":["内房股：龙湖跌3%"],"spoken":"恒指收报18234点。"}`;

const GOOD = `{${US},${ASHARE},${HK}}`;
/** #147 形态：hk 的 spoken 写到一半被截断，括号未闭合 */
const TRUNCATED = `{${US},${ASHARE},"hk":{"overview":"恒指收报18234点，跌0.62%","sectors":["内房股：龙湖跌3%"],"spoken":"恒指收`;
/** 未转义双引号（裸 "科技股领涨"）→ JSON.parse 报 Colon expected */
const UNESCAPED = `{"us":{"overview":"美股集体收涨，纳指涨1.2%"科技股领涨"","sectors":["半导体：英伟达财报后大涨"],"spoken":"美股集体收涨。"},${ASHARE},${HK}}`;

test("① 正常 JSON：三市场齐全", async () => {
  const r = await parseRecapLoose(GOOD);
  const hk = r?.hk as { sectors: string[] };
  assert.equal((r?.us as { overview: string }).overview, "美股三大指数集体收涨");
  assert.deepEqual(hk.sectors, ["内房股：龙湖跌3%"]);
});

test("② 输出截断（#147 形态）：已生成市场的 sectors 必须被救回，不整包丢弃", async () => {
  const r = await parseRecapLoose(TRUNCATED);
  assert.ok(r, "截断文本不得整体返回 null");
  const us = r!.us as { overview: string; sectors: string[] };
  const hk = r!.hk as { overview: string; sectors: string[] };
  assert.deepEqual(us.sectors, ["半导体：英伟达财报后大涨", "能源：油价回落走弱"], "美股板块应保留");
  assert.deepEqual(hk.sectors, ["内房股：龙湖跌3%"], "港股板块应保留");
  assert.match(hk.overview, /恒指收报18234点/);
});

test("③ 未转义引号（Colon expected 类）：解析不抛错且内容不丢", async () => {
  const r = await parseRecapLoose(UNESCAPED);
  assert.ok(r);
  const us = r!.us as { overview: string; sectors: string[] };
  assert.match(us.overview, /美股集体收涨/);
  assert.deepEqual(us.sectors, ["半导体：英伟达财报后大涨"]);
  assert.ok(r!.aShare, "后续市场不应被连带丢弃");
});

test("④ 完全非 JSON：返回 null，交由上层降级为指数合成三卡", async () => {
  assert.equal(await parseRecapLoose("抱歉，我无法生成该 JSON。"), null);
});

test("extractBalancedObject：括号未闭合返回 null（表示该市场正好被截断）", () => {
  assert.equal(extractBalancedObject(TRUNCATED, "hk"), null);
  assert.ok(extractBalancedObject(TRUNCATED, "us"), "us 平衡可提取");
});

test("salvageMarketByFields：从截断片段救回 overview + sectors", () => {
  const hk = salvageMarketByFields(TRUNCATED, "hk") as { overview: string; sectors: string[] };
  assert.equal(hk.overview, "恒指收报18234点，跌0.62%");
  assert.deepEqual(hk.sectors, ["内房股：龙湖跌3%"]);
  // 字段级抢救对完整段同样可用（us 段能原样抓出三字段）
  const us = salvageMarketByFields(TRUNCATED, "us") as { overview: string; sectors: string[] };
  assert.equal(us.overview, "美股三大指数集体收涨");
  assert.equal(us.sectors.length, 2);
});

test("提示词压缩：三市场规则只说一遍，长度锁上限（防回退膨胀）", () => {
  assert.ok(
    RECAP_RULES.length < 1400,
    `RULES 应保持在 1.4k 字以内（当前 ${RECAP_RULES.length}），三市场不得各重复一遍规则`,
  );
  // 「港股」专属块只允许出现在一处附加规则里，不得散落重复
  const hkMentions = [...RECAP_RULES.matchAll(/港股/g)].length;
  assert.ok(hkMentions <= 3, `港股相关表述应集中，当前出现 ${hkMentions} 次`);
});
