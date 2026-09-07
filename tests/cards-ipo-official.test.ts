/**
 * renderArticleHtml 对 IPO 双链接（2026-09-07 用户要求）的渲染：
 * IPO/gd-ipo 条目带 officialUrl 时，标题下方额外展现「交易所官方源」链接；
 * 非 IPO 类别、或无 officialUrl 的条目不渲染该链接。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderArticleHtml } from "../lib/output/render/cards";
import type { ArticleInput } from "../lib/types";

const ipoItem: ArticleInput = {
  sourceId: "em-declare",
  source: "东财IPO在审(广东)",
  title: "粤芯半导体：IPO注册生效（拟科创板）",
  url: "https://data.eastmoney.com/xg/xg/#A25250",
  category: "gd-ipo",
  summary: "注册地：广东｜更新：2026-09-05",
  officialUrl: "https://www.sse.com.cn/listing/renewal/ipo",
  officialLabel: "上交所 · 发行上市审核",
};

test("renderArticleHtml: IPO 条目渲染交易所官方源链接", () => {
  const html = renderArticleHtml(ipoItem);
  assert.ok(html.includes("data.eastmoney.com/xg/xg/#A25250"), "主链接（东财列表）保留");
  assert.ok(html.includes("交易所官方源"), "展现官方源提示文案");
  assert.ok(html.includes("https://www.sse.com.cn/listing/renewal/ipo"), "官方源 URL 渲染");
  assert.ok(html.includes("上交所 · 发行上市审核"), "官方源展示名渲染");
  assert.ok(html.includes('class="official-src"'), "带 official-src 样式类");
});

test("renderArticleHtml: 无 officialUrl 时不渲染官方源", () => {
  const html = renderArticleHtml({ ...ipoItem, officialUrl: undefined, officialLabel: undefined });
  assert.ok(!html.includes("交易所官方源"));
});

test("renderArticleHtml: 非 IPO 类别即使有 officialUrl 也不渲染（纯展示字段不跨板块）", () => {
  const html = renderArticleHtml({ ...ipoItem, category: "gz" });
  assert.ok(!html.includes("交易所官方源"), "非 IPO 类别忽略 officialUrl");
});
