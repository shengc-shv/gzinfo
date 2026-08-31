/**
 * 回归测试：PASS1 单批解析失败必须重试，而不是整批丢弃（2026-08-31 修复）。
 *
 * 背景：BATCH_SIZE=30，而每日实际进管线的常只有 20 条左右 —— **一批就是全部**。
 * 2026-08-31 CI run 33344775965 实证：`[pass1] 批次调用失败（22 条按丢弃）:
 * Colon expected at position 2457`，一次坏 JSON 把当日正文清空，报告静默退化成
 * 只剩历史滚动条目（policy_market 9 → 3）。
 *
 * 修复：runPass1Batch 失败后重试 1 次（与 PASS2 的 MAX_PASS2_RETRY 同思路）；
 * 「解析成功但 items 为空」同样按失败处理（LLM 吐空壳）。成功路径零额外成本。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPass1, type Pass1Input } from "../lib/ai/pass1";

const mkInput = (n: number): Pass1Input => ({
  url: `https://example.com/${n}`,
  title: `第 ${n} 条财经要闻`,
  source: "测试源",
  date: "08/31",
  raw_text: `这是第 ${n} 条测试正文，用于验证 PASS1 批次重试行为。`.repeat(3),
  category: "finance",
});

const okItem = (n: number) => ({
  url: `https://example.com/${n}`,
  keep: true,
  section: "policy_market",
  source_type: "media",
  locale: "national",
  tags: [],
  title_cn: `第 ${n} 条财经要闻`,
  importance_candidate: 2,
});

test("PASS1 首次返回坏 JSON → 重试后挽回整批", async () => {
  const inputs = [mkInput(1), mkInput(2), mkInput(3)];
  let calls = 0;
  const runner = async (_sys: string, _user: string) => {
    calls++;
    if (calls === 1) return '[{"url": "https://example.com/1" "keep": true}]'; // 缺冒号，坏 JSON
    return JSON.stringify({ items: inputs.map((_, i) => okItem(i + 1)) });
  };
  const kept = await runPass1(inputs, runner);
  assert.equal(calls, 2, "应重试一次");
  assert.equal(kept.length, 3, "重试成功后整批应被挽回，而不是 0 条");
});

test("PASS1 首次返回空 items → 按失败处理并重试", async () => {
  const inputs = [mkInput(1), mkInput(2)];
  let calls = 0;
  const runner = async (_sys: string, _user: string) => {
    calls++;
    if (calls === 1) return JSON.stringify({ items: [] }); // 合法但空壳
    return JSON.stringify({ items: inputs.map((_, i) => okItem(i + 1)) });
  };
  const kept = await runPass1(inputs, runner);
  assert.equal(calls, 2, "空壳响应应触发重试");
  assert.equal(kept.length, 2);
});

test("PASS1 连续两次都失败 → 放弃该批（不抛异常、不拖垮运行）", async () => {
  const inputs = [mkInput(1), mkInput(2)];
  let calls = 0;
  const runner = async (_sys: string, _user: string) => {
    calls++;
    return "not json at all";
  };
  const kept = await runPass1(inputs, runner);
  assert.equal(calls, 2, "只重试一次，不无限循环");
  assert.equal(kept.length, 0, "两次都失败才整批丢弃");
});

test("PASS1 首次即成功 → 不额外调用 LLM（成功路径零成本）", async () => {
  const inputs = [mkInput(1)];
  let calls = 0;
  const runner = async (_sys: string, _user: string) => {
    calls++;
    return JSON.stringify({ items: [okItem(1)] });
  };
  const kept = await runPass1(inputs, runner);
  assert.equal(calls, 1, "成功时不应重试");
  assert.equal(kept.length, 1);
});
