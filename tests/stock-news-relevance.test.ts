/**
 * P1④ 股市动态 美股/港股 二次业务相关性过滤 单元测试。
 * 验证：只留能挂钩客群/财富/私行/信贷/市场涨跌的条目；A股不过滤；纯地缘/海外个股噪声被砍。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { stockNewsRelevant } from "../lib/pipeline/side-outputs/stock-news";
import type { StockNewsItem } from "../lib/types";

function mk(market: StockNewsItem["market"], title_cn: string, summary = ""): StockNewsItem {
  return {
    url: "https://example.com",
    title_cn,
    source: "x",
    source_type: "media",
    date: "",
    summary,
    importance: 2,
    rank: 0,
    tags: [],
    locale: market === "us" ? "overseas" : "national",
    market,
  };
}

test("A股恒不过滤（内地零售主战场）", () => {
  assert.equal(stockNewsRelevant(mk("a-share", "贵州茅台分红方案出炉")), true);
  assert.equal(stockNewsRelevant(mk("a-share", "沪指震荡整理")), true);
});

test("港股/美股：挂钩业务线或市场涨跌 → 保留", () => {
  assert.equal(stockNewsRelevant(mk("hk", "腾讯控股回购X亿股")), true); // 回购
  assert.equal(stockNewsRelevant(mk("hk", "恒指涨0.5% 终结连跌")), true); // 涨
  assert.equal(stockNewsRelevant(mk("hk", "美团业绩超预期 营收高增")), true); // 业绩
  assert.equal(stockNewsRelevant(mk("us", "英伟达财报营收创新高")), true); // 财报
  assert.equal(stockNewsRelevant(mk("us", "黄金突破历史新高 避险升温")), true); // 黄金
  assert.equal(stockNewsRelevant(mk("hk", "南向资金净买入港股通标的")), true); // 南向/港股通
});

test("美股/港股：纯地缘/海外个股噪声 → 丢弃（P1④ 用户示例）", () => {
  assert.equal(stockNewsRelevant(mk("us", "Buffett 96岁股价平淡无奇")), false); // 无业务/市场关键词
  assert.equal(stockNewsRelevant(mk("us", "伊朗去美元化进程加速")), false); // 地缘、无汇率动作
  assert.equal(stockNewsRelevant(mk("us", "Trump 委内瑞拉石油协议达成")), false); // 地缘石油
});
