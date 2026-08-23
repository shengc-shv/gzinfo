import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGovList, absUrl, dateToIso, strip } from "../lib/sources/crawlers/gz-utils";
import { boardToSource } from "../lib/sources/crawlers/sources/tonghuashun-ipo";
import { SSE_PREFIX } from "../lib/sources/crawlers/sources/sse-api";
import { SZSE_PREFIX } from "../lib/sources/crawlers/sources/szse-api-crawler";

// ---------- gz-utils ----------

test("parseGovList: 匹配 content/post_*.html 链接，title 优先取属性", () => {
  const html = `
    <ul>
      <span>2026-08-15</span>
      <li><a href="/x/content/post_111.html" title="广州市统计局发布7月经济数据">广州市统计局发布7月经济数据</a></li>
      <li><a href="/y/content/post_222.html">无 title 的链接文本</a></li>
      <li><a href="/z/other_999.html">非 post 链接</a></li>
    </ul>`;
  const items = parseGovList(html, { minLen: 8 });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "广州市统计局发布7月经济数据");
  assert.equal(items[0].url, "/x/content/post_111.html");
  assert.equal(items[0].publishedAt, "2026-08-15T00:00:00.000Z");
  assert.equal(items[1].title, "无 title 的链接文本");
  assert.equal(items[1].url, "/y/content/post_222.html");
});

test("parseGovList: 无日期时 publishedAt 留空", () => {
  const html = `<a href="/content/post_1.html" title="关于某政策文件的发布通知">关于某政策文件的发布通知</a>`;
  const items = parseGovList(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].publishedAt, undefined);
});

test("parseGovList: 标题太短被过滤", () => {
  const html = `<a href="/content/post_1.html" title="短">短</a>`;
  const items = parseGovList(html, { minLen: 8 });
  assert.equal(items.length, 0);
});

test("absUrl: 相对链接拼绝对，http 原样返回", () => {
  assert.equal(absUrl("/a/b.html", "https://www.gz.gov.cn"), "https://www.gz.gov.cn/a/b.html");
  assert.equal(absUrl("https://x.com/p", "https://y.com"), "https://x.com/p");
  assert.equal(absUrl("", "https://y.com"), "");
});

test("dateToIso: 斜杠/横杠归一为 UTC 零点 ISO", () => {
  assert.equal(dateToIso("2026/08/15"), "2026-08-15T00:00:00.000Z");
  assert.equal(dateToIso("2026-08-15"), "2026-08-15T00:00:00.000Z");
  assert.equal(dateToIso("乱码"), null);
});

test("strip: 去标签与空白", () => {
  assert.equal(strip("<b>  hello  </b>  world "), "hello world");
});

// ---------- tonghuashun board 路由 ----------

test("boardToSource: 按板块路由到交易所二级标签", () => {
  assert.equal(boardToSource("创业板"), "szse");
  assert.equal(boardToSource("深市主板"), "szse");
  assert.equal(boardToSource("科创板"), "sse");
  assert.equal(boardToSource("沪市主板"), "sse");
  assert.equal(boardToSource("北交所"), "bse");
  assert.equal(boardToSource("主板"), "sse"); // 纯主板默认沪市
  assert.equal(boardToSource(""), "szse"); // 兜底
});

// ---------- IPO 代码前缀过滤 ----------

test("SSE_PREFIX: 6/9 开头为上交所", () => {
  assert.equal(SSE_PREFIX.test("600000"), true);
  assert.equal(SSE_PREFIX.test("688001"), true);
  assert.equal(SSE_PREFIX.test("900900"), true);
  assert.equal(SSE_PREFIX.test("000001"), false); // 深交所
  assert.equal(SSE_PREFIX.test("830799"), false); // 北交所
});

test("SZSE_PREFIX: 0/3 开头为深交所", () => {
  assert.equal(SZSE_PREFIX.test("000001"), true);
  assert.equal(SZSE_PREFIX.test("300750"), true);
  assert.equal(SZSE_PREFIX.test("600000"), false);
  assert.equal(SZSE_PREFIX.test("830799"), false);
});

// ---------- GBK 解码（M3-A：TextDecoder('gbk') 替代 iconv-lite） ----------

test("GBK decode via TextDecoder('gbk')：等价于 iconv-lite('GBK')", () => {
  // "你好" 的 GBK 字节序列
  const gbkBytes = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
  assert.equal(new TextDecoder("gbk").decode(gbkBytes), "你好");
  // "广州" 的 GBK 字节
  const gz = new Uint8Array([0xb9, 0xe3, 0xd6, 0xdd]);
  assert.equal(new TextDecoder("gbk").decode(gz), "广州");
});
