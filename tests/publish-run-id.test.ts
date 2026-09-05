import { test } from "node:test";
import assert from "node:assert/strict";
import { extractReportRunId } from "../lib/memory/publish-run-id";

// 2026-09-05 回归测试：mark-delivered 反查 gh-pages commit message 提取发布 run id。
// 曾用 /run (\d+)/ 匹配，而 peaceiris 实际格式为 'daily: report for <run_id> <sha>'
// （无 "run " 字样 + 自动追加源 sha）→ 恒匹配失败 → reportRunId 恒缺失 →
// 次日结算指纹对账从未生效。提取逻辑独立成纯函数后加锁。

test("extractReportRunId: 真实 peaceiris 格式（run_id + 自动追加源 sha）", () => {
  const msg = "daily: report for 33931093055 d33c6ad32b76e34e9dd2b38169f0e3c35d558bfc";
  assert.equal(extractReportRunId(msg), "33931093055");
});

test("extractReportRunId: 无自动追加 sha 的裸格式", () => {
  assert.equal(extractReportRunId("daily: report for 123"), "123");
});

test("extractReportRunId: 多 run 混排取第一个", () => {
  const msg = "daily: report for 111 222";
  assert.equal(extractReportRunId(msg), "111");
});

test("extractReportRunId: 非发布 commit 返回 undefined", () => {
  assert.equal(extractReportRunId("chore: mark delivered 2026-09-05"), undefined);
  assert.equal(extractReportRunId("fix: something run 999"), undefined);
});

test("extractReportRunId: 空/缺失输入不抛错", () => {
  assert.equal(extractReportRunId(""), undefined);
  assert.equal(extractReportRunId(undefined), undefined);
  assert.equal(extractReportRunId(null), undefined);
});
