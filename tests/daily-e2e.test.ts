/**
 * daily.ts 端到端编排测试（P1）。
 *
 * 设计：runDaily 已支持依赖注入（RunDailyDeps），本测试只注入「网络/磁盘副作用边界」
 * —— ingestAll（采集）、runAiPipeline（LLM）、buildSideOutputs（LLM）、
 * mergeRollingAndSaveHistory（历史写盘）、saveAiAssets（资产写盘）、renderAndWrite
 * （产物写盘）——其余确定性阶段（runFilterPipeline / applyDisplayCaps / 音频跳过）
 * 跑真实代码，验证主链路编排与数据传播。
 *
 * 全程零网络、零真盘，确定性可重复。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDaily, type RunDailyDeps } from "../scripts/daily";
import type { DailyContext, Logger } from "../lib/pipeline/context";
import type {
  ArticleInput,
  DailyReport,
  ReportItem,
} from "../lib/types";
import type { HistoryStore } from "../lib/output/history";
import type { AiAssetStore } from "../lib/ai/assets";

// 避免音频合成走网络：显式关闭
process.env.AUDIO_ENABLED = "false";

const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeCtx(): DailyContext {
  return {
    startTime: new Date("2026-08-28T08:00:00+08:00"),
    date: "2026-08-28",
    mode: { kind: "ai" },
    sources: [],
    tierBySource: new Map(),
    history: {} as HistoryStore,
    aiAssets: {} as AiAssetStore,
    errors: [],
    log: silentLog,
  };
}

const pub = new Date("2026-08-28T07:00:00+08:00");

const mockArticles: ArticleInput[] = [
  {
    sourceId: "src-a",
    title: "广州投放货币政策工具",
    url: "https://example.com/a",
    category: "finance",
    publishedAt: pub,
    summary: "某政策落地",
  },
  {
    sourceId: "src-b",
    title: "财富管理市场动态",
    url: "https://example.com/b",
    category: "finance",
    publishedAt: pub,
    summary: "某市场动态",
  },
] as ArticleInput[];

const mockReport: DailyReport = {
  date: "2026-08-28",
  hero_line: "今日定调",
  must_read: [
    { url: "https://example.com/a", why: "重要" },
    { url: "https://example.com/b", why: "重要" },
    { url: "https://example.com/c", why: "重要" },
  ],
  insights: [
    {
      topic: "商机洞察",
      tags: ["财富"],
      impact: "影响",
      action: "建议",
    },
  ],
  sections: {
    gz_local: [],
    biz_insight: [],
    policy_market: [],
    tech: [],
    ipo: [],
  },
};

const mockItem: ReportItem = {
  url: "https://example.com/x",
  title_cn: "示例条目",
  source: "示例源",
  source_type: "media",
  date: "08/28",
  summary: "示例摘要",
  importance: 2,
  rank: 1,
  tags: ["财富"],
  locale: "gz",
};

// 让 sections 含一条，喂给 applyDisplayCaps 跑真实代码
mockReport.sections.gz_local = [mockItem];

test("happy path: 编排打通，AI 产物传播到 render", async () => {
  const ctx = makeCtx();
  let renderArg: unknown = null;
  let saveAiAssetsCalls = 0;

  const deps: RunDailyDeps = {
    ingestAll: async () => ({
      articles: mockArticles,
      rawArticles: mockArticles,
      crawled: { ipo: [], gz: [], stocks: [] },
    }),
    runAiPipeline: async () => mockReport,
    buildSideOutputs: async (merged) => ({
      ...(merged as DailyReport),
      hero_line: "EXEC-SENTINEL",
    }),
    mergeRollingAndSaveHistory: (report) => ({
      history: {} as HistoryStore,
      rolling: mockArticles,
      report: report as DailyReport,
      nowIso: new Date().toISOString(),
    }),
    saveAiAssets: () => {
      saveAiAssetsCalls++;
    },
    renderAndWrite: async (arg) => {
      renderArg = arg;
    },
  };

  await runDaily(ctx, deps);

  assert.equal(ctx.errors.length, 0, "happy path 不应有错误");
  assert.ok(renderArg, "renderAndWrite 应被调用");
  const r = (renderArg as { report: DailyReport; filteredArticles: unknown[] }).report;
  assert.equal(r.must_read.length, 3, "AI 产出 must_read 应传播到 render");
  assert.equal(r.hero_line, "EXEC-SENTINEL", "buildSideOutputs 产物应传播到 render");
  assert.equal(
    (renderArg as { filteredArticles: unknown[] }).filteredArticles.length,
    2,
    "过滤后条目数应等于输入",
  );
  assert.equal(saveAiAssetsCalls, 1, "AI 资产应写回一次");
});

test("ingest 失败是致命的，且错误入聚合", async () => {
  const ctx = makeCtx();
  let renderCalled = false;

  const deps: RunDailyDeps = {
    ingestAll: async () => {
      throw new Error("采集全挂");
    },
    renderAndWrite: async () => {
      renderCalled = true;
    },
  };

  await assert.rejects(() => runDaily(ctx, deps), /采集全挂/);
  assert.equal(ctx.errors.some((e) => e.stage === "ingest"), true, "应记录 ingest 错误");
  assert.equal(renderCalled, false, "ingest 失败后不应渲染");
});

test("side-outputs 失败降级，不阻断发布", async () => {
  const ctx = makeCtx();
  let renderArg: unknown = null;

  const deps: RunDailyDeps = {
    ingestAll: async () => ({
      articles: mockArticles,
      rawArticles: mockArticles,
      crawled: { ipo: [], gz: [], stocks: [] },
    }),
    runAiPipeline: async () => mockReport,
    buildSideOutputs: async () => {
      throw new Error("exec 生成失败");
    },
    mergeRollingAndSaveHistory: (report) => ({
      history: {} as HistoryStore,
      rolling: mockArticles,
      report: report as DailyReport,
      nowIso: new Date().toISOString(),
    }),
    saveAiAssets: () => {},
    renderAndWrite: async (arg) => {
      renderArg = arg;
    },
  };

  // 不应抛错（side-outputs 失败被 try/catch 降级）
  await runDaily(ctx, deps);

  assert.equal(
    ctx.errors.some((e) => e.stage === "side-outputs"),
    true,
    "应记录 side-outputs 错误",
  );
  assert.ok(renderArg, "降级后仍应渲染（用 mergedReport 兜底）");
  const r = (renderArg as { report: DailyReport }).report;
  // 降级时 report 不含 EXEC-SENTINEL（buildSideOutputs 失败，用 mergedReport）
  assert.notEqual(r.hero_line, "EXEC-SENTINEL", "降级不应带 exec 标记");
  assert.equal(r.must_read.length, 3, "降级报告仍含 AI 主结构");
});
