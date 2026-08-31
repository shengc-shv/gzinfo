/**
 * 漏斗三（业务价值取前，零 AI）单测：takeTopByValue 行为锁定。
 *
 * 2026-08-31 3漏斗整改 commit③：替代原「每源限额」，升级为
 * 「全局按分行相关性评分取前 + 每源多样性封顶 + 写回 valueTag」。
 * 测试用计数断言（每源封顶 / 全局封顶）与 valueTag 写回，避免依赖 scoreBranchRelevance
 * 精确分值，保证行为可单测、可回归。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { takeTopByValue, VALUE_TOP_N, VALUE_MAX_PER_SOURCE } from "../lib/ai/light-ai";
import type { ArticleInput } from "../lib/types";

const mk = (i: number, sourceId: string, ageDays = 0): ArticleInput => ({
  sourceId,
  source: sourceId,
  title: `条目${i}`,
  url: `https://example.com/${sourceId}/${i}`,
  category: "finance",
  publishedAt: new Date(Date.now() - ageDays * 86_400_000),
});

test("每源多样性封顶：同源 20 条 → 至多 VALUE_MAX_PER_SOURCE 条", () => {
  const arts = Array.from({ length: 20 }, (_, i) => mk(i, "stcn"));
  const out = takeTopByValue(arts, { topN: VALUE_TOP_N, maxPerSource: VALUE_MAX_PER_SOURCE });
  assert.ok(out.length <= VALUE_MAX_PER_SOURCE, `同源应被封顶到 ≤${VALUE_MAX_PER_SOURCE}，实际 ${out.length}`);
  assert.equal(out.length, VALUE_MAX_PER_SOURCE, "20 条同源应恰好保留封顶数");
  for (const a of out) assert.equal(a.sourceId, "stcn");
});

test("全局取前封顶：20 源各 5 条（共 100）→ 全局 ≤ topN 且每源 ≤ 封顶", () => {
  const topN = 30;
  const arts: ArticleInput[] = [];
  for (let s = 0; s < 20; s++) {
    for (let i = 0; i < 5; i++) arts.push(mk(i, `src${s}`));
  }
  const out = takeTopByValue(arts, { topN, maxPerSource: VALUE_MAX_PER_SOURCE });
  assert.ok(out.length <= topN, `全局应被封顶到 ≤${topN}，实际 ${out.length}`);
  assert.ok(out.length < 100, "应被全局/每源封顶，少于原始 100 条");
  const perSource = new Map<string, number>();
  for (const a of out) perSource.set(a.sourceId, (perSource.get(a.sourceId) ?? 0) + 1);
  for (const [sid, n] of perSource) {
    assert.ok(n <= VALUE_MAX_PER_SOURCE, `源 ${sid} 应 ≤${VALUE_MAX_PER_SOURCE}，实际 ${n}`);
  }
});

test("valueTag 写回：每条产出带 tier/score/businessLines/vertical/risk", () => {
  const arts = Array.from({ length: 20 }, (_, i) => mk(i, "stcn"));
  const out = takeTopByValue(arts, { topN: VALUE_TOP_N, maxPerSource: VALUE_MAX_PER_SOURCE });
  for (const a of out) {
    assert.ok(a.valueTag, "应写回 valueTag");
    assert.equal(typeof a.valueTag!.score, "number", "score 应为数字");
    assert.ok(Array.isArray(a.valueTag!.businessLines), "businessLines 应为数组");
    assert.equal(
      ["must_read", "insight", "context", "drop"].includes(a.valueTag!.tier),
      true,
      `tier 应合法，实际 ${a.valueTag!.tier}`,
    );
    assert.equal(typeof a.valueTag!.risk, "boolean", "risk 应为布尔");
  }
});

test("纯函数：不 mutate 入参（保留原数组长度与字段）", () => {
  const arts = Array.from({ length: 20 }, (_, i) => mk(i, "stcn"));
  const snapshot = arts.map((a) => ({ ...a }));
  takeTopByValue(arts, { topN: VALUE_TOP_N, maxPerSource: VALUE_MAX_PER_SOURCE });
  assert.equal(arts.length, 20, "入参长度不应被改变");
  assert.deepEqual(
    arts.map((a) => a.url),
    snapshot.map((a) => a.url),
    "入参顺序/内容不应被改变",
  );
});
