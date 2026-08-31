/**
 * 股市解读层 功能测试（2026-08-31 港股口播质量整改）
 *
 * 验证 rankHkStockItems 的排序策略：收评/复盘类（大盘综合报道）最前，
 * 具体公司/板块/资金动态其次，空泛披露类与披露易公告流压后——
 * 保证 slice(0,12) 截断后 LLM 优先看到有信息量的港股条目，
 * 不再让「多家公司披露年报」「密集披露」类栏目套话占据输入主体。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { rankHkStockItems, type StockItem } from "../lib/ai/stock-recap";

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
