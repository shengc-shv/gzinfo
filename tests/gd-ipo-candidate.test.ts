/**
 * 「广东企业 IPO 动态」内容判定（2026-08-30）单测：
 *  - isGdIpoCandidate：媒体源报道（粤芯注册生效）命中；普通政策/非广东企业不误伤。
 *  - detectGdIpo（播报兜底）：名单企业名命中的标题（无「广东/广州」字样）不再漏。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isGdIpoCandidate } from "../lib/output/render/cards";
import { detectGdIpo } from "../lib/audio/audio";

test("isGdIpoCandidate: 粤芯注册生效报道命中（名单企业名 + 阶段词，标题无广东/广州字样）", () => {
  assert.equal(
    isGdIpoCandidate("证监会同意粤芯半导体技术股份有限公司首次公开发行股票注册"),
    true,
  );
  assert.equal(isGdIpoCandidate("粤芯半导体：注册生效，拟登陆创业板"), true);
  assert.equal(isGdIpoCandidate("小鹏汽车：港股IPO上市首日", "小鹏汽车敲钟上市"), true);
});

test("isGdIpoCandidate: 广东城市词 + IPO 阶段词命中", () => {
  assert.equal(isGdIpoCandidate("广州企业珠江实业拟IPO上市辅导备案"), true);
  assert.equal(isGdIpoCandidate("广东企业再添IPO：深圳某公司提交注册"), true);
});

test("isGdIpoCandidate: 普通政策/活动新闻不误伤（无阶段强词）", () => {
  // 泛化「上市/IPO」裸词不进（刻意排除「上市培育/IPO 培训」类政务活动）
  assert.equal(isGdIpoCandidate("广州召开企业上市培育工作会议"), false);
  assert.equal(isGdIpoCandidate("广州市举办IPO培训讲座"), false);
  // 非广东企业 IPO 不进
  assert.equal(isGdIpoCandidate("宁德时代提交创业板注册申请"), false);
  assert.equal(isGdIpoCandidate("贵州茅台拟IPO"), false);
  // 广东企业但非 IPO 事件不进
  assert.equal(isGdIpoCandidate("比亚迪发布2026年半年报"), false);
});

test("detectGdIpo: 名单企业名命中的标题（无广东/广州字样）能捞到播报线索", () => {
  const items = [
    { title_cn: "粤芯半导体：注册申请材料已受理（拟创业板）", summary: "东财在审表更新" },
    { title_cn: "非广东企业IPO动态", summary: "某某全国企业" },
  ];
  const clues = detectGdIpo(items as never);
  assert.equal(clues.length, 1);
  assert.ok(clues[0].includes("粤芯半导体"));
});

test("detectGdIpo: 空输入 → 空线索", () => {
  assert.deepEqual(detectGdIpo([]), []);
});
