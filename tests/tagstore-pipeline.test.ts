import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { runCachedAiPipeline } from "../lib/tagstore/pipeline";
import { ConsoleLogger, type DailyContext } from "../lib/pipeline/context";
import { makeSkipAiRunner } from "../lib/ai/pipeline";
import type { LlmRunner } from "../lib/ai/pass1";
import {
  emptyStore,
  buildRecord,
  upsertRecords,
  saveTagStore,
  TAG_STORE_PATH,
} from "../lib/tagstore/store";
import type { ArticleInput, DailyReport } from "../lib/types";

// M4 · 顶层集成测试：runCachedAiPipeline
// 验收标准：①参数化 ②预分析与正式跑都不漏损 ③无预分析时等价全量 LLM
// 策略：用 makeSkipAiRunner（确定性、零真 LLM）作「假 LLM」，包计数器证明命中组不调 LLM。

const NOW = "2026-09-07T12:00:00.000Z";
const STORE_BAK = `${TAG_STORE_PATH}.test-bak`;

function backupStore() {
  if (fs.existsSync(TAG_STORE_PATH)) fs.copyFileSync(TAG_STORE_PATH, STORE_BAK);
  if (fs.existsSync(TAG_STORE_PATH)) fs.rmSync(TAG_STORE_PATH);
}
function restoreStore() {
  if (fs.existsSync(STORE_BAK)) {
    fs.copyFileSync(STORE_BAK, TAG_STORE_PATH);
    fs.rmSync(STORE_BAK);
  } else if (fs.existsSync(TAG_STORE_PATH)) {
    fs.rmSync(TAG_STORE_PATH);
  }
}

// 短 key → 标准 ArticleInput（与可跑通的调试形态一致，避免畸形 URL 触发校验降级）
function art(key: string, over: Partial<ArticleInput> = {}): ArticleInput {
  return {
    url: `https://x.com/${key}`,
    title: `标题-${key}`,
    source: "stcn",
    sourceId: "stcn",
    category: "finance",
    excerpt: `摘要-${key}`,
    publishedAt: new Date(NOW) as unknown as ArticleInput["publishedAt"],
    ...over,
  } as ArticleInput;
}

function ctx(): DailyContext {
  return {
    date: "2026-09-07",
    log: new ConsoleLogger("test"),
    mode: { kind: "ai" },
  } as unknown as DailyContext;
}

/** 包一层计数器：每次调用 +1，转发给确定性 runner。 */
function countingRunner(base: LlmRunner, counter: { n: number }): LlmRunner {
  return async (s, u) => {
    counter.n++;
    return base(s, u);
  };
}

function totalItems(report: DailyReport): number {
  return Object.values(report.sections).reduce((n, arr) => n + arr.length, 0);
}

// ───────────────────────── 场景 A：空 store → 全量 LLM（等价现状） ─────────────────────────

test("runCachedAiPipeline: 空 store → 全部走 LLM，成稿包含全部输入，且回写 store", async () => {
  backupStore();
  try {
    const counter = { n: 0 };
    const runner = countingRunner(makeSkipAiRunner(), counter);
    const articles = [art("a"), art("b"), art("c"), art("d")];

    const { report, stats, store } = await runCachedAiPipeline(articles, ctx(), { missRunner: runner });

    // 空 store：输入 4 → miss 4 / hit 0 / 丢弃无价值 0
    assert.equal(stats.input, 4);
    assert.equal(stats.reused, 0);
    assert.equal(stats.llm, 4);
    assert.equal(stats.droppedIrrelevant, 0);
    // 成稿包含所有 4 条（不漏损）
    assert.equal(totalItems(report), 4, "空 store 下应全量产出");
    // miss 组 runner 按「阶段」调用：PASS1 一次 + PASS2 一次 = 2（单批次）
    assert.equal(counter.n, 2, "空 store 应全部调用假 LLM（2 次阶段调用）");
    // 回写：4 条新标签入库
    assert.equal(Object.keys(store.records).length, 4, "全量 LLM 后 4 条应回写 store");
  } finally {
    restoreStore();
  }
});

// ───────────────────────── 场景 B：命中缓存 → 复用零 LLM，不漏损 ─────────────────────────

test("runCachedAiPipeline: 部分命中缓存 → 命中组零 LLM 复用，未命中组走 LLM，合并不漏损", async () => {
  backupStore();
  try {
    // 预置 store：A/B 有价值（命中复用）、C 无价值（命中丢弃）、D 全新（走 LLM）
    const store = emptyStore();
    upsertRecords(store, [
      buildRecord({ url: "https://x.com/a", title: "标题-a", publishedAt: NOW, aiRelevant: true, summary: "缓存解读A", tagger: "workbuddy" })!,
      buildRecord({ url: "https://x.com/b", title: "标题-b", publishedAt: NOW, aiRelevant: true, summary: "缓存解读B", tagger: "workbuddy" })!,
      buildRecord({ url: "https://x.com/c", title: "标题-c", publishedAt: NOW, aiRelevant: false, tagger: "workbuddy" })!,
    ]);
    saveTagStore(store);

    const counter = { n: 0 };
    const runner = countingRunner(makeSkipAiRunner(), counter);
    const articles = [
      art("a"), // 命中复用
      art("b"), // 命中复用
      art("c"), // 命中无价值 → 丢弃
      art("d"), // 全新 → LLM
    ];

    const { report, stats, store: outStore } = await runCachedAiPipeline(articles, ctx(), { missRunner: runner });

    // 分流：2 命中 / 1 未命中 / 1 已判无价值丢弃
    assert.equal(stats.reused, 2, "A/B 应复用");
    assert.equal(stats.llm, 1, "仅 D 走 LLM");
    assert.equal(stats.droppedIrrelevant, 1, "C 已判无价值应丢弃");

    // 不漏损：成稿 = 复用 2 + 新 LLM 1 = 3 条（C 丢弃合理）
    assert.equal(totalItems(report), 3, "成稿应含 2 复用 + 1 LLM，无漏损");
    assert.equal(stats.finalItems, 3);

    // 命中组零 LLM：counter 只数到 D 的 PASS1+PASS2 = 2（缓存组用各自的 makeSkipAiRunner，不经过计数器）
    assert.equal(counter.n, 2, "命中组不应触发假 LLM 调用");

    // 命中组用 store 缓存解读，而非「GEN:」生成
    const flat = Object.values(report.sections).flat() as { url: string; summary?: string }[];
    const aItem = flat.find((i) => i.url === "https://x.com/a");
    assert.equal(aItem?.summary, "缓存解读A", "命中组应直接用 store 缓存解读，不调 LLM");

    // 新 LLM 条目 D 应成功回写且 aiRelevant=true
    const dRec = outStore.records[Object.keys(outStore.records).find((k) => outStore.records[k].url === "https://x.com/d")!];
    assert.ok(dRec, "D 应回写 store");
    assert.equal(dRec.aiRelevant, true, "D 进入成稿 → 有价值");
  } finally {
    restoreStore();
  }
});

// ───────────────────────── 场景 C：LLM 失败 → 回退全量，不漏损 ─────────────────────────

test("runCachedAiPipeline: miss 组 LLM 抛错 → 自动回退全量重跑，不漏损", async () => {
  backupStore();
  try {
    const store = emptyStore();
    upsertRecords(store, [
      buildRecord({ url: "https://x.com/a", title: "标题-a", publishedAt: NOW, aiRelevant: true, summary: "S", tagger: "workbuddy" })!,
    ]);
    saveTagStore(store);

    // missRunner 第一调用即抛错（模拟 LLM 故障）
    const flaky: LlmRunner = async () => {
      throw new Error("simulated LLM outage");
    };

    const { report, stats } = await runCachedAiPipeline(
      [art("a"), art("b")],
      ctx(),
      { missRunner: flaky },
    );

    // 回退全量：A 也进 LLM（flaky 仍抛错）→ 全量失败 → 降级为仅缓存组
    assert.equal(stats.fallbackFull, true, "应触发全量回退");
    assert.equal(stats.llmFailed, true, "LLM 失败应标记");
    // 降级后仍保留缓存组 A（不漏损：命中的不消失）
    assert.equal(totalItems(report), 1, "降级后应保留缓存组 A");
    // 失败时不回写（避免误标无价值）
    assert.equal(stats.writeback.added + stats.writeback.updated, 0, "LLM 失败不应回写");
  } finally {
    restoreStore();
  }
});
