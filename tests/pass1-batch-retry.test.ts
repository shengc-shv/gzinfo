/**
 * 回归测试：PASS1 单批解析失败必须重试，而不是整批丢弃（2026-08-31 修复）；
 * 重试仍失败则**拆半递归隔离毒丸**（2026-09-01 修复，run 33478984024 实证：
 * 两次 position 差 21 字符 → 同批输入坏点稳定 → 重试同批必再坏）。
 *
 * 背景：BATCH_SIZE=30，而每日实际进管线的常只有 20 条左右 —— **一批就是全部**。
 * 2026-08-31 CI run 33344775965 实证：`[pass1] 批次调用失败（22 条按丢弃）:
 * Colon expected at position 2457`，一次坏 JSON 把当日正文清空，报告静默退化成
 * 只剩历史滚动条目（policy_market 9 → 3）。
 *
 * 修复①（08-31）：runPass1Batch 失败后重试 1 次（与 PASS2 的 MAX_PASS2_RETRY 同思路）；
 * 「解析成功但 items 为空」同样按失败处理（LLM 吐空壳）。成功路径零额外成本。
 * 修复②（09-01）：重试仍失败 → 拆半递归（深度上限 5）。毒丸被隔离为单条丢弃，
 * 其余条目单独有机会成功，救回率远高于整体重试。
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

test("PASS1 全部坏 → 拆半递归到单条后放弃（不抛异常、调用有界）", async () => {
  const inputs = [mkInput(1), mkInput(2)];
  let calls = 0;
  const runner = async (_sys: string, _user: string) => {
    calls++;
    return "not json at all";
  };
  const kept = await runPass1(inputs, runner);
  // 整批 2 次 + 拆半 1+1 各 2 次 = 6 次（每单元都重试一次，符合「重试 + 拆半」设计）
  assert.equal(calls, 6, "整批 2 次 + 拆半两条各 2 次");
  assert.equal(kept.length, 0, "全部失败最终 0 条，但不抛异常");
});

test("PASS1 毒丸隔离：单条坏内容不拖垮整批，其余救回", async () => {
  const inputs = [mkInput(1), mkInput(2), mkInput(3), mkInput(4)];
  let calls = 0;
  const runner = async (_sys: string, _user: string) => {
    calls++;
    // 模拟毒丸：凡批次包含 url=2 的，LLM 稳定输出 jsonrepair 也修不了的坏 JSON
    // （key 后跟感叹号，实测 jsonrepair 报 Colon expected —— 与 CI run 33478984024 同款）
    const user = _user;
    if (user.includes("https://example.com/2")) {
      return '{"items": [{"url": "https://example.com/2", "keep"!true}]}';
    }
    // 不包含毒丸的批次 → 正常
    return JSON.stringify({
      items: inputs
        .filter((a) => user.includes(a.url))
        .map((a) => okItem(Number(a.url.split("/").pop()))),
    });
  };
  const kept = await runPass1(inputs, runner);
  assert.ok(kept.length >= 2, "毒丸 url=2 被隔离丢弃，其余条目救回");
  assert.ok(
    kept.every((k) => k.url !== "https://example.com/2"),
    "毒丸本身不应保留",
  );
  assert.ok(calls > 2, "应发生拆半递归（多于整批重试的 2 次调用）");
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
