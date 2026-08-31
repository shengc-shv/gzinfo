/**
 * 股市解读层 功能测试（2026-08-31 港股口播质量整改 + 2026-09-01 股市板块初始化修复）
 *
 * - rankHkStockItems 排序策略：收评/复盘类（大盘综合报道）最前，
 *   具体公司/板块/资金动态其次，空泛披露类与披露易公告流压后——
 *   保证 slice(0,12) 截断后 LLM 优先看到有信息量的港股条目，
 *   不再让「多家公司披露年报」「密集披露」类栏目套话占据输入主体。
 * - synthesizeRecapFromQuotes（2026-09-01 修）：SKIP_AI 无 store / AI 失败时，
 *   用行情指数合成最小复盘三卡，杜绝股市解读区整区不渲染。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rankHkStockItems,
  synthesizeRecapFromQuotes,
  type StockItem,
} from "../lib/ai/stock-recap";

const mk = (partial: Partial<StockItem> & { title: string }): StockItem => ({
  summary: "",
  url: "",
  source: "新浪港股",
  publishedAt: "2026-08-31",
  ...partial,
});

test("rankHkStockItems：收评类最前、具体动态其次、空泛披露/公告流压后", () => {
  const items = [
    mk({ title: "多家公司披露年报", publishedAt: "2026-08-31T10:00:00" }),
    mk({ title: "恒指收评：恒指收报18234点 内房股领跌", publishedAt: "2026-08-31T16:30:00" }),
    mk({ title: "美团绩后涨3% 南向资金净流入78亿", publishedAt: "2026-08-31T14:00:00" }),
    mk({ title: "XX Corp Annual Results", source: "港交所披露易", publishedAt: "2026-08-31T09:00:00" }),
  ];
  const ranked = rankHkStockItems(items);
  // ① 收评类排第 1
  assert.equal(ranked[0].title, "恒指收评：恒指收报18234点 内房股领跌");
  // ② 具体公司/资金动态（评分 2）在空泛披露（评分 1）之前
  assert.ok(
    ranked.indexOf(items[2]) < ranked.indexOf(items[0]),
    "具体动态条目应排在「多家公司披露年报」之前",
  );
  // ③ 公告流（港交所披露易）压到最后
  assert.equal(ranked[ranked.length - 1].title, "XX Corp Annual Results");
});

test("rankHkStockItems：同类条目按 publishedAt 降序（最新在前）", () => {
  const items = [
    mk({ title: "港股通资金流向（早）", publishedAt: "2026-08-31T09:00:00" }),
    mk({ title: "港股通资金流向（晚）", publishedAt: "2026-08-31T15:00:00" }),
    mk({ title: "港股通资金流向（午）", publishedAt: "2026-08-31T12:00:00" }),
  ];
  const ranked = rankHkStockItems(items);
  assert.deepEqual(
    ranked.map((i) => i.title),
    ["港股通资金流向（晚）", "港股通资金流向（午）", "港股通资金流向（早）"],
  );
});

test("rankHkStockItems：原数组不被修改（纯函数）", () => {
  const items = [
    mk({ title: "多家公司披露年报" }),
    mk({ title: "恒指收评：恒指收报18234点" }),
  ];
  const before = items.map((i) => i.title);
  rankHkStockItems(items);
  assert.deepEqual(
    items.map((i) => i.title),
    before,
  );
});

test("synthesizeRecapFromQuotes：三市场指数齐备 → 三卡均合成非空复盘", () => {
  const quotes = {
    channel: "新浪行情",
    date: "2026-08-31",
    quotes: {
      aShare: [
        { name: "上证指数", value: "3986.30", changePct: "+0.86%" },
        { name: "深证成指", value: "14015.00", changePct: "+0.44%" },
      ],
      hk: [{ name: "恒生指数", value: "25566.99", changePct: "-0.07%" }],
      us: [
        { name: "道琼斯", value: "53185.90", changePct: "-0.70%" },
        { name: "纳斯达克", value: "26370.89", changePct: "-0.12%" },
        { name: "标普500", value: "7686.14", changePct: "-0.33%" },
      ],
    },
  };
  const recap = synthesizeRecapFromQuotes(quotes);
  // 三卡均有 overview（指数兜底合成，非空）
  assert.ok(recap.us.overview.includes("道琼斯收报53185.90点（-0.70%）"), "美股卡应含道琼斯收盘点位");
  assert.ok(recap.aShare.overview.includes("上证指数收报3986.30点（+0.86%）"), "A股卡应含上证收盘点位");
  assert.ok(recap.hk.overview.includes("恒生指数收报25566.99点（-0.07%）"), "港股卡应含恒指收盘点位");
  // 顶层渠道/取值日透传（渲染卡脚与 marketStatus 依赖）
  assert.equal(recap.quoteChannel, "新浪行情");
  assert.equal(recap.quoteDate, "2026-08-31");
  // spoken 同步合成（口播可读）
  assert.ok(recap.us.spoken && recap.us.spoken.length > 0);
});

test("synthesizeRecapFromQuotes：某市场无指数 → 该卡为空卡但不整区丢弃", () => {
  const quotes = {
    channel: "新浪K线",
    date: "2026-08-28",
    quotes: { aShare: [], hk: [], us: [] },
  };
  const recap = synthesizeRecapFromQuotes(quotes);
  // 无指数 → 三卡为空（渲染层显示「暂无数据」），但 recap 对象本身非 null，
  // 股市解读区仍渲染（带空卡占位），不会整区跳过。
  assert.equal(recap.aShare.overview, "");
  assert.equal(recap.hk.overview, "");
  assert.equal(recap.us.overview, "");
  assert.equal(recap.quoteChannel, "新浪K线");
});
