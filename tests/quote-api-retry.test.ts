/**
 * 行情抓取网络重试（2026-09-05 #148 实锤修复）
 *
 * 现象：CI run 早间两次发布，其中一次 `[quote] 抓取失败 ... fetch failed`
 *      → hq.sinajs.cn 单次请求失败 → 港股/美股指数整组为 0，页面只剩
 *      「新浪K线」降级渠道且无港股美股点位。
 * 修复：fetchText 加 3 次尝试（600ms/1.2s 指数退避），仅对网络错误/5xx/429 重试，
 *      4xx（非 429）立即放弃。
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { fetchMarketQuotes } from "../lib/sources/quote-api";

const TARGET_DAY = "2026-09-04";

/** 新浪 hq 文本：港股 f[6]=收盘 f[3]=昨收；美股 f[1]=收盘 f[2]=涨跌幅。 */
const HQ_TEXT = [
  `hq_str_sh000001="上证指数,3820.55,0.53,3810.00,3830.00,3800.00,3820.55,3820.55,123456,789,0,0,0,0,0,0,0,${TARGET_DAY},15:00:00";`,
  `hq_str_hkHSI="hkHSI,恒生指数,18000.00,18100.00,18200.00,17900.00,18234.56,134.56,0.74,0,0,0,0,0,0,0,0,0,${TARGET_DAY},16:08:00";`,
  `hq_str_gb_dji="道琼斯,42175.11,0.38,42000.00,42200.00,41900.00,42175.11,0,0,0,0,0,0,0,0,0,${TARGET_DAY},05:00:00";`,
].join("\n");

const KLINE_JSON = JSON.stringify([
  { day: "2026-09-03", open: "3800.00", close: "3800.00", high: "3810.00", low: "3790.00", volume: "1" },
  { day: TARGET_DAY, open: "3800.00", close: "3820.55", high: "3830.00", low: "3795.00", volume: "1" },
]);

type FetchFn = typeof globalThis.fetch;

/** 安装 fetch mock：按 URL 分流，可通过 opts 控制 hq 前 N 次失败行为。 */
function installFetch(opts: {
  hqFailTimes?: number;
  hqStatus?: number;
}): { calls: { hq: number; kline: number }; restore: () => void } {
  const calls = { hq: 0, kline: 0 };
  const hqFailTimes = opts.hqFailTimes ?? 0;
  const hqStatus = opts.hqStatus ?? 200;
  const impl: FetchFn = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("money.finance.sina.com.cn")) {
      calls.kline++;
      return new Response(KLINE_JSON, { status: 200 });
    }
    calls.hq++;
    if (calls.hq <= hqFailTimes) {
      if (hqStatus !== 200 && calls.hq === 1) return new Response("not found", { status: hqStatus });
      throw new Error("fetch failed");
    }
    return new Response(HQ_TEXT, { status: 200 });
  }) as FetchFn;
  const m = mock.method(globalThis, "fetch", impl);
  return { calls, restore: () => m.mock.restore() };
}

test("hq 首次 fetch failed → 自动重试后恢复，港股/美股指数不丢", async () => {
  const { calls, restore } = installFetch({ hqFailTimes: 1 });
  try {
    const res = await fetchMarketQuotes(TARGET_DAY);
    assert.ok(res, "重试成功应返回结果");
    assert.equal(calls.hq, 2, "应重试一次（共 2 次尝试）");
    assert.equal(res!.channel, "新浪行情", "不应退化为 K线 渠道");
    assert.equal(res!.quotes.hk.length, 1, "港股指数应取到");
    assert.equal(res!.quotes.us.length, 1, "美股指数应取到");
    assert.equal(res!.quotes.aShare.length, 3, "A股三个指数应全部取到");
  } finally {
    restore();
  }
});

test("hq 连续两次失败 → 第三次成功（重试上限内）", async () => {
  const { calls, restore } = installFetch({ hqFailTimes: 2 });
  try {
    const res = await fetchMarketQuotes(TARGET_DAY);
    assert.ok(res);
    assert.equal(calls.hq, 3, "应尝试 3 次（首次 + 2 次重试）");
    assert.equal(res!.quotes.hk.length, 1);
  } finally {
    restore();
  }
});

test("4xx 不重试（配置类错误重试无意义）", async () => {
  const { calls, restore } = installFetch({ hqFailTimes: 3, hqStatus: 404 });
  try {
    const res = await fetchMarketQuotes(TARGET_DAY);
    assert.equal(calls.hq, 1, "404 应立即放弃，不重试");
    assert.equal(res?.channel, "新浪K线", "hq 不可用时走 A股 K线 fallback，不整区丢失");
    assert.equal(res?.quotes.hk.length, 0, "港股无 K线 fallback，符合预期");
  } finally {
    restore();
  }
});
