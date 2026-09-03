/**
 * 股市口播「整体行情—结构分化—重点板块」确定性拼装测试。
 *
 * 覆盖 2026-09-03 用户 5 条要求：
 *   1. 板块按重要性/关注度排序（资金流向 > 涨跌方向 > 数字 > 原因）
 *   2. 三段式叙述（大盘 → 过渡句 → 板块）
 *   3. 口语化、只留关键指标（去重「板块」、截断长句）
 *   4. 预算自适应（总时长 3:00~3:30 由 audio.ts 分配，本模块只负责不超预算）
 *   5. 无效板块跳过（空描述 / 空洞套话 / 与大盘重复）
 *   6. maxSectors 上限（2026-09-03 晚间：生产传 2，每市场只详述打分最高 2 板块）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSectorLine,
  scoreSector,
  selectSectors,
  pickTransition,
  similarity,
  buildMarketSpoken,
  buildStockSpoken,
  type MarketKey,
} from "../lib/audio/stock-spoken";
import type { MarketCard, StockRecap } from "../lib/types";

/** 构造一张市场卡。 */
function mkCard(overview: string, sectors: string[]): MarketCard {
  return { overview, sectors };
}

const A_OVERVIEW = "三大指数缩量收跌，沪指跌0.97%、深成指跌1.88%、创业板跌2.39%。";

// ——— 1. 板块解析 ———

test("parseSectorLine：按首个「：」拆分为板块名与描述", () => {
  const r = parseSectorLine("半导体：英伟达财报后大涨");
  assert.equal(r?.name, "半导体");
  assert.equal(r?.desc, "英伟达财报后大涨");
});

test("parseSectorLine：无分隔符时整段作为描述", () => {
  const r = parseSectorLine("贵金属板块整体走强");
  assert.equal(r?.name, "");
  assert.equal(r?.desc, "贵金属板块整体走强");
});

test("parseSectorLine：描述过短视为数据不足 → 跳过", () => {
  assert.equal(parseSectorLine("房地产：走弱"), null, "2 字描述不足以支撑，应跳过");
  assert.equal(parseSectorLine(""), null);
  assert.equal(parseSectorLine("   "), null);
});

test("parseSectorLine：清洗 Markdown 与链接", () => {
  const r = parseSectorLine("新能源：https://x.com/a 装机量超预期 **大增**");
  assert.ok(r?.desc.includes("装机量超预期"));
  assert.ok(!r?.desc.includes("http"), "链接应被剥离");
  assert.ok(!r?.desc.includes("*"), "Markdown 符号应被剥离");
});

// ——— 2. 打分排序（用户要求 1：按重要性与市场关注度排序）———

test("scoreSector：资金流向权重最高，优于普通涨跌描述", () => {
  const fund = scoreSector("南向资金", "北水净买入近41亿港元，加仓友邦超9亿");
  const plain = scoreSector("消费", "板块小幅波动");
  assert.ok(fund > plain, `资金流(${fund}) 应高于泛泛描述(${plain})`);
});

test("scoreSector：空洞套话 → 淘汰（负分）", () => {
  assert.ok(scoreSector("港股", "多家公司密集披露年报") < 0);
  assert.ok(scoreSector("市场", "整体平稳，交投清淡") < 0);
});

test("scoreSector：纯展望建议降权，但不淘汰", () => {
  const advice = scoreSector("配置", "中信建议关注稳健运营资产的超跌机会");
  const fact = scoreSector("AI算力", "中金称开源模型带动云厂商需求增长");
  assert.ok(advice >= 0, "建议类仍是有内容，不淘汰");
  assert.ok(advice < fact, "建议类应排在事实类之后");
});

test("selectSectors：按分数降序，资金流向类排到最前", () => {
  const lines = selectSectors(
    [
      "消费：板块小幅波动",
      "南向资金：北水净买入近41亿港元，加仓友邦超9亿",
      "科网股：恒科跌0.74%拖累科网板块集体走弱",
    ],
    "恒指收报25275点跌0.22%",
  );
  assert.ok(lines.length >= 2);
  assert.ok(
    lines[0].text.includes("南向资金"),
    `资金流向应排第一，实际首条：${lines[0].text}`,
  );
  for (let i = 1; i < lines.length; i++) {
    assert.ok(lines[i - 1].score >= lines[i].score, "应保持降序");
  }
});

test("selectSectors：同分时保持卡片原顺序（不打乱 LLM 的强弱排列）", () => {
  const lines = selectSectors(["甲：涨1%领涨两市", "乙：跌2%领跌两市"], "");
  assert.deepEqual(
    lines.map((l) => l.name),
    ["甲", "乙"],
  );
});

// ——— 3. 跳过无效板块（用户要求 5）———

test("selectSectors：跳过空描述 / 太短 / 空洞套话", () => {
  const lines = selectSectors(
    ["空板块：", "太短：走弱", "套话：多家公司密集披露年报", "正常：受政策提振，板块大涨3%"],
    A_OVERVIEW,
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0].text.includes("正常"));
});

test("selectSectors：与大盘高度重复的板块跳过（用户要求 4：控制冗余）", () => {
  const overview = "地面兵装板块逆市大涨，成盘面最强主线";
  const dup = "地面兵装：逆市大涨，成盘面最强主线";
  assert.ok(similarity("逆市大涨，成盘面最强主线", overview) >= 0.5, "前置：确实判定为重复");
  const lines = selectSectors([dup, "AI算力：中金称开源模型带动需求增长"], overview);
  assert.equal(lines.length, 1, "重复项应被跳过");
  assert.ok(lines[0].text.includes("AI算力"));
});

test("selectSectors：尊重 maxSectors 上限", () => {
  const many = Array.from({ length: 8 }, (_, i) => `板块${i}：受利好刺激大涨${i}%`);
  assert.equal(selectSectors(many, "", 2).length, 2);
});

test("selectSectors：完全重复的文本只保留一条", () => {
  const lines = selectSectors(["半导体：业绩超预期大涨", "半导体：业绩超预期大涨"], "");
  assert.equal(lines.length, 1);
});

// ——— 4. 口语化：消除「板块」同句重复 ———

test("selectSectors：名称已带「板块」时，清掉描述里重复的「板块」", () => {
  const [line] = selectSectors(["中资券商：板块普遍下跌，成为盘面主要拖累"], "");
  assert.equal(line.text, "中资券商板块，普遍下跌，成为盘面主要拖累");
  assert.equal(line.text.match(/板块/g)?.length, 1, "整句只应出现一次「板块」");
});

test("selectSectors：名称为「XX股/资金」时不补后缀，描述里的「板块」保留", () => {
  const [line] = selectSectors(["科网股：恒科跌0.74%，板块整体走弱拖累大市"], "");
  assert.ok(line.text.startsWith("科网股，"), `实际：${line.text}`);
  assert.ok(line.text.includes("板块整体走弱"), "描述中的「板块」是必要主语，不应删");
});

test("selectSectors：清洗后无内容则跳过", () => {
  const lines = selectSectors(["某板块：板块"], "");
  assert.equal(lines.length, 0);
});

// ——— 5. 过渡句（用户要求 2：自然串联）———

test("pickTransition：有强有弱 → 强调分化", () => {
  const lines = selectSectors(["甲：领涨两市大涨3%", "乙：领跌两市大跌2%"], "");
  assert.ok(pickTransition(lines).includes("分化"));
});

test("pickTransition：只有强势 → 领涨方向", () => {
  const lines = selectSectors(["甲：主力净买入，大涨3%领涨", "乙：受财报提振走强2%"], "");
  const t = pickTransition(lines);
  assert.ok(!t.includes("分化") && !t.includes("拖累"), `实际：${t}`);
});

test("pickTransition：只有弱势 → 拖累来源", () => {
  const lines = selectSectors(["甲：领跌两市大跌3%", "乙：承压走弱2%"], "");
  assert.ok(pickTransition(lines).includes("拖累") || pickTransition(lines).includes("走弱"));
});

test("pickTransition：变体轮换，连续三个市场过渡语互不相同", () => {
  const lines = selectSectors(["甲：领涨两市大涨3%", "乙：领跌两市大跌2%"], "");
  const a = pickTransition(lines, 0);
  const b = pickTransition(lines, 1);
  const c = pickTransition(lines, 2);
  assert.equal(new Set([a, b, c]).size, 3, `三句应互不相同：${a} / ${b} / ${c}`);
});

// ——— 6. 单市场三段式拼装（用户要求 2）———

test("buildMarketSpoken：输出为「大盘。过渡句：板块；板块。」三段式", () => {
  const out = buildMarketSpoken(
    mkCard(A_OVERVIEW, [
      "地面兵装：主力1.81亿大单封板，逆市爆发",
      "债市关联：全球长债抛售加剧，扰动风险偏好",
    ]),
    { budget: 200 },
  );
  assert.ok(out.startsWith(A_OVERVIEW.slice(0, 10)), "应以大盘行情开头");
  assert.ok(out.endsWith("。"));
  assert.ok(/。[^。：]{4,20}：/.test(out), `大盘后应有过渡句，实际：${out}`);
  assert.ok(out.includes("地面兵装板块"), "应含板块要点");
});

test("buildMarketSpoken：无板块时只念大盘，不生硬补充", () => {
  const out = buildMarketSpoken(mkCard(A_OVERVIEW, []), { budget: 200 });
  assert.equal(out, `${A_OVERVIEW.slice(0, -1)}。`);
});

test("buildMarketSpoken：overview 为空 → 整段跳过", () => {
  assert.equal(buildMarketSpoken(mkCard("", ["甲：大涨3%"]), { budget: 200 }), "");
  assert.equal(buildMarketSpoken(mkCard("   ", []), { budget: 200 }), "");
});

test("buildMarketSpoken：预算不足时按序舍弃板块，绝不超预算", () => {
  const sectors = [
    "甲：主力净买入10亿，大涨3%领涨两市",
    "乙：受财报提振，板块走强2%",
    "丙：政策预期落空，板块领跌2%",
  ];
  for (const budget of [60, 100, 150, 300]) {
    const out = buildMarketSpoken(mkCard(A_OVERVIEW, sectors), { budget });
    assert.ok(
      out.length <= budget,
      `预算 ${budget} 时输出 ${out.length} 字，超预算`,
    );
    assert.ok(out.includes("沪指"), "再紧也要保住大盘行情");
  }
});

test("buildMarketSpoken：预算极小（连大盘都放不下）时截断大盘而非丢弃", () => {
  const out = buildMarketSpoken(mkCard(A_OVERVIEW, ["甲：大涨3%领涨"]), { budget: 25 });
  assert.ok(out.length > 0 && out.length <= 26, `实际 ${out.length} 字：${out}`);
});

test("buildMarketSpoken：labelChars 计入预算，标签不吃掉板块额度", () => {
  const card = mkCard(A_OVERVIEW, ["甲：主力净买入10亿，大涨3%领涨两市"]);
  const noLabel = buildMarketSpoken(card, { budget: 140 });
  const withLabel = buildMarketSpoken(card, { budget: 140, labelChars: 24 });
  assert.ok(withLabel.length <= noLabel.length, "有标签前缀时正文应更短");
  assert.ok(noLabel.includes("主力净买入"), "无标签时板块应能进来");
});

// ——— 7. 跨市场预算分配 ———

function mkRecap(a: MarketCard, h: MarketCard, u: MarketCard): StockRecap {
  return { us: u, aShare: a, hk: h };
}

const HK_OVERVIEW = "恒指收报25275点跌0.22%，科指跌0.83%，科网股走弱。";
const US_OVERVIEW = "三大指数集体收涨，道指涨0.56%、纳指涨0.45%。";

/** 每市场 4 条板块，用于验证轮转分配。 */
const FOUR = [
  "甲板块：主力资金净买入10亿，大涨3%领涨两市",
  "乙板块：受财报提振，板块走强2.5%",
  "丙板块：政策预期落空，板块领跌2%",
  "丁板块：成交放大，北向加仓超5亿",
];

test("buildStockSpoken：顺序为 A股 → 港股 → 美股，且总字数不超预算", () => {
  const r = buildStockSpoken(
    mkRecap(mkCard(A_OVERVIEW, FOUR), mkCard(HK_OVERVIEW, FOUR), mkCard(US_OVERVIEW, FOUR)),
    { budget: 400 },
  );
  const total = r.texts.aShare.length + r.texts.hk.length + r.texts.us.length;
  assert.ok(total <= 400, `总字数 ${total} 超过预算 400`);
  assert.ok(r.chars <= 400);
  for (const k of ["aShare", "hk", "us"] as MarketKey[]) {
    assert.ok(r.texts[k].length > 0, `${k} 应有内容`);
  }
});

test("buildStockSpoken：A股优先 —— 预算紧张时 A股板块数不少于美股", () => {
  const r = buildStockSpoken(
    mkRecap(mkCard(A_OVERVIEW, FOUR), mkCard(HK_OVERVIEW, FOUR), mkCard(US_OVERVIEW, FOUR)),
    { budget: 260 },
  );
  assert.ok(
    r.sectorCounts.aShare >= r.sectorCounts.us,
    `A股(${r.sectorCounts.aShare}) 应 ≥ 美股(${r.sectorCounts.us})`,
  );
});

test("buildStockSpoken：预算充足时尽可能纳入板块要点", () => {
  const r = buildStockSpoken(
    mkRecap(mkCard(A_OVERVIEW, FOUR), mkCard(HK_OVERVIEW, FOUR), mkCard(US_OVERVIEW, FOUR)),
    { budget: 900 },
  );
  const sum = r.sectorCounts.aShare + r.sectorCounts.hk + r.sectorCounts.us;
  assert.equal(sum, 12, `预算充足时应纳入全部 12 条，实际 ${sum}`);
});

test("buildStockSpoken：maxSectors=2 → 每市场只详述打分最高 2 板块（2026-09-03 晚间压缩）", () => {
  // 对应 audio.ts 生产调用 maxSectors: 2。FOUR 打分：甲(资金流+大涨)与丁(资金流+加仓)同为最高，
  // 丙(领跌 8 分)排最末 → 截断后丙不得进入口播正文；卡面 sectors 3-5 条展示不受此函数影响。
  const r = buildStockSpoken(
    mkRecap(mkCard(A_OVERVIEW, FOUR), mkCard(HK_OVERVIEW, FOUR), mkCard(US_OVERVIEW, FOUR)),
    { budget: 900, maxSectors: 2 },
  );
  assert.deepEqual(
    { a: r.sectorCounts.aShare, h: r.sectorCounts.hk, u: r.sectorCounts.us },
    { a: 2, h: 2, u: 2 },
    `maxSectors=2 时每市场应恰纳入 2 条：A${r.sectorCounts.aShare}/H${r.sectorCounts.hk}/U${r.sectorCounts.us}`,
  );
  for (const k of ["aShare", "hk", "us"] as MarketKey[]) {
    assert.ok(r.texts[k].includes("甲板块"), `${k} 应保留打分最高的板块（甲板块），实际：${r.texts[k]}`);
    assert.ok(
      !r.texts[k].includes("丙板块"),
      `${k} 不应出现打分最低的第三条板块「丙板块」`,
    );
  }
});

test("buildStockSpoken：无有效板块的市场只念大盘，不影响其他市场", () => {
  const r = buildStockSpoken(
    mkRecap(mkCard(A_OVERVIEW, []), mkCard(HK_OVERVIEW, FOUR), mkCard(US_OVERVIEW, [])),
    { budget: 500 },
  );
  assert.equal(r.sectorCounts.aShare, 0);
  assert.equal(r.sectorCounts.us, 0);
  assert.ok(r.sectorCounts.hk > 0, "港股有板块应正常纳入");
  assert.ok(r.texts.aShare.includes("沪指"), "无板块的市场仍要念大盘");
  assert.ok(!r.texts.aShare.includes("："), "无板块时不应出现过渡句冒号");
});

test("buildStockSpoken：某市场 overview 为空 → 整段跳过", () => {
  const r = buildStockSpoken(
    mkRecap(mkCard("", FOUR), mkCard(HK_OVERVIEW, FOUR), mkCard(US_OVERVIEW, FOUR)),
    { budget: 500 },
  );
  assert.equal(r.texts.aShare, "");
  assert.equal(r.sectorCounts.aShare, 0);
  assert.ok(r.texts.hk.length > 0);
});

test("buildStockSpoken：预算极小 → 三市场只念大盘且不超预算", () => {
  const r = buildStockSpoken(
    mkRecap(mkCard(A_OVERVIEW, FOUR), mkCard(HK_OVERVIEW, FOUR), mkCard(US_OVERVIEW, FOUR)),
    { budget: 60 },
  );
  const total = r.texts.aShare.length + r.texts.hk.length + r.texts.us.length;
  assert.ok(total <= 60, `实际 ${total} 字超预算 60`);
  assert.ok(r.texts.aShare.length > 0, "三个大盘都要保住");
  assert.equal(
    r.sectorCounts.aShare + r.sectorCounts.hk + r.sectorCounts.us,
    0,
    "预算不足时不应强行塞板块",
  );
});

test("buildStockSpoken：市场标签计入预算，标签变长时正文相应缩短", () => {
  const recap = mkRecap(
    mkCard(A_OVERVIEW, FOUR),
    mkCard(HK_OVERVIEW, FOUR),
    mkCard(US_OVERVIEW, FOUR),
  );
  const short = buildStockSpoken(recap, { budget: 400, labelChars: { aShare: 8, hk: 8, us: 8 } });
  const long = buildStockSpoken(recap, { budget: 400, labelChars: { aShare: 24, hk: 24, us: 24 } });
  const sumShort = short.texts.aShare.length + short.texts.hk.length + short.texts.us.length;
  const sumLong = long.texts.aShare.length + long.texts.hk.length + long.texts.us.length;
  assert.ok(sumLong < sumShort, `标签更长时正文应更短：${sumLong} vs ${sumShort}`);
});

test("buildStockSpoken：过渡语在三市场间不重复（预算足够时）", () => {
  const r = buildStockSpoken(
    mkRecap(mkCard(A_OVERVIEW, FOUR), mkCard(HK_OVERVIEW, FOUR), mkCard(US_OVERVIEW, FOUR)),
    { budget: 900 },
  );
  const transitions = ([["aShare", "A股"], ["hk", "港股"], ["us", "美股"]] as const).map(
    ([k]) => r.texts[k].match(/。(.{4,12}：)/)?.[1] ?? "",
  );
  assert.equal(
    new Set(transitions.filter(Boolean)).size,
    transitions.filter(Boolean).length,
    `过渡语重复：${transitions.join(" | ")}`,
  );
});

test("buildStockSpoken：recap 为 null/undefined → 空结果不抛错", () => {
  const r = buildStockSpoken(null, { budget: 400 });
  assert.equal(r.chars, 0);
  assert.equal(r.texts.aShare, "");
});

// ——— 8. 相似度工具 ———

test("similarity：完全相同的文本相似度为 1，无关文本接近 0", () => {
  assert.ok(similarity("地面兵装逆市大涨", "地面兵装逆市大涨") > 0.99);
  assert.ok(similarity("地面兵装逆市大涨", "南向资金净买入41亿") < 0.2);
  assert.equal(similarity("", "abc"), 0);
});
