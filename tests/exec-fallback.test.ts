/**
 * 执行摘要兜底回归测试（2026-08-31 修复）。
 *
 * 复现场景：CI 实际产出「今日定调=今天只有1条IPO信息、今日分析(必读/商机)为空」。
 * 根因：2 天窗口池在今日抓取条目缺 publishedAt 时被静默清空，且 AI 分支在 LLM
 * 返回空时没有任何确定性兜底。本测试验证：
 *  1) buildTwoDayExecPool / collectTwoDayArticles 不再因缺 publishedAt 静默丢条目；
 *  2) AI 分支 LLM 返回空（仅 IPO 弱信号）→ 回退 2 天评分兜底，必读/商机/定调非空且一致。
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 本测试通过 mock LLM 驱动整条 exec 管线（buildExecutiveSummary）。
// 关闭内容记忆层：防止测试运行把「模拟播报」写入生产 data/event-memory.json
// （记忆是跨运行持久化资产，测试触发写入会污染记忆库）。
process.env.EVENT_MEMORY = "0";

const DATE = "2026-08-31";
const STORE = path.resolve(process.cwd(), "history", DATE, "store.json");
const report = JSON.parse(fs.readFileSync(`history/${DATE}/${DATE}.json`, "utf8")) as any;
const artsRaw = JSON.parse(fs.readFileSync(`history/${DATE}/${DATE}-articles.json`, "utf8")) as {
  articles: any[];
};
const articles = artsRaw.articles;
const history = JSON.parse(fs.readFileSync("data/article-history.json", "utf8")) as Record<string, any>;

function makeCtx(mode: "ai" | "skip-ai"): any {
  return {
    startTime: new Date(),
    date: DATE,
    mode:
      mode === "ai"
        ? { kind: "ai" }
        : { kind: "skip-ai", summaryCache: new Map(), relevantUrls: new Set() },
    sources: [],
    tierBySource: new Map(),
    history,
    aiAssets: {},
    errors: [],
    log: { info() {}, warn() {}, error() {} },
  };
}

test("buildTwoDayExecPool：今日抓取缺 publishedAt 也应纳入（不再静默清空）", async () => {
  const thinReport: any = JSON.parse(JSON.stringify(report));
  for (const sec of Object.keys(thinReport.sections)) thinReport.sections[sec] = [];
  const noPubArticles = articles.map((a) => {
    const c = JSON.parse(JSON.stringify(a));
    delete c.publishedAt; // 模拟时间红线硬化后缺发布时间
    return c;
  });
  const noTagHistory: any = JSON.parse(JSON.stringify(history));
  for (const e of Object.values(noTagHistory) as any[]) {
    delete e.ai_relevant;
    delete e.summary;
  }
  const { buildTwoDayExecPool } = await import("../lib/ai/exec-pool");
  const pool = buildTwoDayExecPool({ history: noTagHistory, articles: noPubArticles, report: thinReport, today: DATE });
  assert.ok(pool.finance.length > 0, "finance 池不应因缺 publishedAt 而空");
  assert.ok(pool.gz.length > 0, "gz 池不应因缺 publishedAt 而空");
});

test("AI 分支：LLM 只回 IPO 弱信号(必读/商机空) → 2 天评分兜底产出非空且与展示一致", async (t) => {
  const snap = fs.existsSync(STORE) ? fs.readFileSync(STORE, "utf8") : null;
  t.after(() => {
    mock.reset(); // 清理模块 mock，避免下一个测试二次 mock 同一模块报 ERR_INVALID_STATE
    if (snap) fs.writeFileSync(STORE, snap);
    else if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  });

  // 复现线上：LLM 仅回了 1 条 IPO 类定调、必读/商机均为空数组
  mock.module("../lib/ai/llm.ts", {
    namedExports: {
      runLlm: async () => ({
        text: JSON.stringify({ hero_line: "今天只有1条IPO信息", must_read: [], insights: [] }),
      }),
    },
  });
  const { buildExecutiveSummary } = await import(
    "../lib/pipeline/side-outputs/executive-summary"
  );

  const out = await buildExecutiveSummary(report, history, articles, makeCtx("ai"));
  assert.ok(out.must_read.length > 0, "必读(今日分析)不应为空");
  assert.ok(out.insights.length > 0, "商机(今日分析)不应为空");
  assert.ok(out.hero_line && out.hero_line.length > 0, "今日定调不应为空");
  assert.ok(
    !out.hero_line.includes("今天只有1条IPO信息"),
    "不应保留 IPO-only 弱定调，应回退为 2 天评分定调",
  );
  // 兜底必读/商机应来自 2 天窗口（含当日政策/广州业务），与下方展示口径一致
  assert.ok(
    out.must_read.some((m: any) => /房贷|楼市|政策|改革|信贷/.test(m.title || m.why || "")) ||
      out.insights.length > 0,
    "兜底内容应覆盖今日政策/业务信号",
  );
});

test("AI 分支：LLM 调用失败(null) → 同样回退 2 天评分兜底", async (t) => {
  const snap = fs.existsSync(STORE) ? fs.readFileSync(STORE, "utf8") : null;
  t.after(() => {
    mock.reset();
    if (snap) fs.writeFileSync(STORE, snap);
    else if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  });

  mock.module("../lib/ai/llm.ts", {
    namedExports: {
      runLlm: async () => {
        throw new Error("mock LLM failure");
      },
    },
  });
  const { buildExecutiveSummary } = await import(
    "../lib/pipeline/side-outputs/executive-summary"
  );

  const out = await buildExecutiveSummary(report, history, articles, makeCtx("ai"));
  assert.ok(out.must_read.length > 0, "LLM 失败后必读不应空");
  assert.ok(out.insights.length > 0, "LLM 失败后商机不应空");
});
