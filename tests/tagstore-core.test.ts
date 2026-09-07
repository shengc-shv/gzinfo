import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl,
  urlId,
  titleFingerprint,
  contentFingerprint,
  titleDice,
} from "../lib/tagstore/dedupe";
import {
  windowBounds,
  inWindow,
  addDays,
  dateInTz,
  localMidnightMs,
  REPORT_TZ,
} from "../lib/tagstore/window";

// M4 · TagStore 缓存复用流水线：去重键与时间窗口的基础契约。
// 这两块决定「命中还是未命中」，错了会导致重复烧钱或漏条，必须锁死。

test("normalizeUrl: 去 utm / 锚点 / www / 协议差异 / 尾斜杠", () => {
  const a = "https://www.stcn.com/article/detail/123.html?utm_source=wx&from=app#top";
  const b = "http://stcn.com/article/detail/123.html/";
  assert.equal(normalizeUrl(a), normalizeUrl(b));
});

test("normalizeUrl: 非跟踪参数保留（不同文章不得误并）", () => {
  const a = "https://x.com/a?id=1";
  const b = "https://x.com/a?id=2";
  assert.notEqual(normalizeUrl(a), normalizeUrl(b));
});

test("normalizeUrl: 非法 URL 不抛错", () => {
  assert.equal(normalizeUrl(""), "");
  assert.doesNotThrow(() => normalizeUrl("not a url"));
  assert.equal(normalizeUrl("NOT A URL"), "not a url");
});

test("urlId: 稳定且长度 16", () => {
  const id = urlId("https://www.stcn.com/article/detail/123.html?utm_source=wx");
  assert.equal(id.length, 16);
  assert.equal(id, urlId("http://stcn.com/article/detail/123.html"));
});

test("titleFingerprint: 标点与大小写不敏感，正文不同则不同", () => {
  assert.equal(titleFingerprint("广州：银行业 上半年"), titleFingerprint("广州银行业上半年"));
  assert.notEqual(titleFingerprint("文章A"), titleFingerprint("文章B"));
});

test("contentFingerprint: 摘要只取前 80 字，超长部分不影响", () => {
  const long1 = "x".repeat(200);
  const long2 = "x".repeat(200) + "尾部差异";
  assert.equal(contentFingerprint("标题", long1), contentFingerprint("标题", long2));
});

test("titleDice: 完全相同=1，完全不同=0，相似居中", () => {
  assert.equal(titleDice("同一标题", "同一标题"), 1);
  assert.equal(titleDice("苹果", "香蕉"), 0);
  const s = titleDice("广州银行业上半年净利润增长", "广州银行业上半年利润增长");
  assert.ok(s > 0.5 && s < 1, `期望 0.5~1，实际 ${s}`);
});

test("dateInTz: 同一 UTC 时刻在北京与 UTC 下的日期可能不同", () => {
  // 2026-09-07T17:00Z = 北京 09-08 01:00 → 本地日应为 09-08
  const ms = Date.parse("2026-09-07T17:00:00Z");
  assert.equal(dateInTz(ms, "Asia/Shanghai"), "2026-09-08");
  assert.equal(dateInTz(ms, "UTC"), "2026-09-07");
});

test("localMidnightMs: 北京 00:00 对应前一 UTC 日 16:00", () => {
  const ms = localMidnightMs("2026-09-08", "Asia/Shanghai");
  assert.equal(new Date(ms).toISOString(), "2026-09-07T16:00:00.000Z");
});

test("addDays: 跨月跨年正确", () => {
  assert.equal(addDays("2026-09-01", -1), "2026-08-31");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-09-08", 0), "2026-09-08");
});

test("windowBounds: 报告日 T 的两天窗口 = [T-1 00:00, T+1 00:00)", () => {
  const w = windowBounds("2026-09-08", 2, "Asia/Shanghai");
  assert.equal(w.from, "2026-09-06T16:00:00.000Z"); // 北京 09-07 00:00
  assert.equal(w.to, "2026-09-08T16:00:00.000Z"); // 北京 09-09 00:00
  assert.deepEqual(w.days, ["2026-09-07", "2026-09-08"]);
});

test("inWindow: 半开区间，边界归属明确", () => {
  const w = windowBounds("2026-09-08", 2, "Asia/Shanghai");
  // 北京 09-07 00:00 精确命中下界 → 含
  assert.equal(inWindow("2026-09-06T16:00:00.000Z", w), true);
  // 北京 09-08 23:59 → 含
  assert.equal(inWindow("2026-09-08T15:59:00.000Z", w), true);
  // 北京 09-09 00:00 → 不含（上界）
  assert.equal(inWindow("2026-09-08T16:00:00.000Z", w), false);
  // 北京 09-06 23:59 → 不含（窗口外）
  assert.equal(inWindow("2026-09-06T15:59:00.000Z", w), false);
});

test("inWindow: 无发布时间一律 false（时间真实性红线）", () => {
  const w = windowBounds("2026-09-08", 2);
  assert.equal(inWindow(undefined, w), false);
  assert.equal(inWindow("", w), false);
  assert.equal(inWindow("不是时间", w), false);
});

test("REPORT_TZ 默认 Asia/Shanghai（禁止 UTC 兜底）", () => {
  assert.equal(REPORT_TZ, "Asia/Shanghai");
});
