import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { StcnCrawler } from "../lib/sources/crawlers/sources/stcn-web";

/** 构造一个栏目列表页 HTML（含若干 tt 列表项 + 1 条重复 + 1 条 footer 噪声链接） */
function fakeColumnHtml(): string {
  return `
    <ul class="list infinite-list" data-url="/article/list.html?type=xw">
      <li class="">
        <div class="content">
          <div class="tt">
            <a href="/article/detail/4090000.html" target="_blank">
              “一船货浮亏数千万元曾是常态”！锂电企业如何破局？
            </a>
          </div>
          <div class="text ellipsis-2"><a href="/article/detail/4090000.html" target="_blank">摘要一</a></div>
        </div>
      </li>
      <li class="">
        <div class="content">
          <div class="tt">
            <a href="/article/detail/4090281.html">超42万手买单封涨停！14天8板！</a>
          </div>
        </div>
      </li>
      <!-- 同一文章重复出现（已在上方），应去重 -->
      <div class="tt"><a href="/article/detail/4090000.html">锂电企业如何破局（重复）</a></div>
      <!-- footer 噪声：非 /article/detail 链接，不应被抓取 -->
      <a href="/article/list/zt.html">专题</a>
      <a href="/quotes/index/sh000001.html">上证指数</a>
    </ul>
  `;
}

/**
 * 详情页 HTML（含真实发布时间）。
 * 时间真实性红线（2026-08-25 用户要求 / D-005）：列表页无日期字段，
 * 必须进详情页提取真实发布时间，**禁止用抓取日兜底**。
 * 故这里用一个**固定的、非今天**的日期，以证明产出日期来自详情页而非抓取当天。
 */
function fakeDetailHtml(pubtime: string): string {
  return `
    <html><head><title>详情</title></head>
    <body>
      <div class="info">来源：证券时报 作者：张三 ${pubtime}</div>
      <div class="content">正文内容，不含任何日期。</div>
    </body></html>
  `;
}

/** 详情页 HTML（无任何时间字段 → extractDetailPubtime 返回 undefined → 该条应被废弃） */
function fakeDetailHtmlNoDate(): string {
  return `<html><head><title>详情</title></head><body><div class="content">正文无时间字段</div></body></html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** 固定日期：刻意不是"今天"，用于证明日期来自详情页真实时间而非抓取日近似 */
const REAL_PUBTIME = "2026-08-27 09:15";

describe("StcnCrawler", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("解析列表页：提取 detail 链接、去重、忽略 footer 噪声；日期取详情页真实时间", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/article/detail/")) return htmlResponse(fakeDetailHtml(REAL_PUBTIME));
      return htmlResponse(fakeColumnHtml());
    }) as unknown as typeof fetch;

    const crawler = new StcnCrawler();
    const result = await crawler.run();

    // 3 个栏目各返回相同 HTML，但同 URL 全局去重 → 应只有 2 条唯一 detail 文章
    const stcnItems = result.filter((r) => r.sourceId === "stcn");
    const urls = new Set(stcnItems.map((r) => r.url ?? ""));
    assert.equal(urls.size, 2, "应去重为 2 条唯一 detail 文章");
    assert.equal(stcnItems.length, 2, "结果总数为 2（无 footer 噪声、无重复）");

    const item1 = stcnItems.find((r) => (r.url ?? "").includes("4090000"));
    assert.ok(item1, "应含 4090000 文章");
    assert.ok(
      item1?.title?.includes("锂电企业如何破局"),
      "标题应去掉空白与嵌套标签",
    );
    assert.equal(item1?.url, "https://www.stcn.com/article/detail/4090000.html");
    assert.equal(item1?.source, "证券时报");
    // 日期为详情页真实时间（固定日期），**不是**抓取当天 —— 时间真实性红线 D-005
    assert.equal(item1?.publishedAt, REAL_PUBTIME);

    const item2 = stcnItems.find((r) => (r.url ?? "").includes("4090281"));
    assert.ok(item2, "应含 4090281 文章");
    assert.equal(item2?.publishedAt, REAL_PUBTIME);
  });

  it("某栏目抓取失败时不应连坐其他栏目", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      // 新闻栏列表页失败（404），其余栏目与所有详情页正常
      if (u.includes("/article/list/xw.html")) return htmlResponse("not found", 404);
      if (u.includes("/article/detail/")) return htmlResponse(fakeDetailHtml(REAL_PUBTIME));
      return htmlResponse(fakeColumnHtml());
    }) as unknown as typeof fetch;

    const crawler = new StcnCrawler();
    const result = await crawler.run();
    const stcnItems = result.filter((r) => r.sourceId === "stcn");
    // 新闻栏失败时，其余 2 栏仍能产出 2 条唯一文章
    assert.equal(stcnItems.length, 2, "单栏失败不应连坐，其余栏正常产出");
  });

  it("详情页无真实发布时间 → 该条废弃（时间真实性红线，不用抓取日兜底）", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/article/detail/")) return htmlResponse(fakeDetailHtmlNoDate());
      return htmlResponse(fakeColumnHtml());
    }) as unknown as typeof fetch;

    const crawler = new StcnCrawler();
    const result = await crawler.run();
    const stcnItems = result.filter((r) => r.sourceId === "stcn");
    // 列表页解析到 2 条，但详情页都提不到真实时间 → 全部废弃，绝不用抓取日兜底
    assert.equal(stcnItems.length, 0, "无真实发布时间的条目必须废弃，不能用抓取日兜底");
  });
});
