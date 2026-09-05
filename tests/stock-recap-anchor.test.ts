/**
 * 收评锚定回归测试（2026-09-05 用户拍板）。
 *
 * 需求：A股/港股的板块总结与口播素材「直接从新浪等权威源的收评拿来用」，
 * 不再让 LLM 从 12 条新闻标题里猜；且**收评必须与页面展示的收盘日数据同一天**
 * （用户：二者是绑定的，不要独立去捞）。
 *
 * 覆盖：
 *  1. isRecapTitle：收评/盘后/复盘命中；午评/早盘（盘中快照）必须排除
 *  2. splitClauses：顿号用于并列、不切碎（「培育钻石、保险、贵金属板块表现活跃」）
 *  3. pickRecapAnchor：发布日 === 行情取值日才锚定；无行情日 → undefined 回退 LLM
 *  4. pickRecapAnchor：全市场收评优先于板块级「收盘播报」
 *  5. parseRecapCard：术语展开（科指→恒生科技指数）、overview 用行情权威数字
 *  6. parseRecapCard：营销噪声 / 截断残片 → null（宁缺毋滥，回退 LLM）
 *  7. 集成：A股+港股均锚定 → LLM 收到的 prompt 不含 aShare/hk 条目（根除跨市场串味）
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  anchorRecapCard,
  extractIndexPcts,
  hasIndexConflict,
  isRecapTitle,
  parseRecapCard,
  pickRecapAnchor,
  splitClauses,
} from "../lib/ai/stock-recap-anchor";
import type { StockItem } from "../lib/ai/stock-recap";
import type { IndexQuote } from "../lib/sources/quote-api";

const mk = (title: string, publishedAt: string, url?: string): StockItem => ({
  title,
  publishedAt,
  url,
});

const HK_QUOTES: IndexQuote[] = [
  { name: "恒生指数", value: "25650.10", changePct: "+1.74%" },
  { name: "恒生科技", value: "5820.33", changePct: "+2.27%" },
];

test("isRecapTitle：收评/盘后/复盘命中，午评/早盘排除", () => {
  assert.equal(isRecapTitle("港股收评：恒指涨1.74%"), true);
  assert.equal(isRecapTitle("收评：三大指数集体收跌"), true);
  assert.equal(isRecapTitle("盘后观察：8月收官战"), true);
  assert.equal(isRecapTitle("资金复盘 | 北水净买入港股近41亿港元"), true);
  // 盘中快照不是收盘数据，绝不能拿来配收盘数字
  assert.equal(isRecapTitle("港股午评：恒指跌1%"), false);
  assert.equal(isRecapTitle("早盘播报：三大指数高开"), false);
});

test("splitClauses：顿号并列不被切碎", () => {
  const out = splitClauses("收评：三大指数小幅收涨，培育钻石、保险、贵金属板块表现活跃");
  assert.deepEqual(out, ["三大指数小幅收涨", "培育钻石、保险、贵金属板块表现活跃"]);
});

test("pickRecapAnchor：只锚定发布日 === 行情取值日的收评", () => {
  const pool = [
    mk("港股收评：恒指跌0.93% 科指跌1.49% 科网股走弱 内银股逆势活跃", "2026-09-01"),
    mk("港股收评：恒指跌0.07% 科指跌0.74% 科网股走弱 中资券商股普跌", "2026-09-02"),
  ];
  assert.equal(pickRecapAnchor(pool, "2026-09-02")?.publishedAt, "2026-09-02");
  assert.equal(pickRecapAnchor(pool, "2026-09-01")?.publishedAt, "2026-09-01");
  // 无该日收评 → 回退 LLM（不拿错日期的收评配今天的收盘数字）
  assert.equal(pickRecapAnchor(pool, "2026-08-30"), undefined);
  // 无行情取值日 → 无法绑定，同样回退 LLM
  assert.equal(pickRecapAnchor(pool, undefined), undefined);
});

test("pickRecapAnchor：全市场收评优先于板块级收盘播报", () => {
  const pool = [
    mk("科创板收盘播报：科创综指跌2.35% 半导体股多数下跌", "2026-09-01"),
    mk("收评：三大指数集体收跌，超3900只个股飘绿，军工板块逆势爆发", "2026-09-01"),
  ];
  assert.match(pickRecapAnchor(pool, "2026-09-01")?.title ?? "", /三大指数集体收跌/);
});

test("parseRecapCard：术语展开 + overview 用行情权威数字", () => {
  const card = parseRecapCard(
    mk("港股收评：恒指涨1.74% 科指涨2.27% 科网股普涨 AI应用股走强 联想涨超6%", "2026-09-04"),
    HK_QUOTES,
  );
  assert.ok(card);
  assert.deepEqual(card!.sectors, [
    "恒生指数涨1.74%",
    "恒生科技指数涨2.27%",
    "科网股普涨",
    "AI应用股走强",
    "联想涨超6%",
  ]);
  // overview 与卡内指数块同源，非 LLM 复述
  assert.equal(card!.overview, "恒生指数收报25650.10点（+1.74%）；恒生科技收报5820.33点（+2.27%）。");
});

test("parseRecapCard：无行情时 overview 退回收评首段", () => {
  const card = parseRecapCard(
    mk("收评：科创50指数高开低走跌2.10%，算力产业链持续下挫，猪肉板块逆势走强", "2026-09-04"),
  );
  assert.ok(card);
  assert.equal(card!.overview, "科创50指数高开低走跌2.10%");
  assert.equal(card!.sectors.length, 3);
});

test("parseRecapCard：营销噪声与截断残片 → null（回退 LLM）", () => {
  // 营销号：堆 6 位代码 + 多感叹号
  assert.equal(
    parseRecapCard(mk("A股，主力进场了！002938盘后突发利好！600127！12天7涨停……", "2026-09-01")),
    null,
  );
  // 爬虫截断：「半导体股多」= 原文「多数下跌」被截断
  assert.equal(
    parseRecapCard(mk("科创板收盘播报：科创综指跌2.35% 半导体股多", "2026-09-01")),
    null,
  );
  // 有效要点不足 2 条
  assert.equal(parseRecapCard(mk("盘后观察：8月收官战", "2026-08-31")), null);
});

test("extractIndexPcts：识别指数涨跌幅（句尾方向词为准）", () => {
  const pcts = extractIndexPcts([
    "恒生指数涨1.74%",
    "恒生科技指数跌0.74%",
    "科创50指数高开低走跌2.10%", // 「高开」在前、「跌」在后 → 取跌
  ]);
  assert.deepEqual(pcts, [
    { name: "恒生指数", pct: 1.74 },
    { name: "恒生科技指数", pct: -0.74 },
    { name: "科创50", pct: -2.1 },
  ]);
});

test("hasIndexConflict：行情取值日错位时以收评为真（09-03 实锤场景）", () => {
  // 收评（pub=09-02）：恒指跌0.07%；行情却给 -0.39%（晚间重跑拿到当天新收盘）
  const clauses = ["恒生指数跌0.07%", "恒生科技指数跌0.74%", "科网股走弱", "中资券商股普跌"];
  const stale: IndexQuote[] = [
    { name: "恒生指数", value: "25213.31", changePct: "-0.39%" },
    { name: "恒生科技", value: "4468.48", changePct: "-1.08%" },
  ];
  assert.equal(hasIndexConflict(clauses, stale), true);
  const card = parseRecapCard(mk("港股收评：恒指跌0.07% 科指跌0.74% 科网股走弱 中资券商股普跌", "2026-09-02"), stale);
  assert.ok(card);
  // 不再输出与 sectors 矛盾的 -0.39%
  assert.equal(card!.overview, "恒生指数跌0.07%，恒生科技指数跌0.74%。");
  // 数字一致时（正常日）不触发
  assert.equal(hasIndexConflict(["恒生指数涨1.74%", "恒生科技指数涨2.27%"], HK_QUOTES), false);
});

test("anchorRecapCard：端到端（日期不匹配时回退）", () => {
  const pool = [mk("港股收评：恒指跌0.93% 科指跌1.49% 科网股走弱 内银股逆势活跃", "2026-09-01")];
  assert.ok(anchorRecapCard(pool, { date: "2026-09-01", list: HK_QUOTES }));
  assert.equal(anchorRecapCard(pool, { date: "2026-09-04", list: HK_QUOTES }), null);
});

test("集成：A股+港股锚定后，LLM prompt 不再含 aShare/hk 条目（根除跨市场串味）", async () => {
  let capturedPrompt = "";
  mock.module("../lib/ai/llm.ts", {
    namedExports: {
      runLlm: async (req: { userPrompt: string }) => {
        capturedPrompt = req.userPrompt;
        return {
          text: JSON.stringify({
            us: { overview: "美股三大指数收跌", sectors: ["特斯拉跌近6%"], spoken: "" },
          }),
        };
      },
    },
  });
  const { generateStockRecap } = await import("../lib/ai/stock-recap");
  const recap = await generateStockRecap(
    {
      date: "2026-09-05",
      us: [mk("Tesla stock drops 6%", "2026-09-04")],
      aShare: [
        mk("收评：科创50指数高开低走跌2.10%，算力产业链持续下挫，猪肉板块逆势走强", "2026-09-04"),
      ],
      hk: [mk("港股收评：恒指涨1.74% 科指涨2.27% 科网股普涨 联想涨超6%", "2026-09-04")],
    },
    {
      date: "2026-09-04",
      channel: "新浪行情",
      quotes: {
        aShare: [{ name: "上证指数", value: "3812.51", changePct: "-0.45%" }],
        hk: HK_QUOTES,
        us: [{ name: "道琼斯", value: "45544.88", changePct: "-0.20%" }],
      },
    },
  );
  assert.ok(recap);
  // A股/港股走锚定，不进 prompt
  assert.ok(!capturedPrompt.includes("算力产业链"), "A股条目不应出现在 prompt 中");
  assert.ok(!capturedPrompt.includes("科网股"), "港股条目不应出现在 prompt 中");
  assert.ok(capturedPrompt.includes("本轮只需生成：美股"), "应只生成美股");
  // 锚定结果落地
  assert.equal(recap!.aShare.sectors.length, 3);
  assert.equal(recap!.hk.sectors[0], "恒生指数涨1.74%");
  // 美股仍由 LLM 产出
  assert.equal(recap!.us.overview, "美股三大指数收跌");
  mock.reset();
});
