/**
 * P1③ 港交所披露易占位公告判定 单元测试。
 * 验证：整条标题仅为 [XXX] 方括号占位（无公司名）判为占位 → 丢弃；含公司名的公告保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isHkexPlaceholderTitle } from "../lib/sources/crawlers/sources/hkex-stock";

test("方括号占位、无公司名 → 判为占位", () => {
  assert.equal(isHkexPlaceholderTitle("[Interim Results]"), true);
  assert.equal(isHkexPlaceholderTitle("[List of Directors]"), true);
  assert.equal(isHkexPlaceholderTitle("[Circulars]"), true);
  assert.equal(isHkexPlaceholderTitle("[Annual Report]"), true);
});

test("含公司名 / 非方括号 → 非占位（保留）", () => {
  assert.equal(isHkexPlaceholderTitle("TENCENT HOLDINGS LIMITED [Interim Results]"), false);
  assert.equal(isHkexPlaceholderTitle("列示例公司 [List of Directors]"), false);
  assert.equal(isHkexPlaceholderTitle("Notice of Annual General Meeting"), false); // 非方括号
  assert.equal(isHkexPlaceholderTitle(""), false);
});
