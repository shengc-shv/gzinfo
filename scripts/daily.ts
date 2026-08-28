import "./_env";

import { saveAiAssets, dailyAssetKey, assetDaily } from "../lib/ai/assets";
import { bootstrap } from "../lib/pipeline/bootstrap";
import { ingestAll } from "../lib/pipeline/ingest";
import { runFilterPipeline } from "../lib/pipeline/filter";
import { runAiPipeline } from "../lib/pipeline/ai";
import { mergeRollingAndSaveHistory } from "../lib/pipeline/history-step";
import { buildSideOutputs } from "../lib/pipeline/side-outputs";
import { applyDisplayCaps } from "../lib/pipeline/display-cap";
import { synthesizeAudioIfAny } from "../lib/pipeline/audio";
import { renderAndWrite } from "../lib/pipeline/render-and-write";
import type { DailyReport, ArticleInput } from "../lib/types";
import type { HistoryStore } from "../lib/output/history";
import type { CrawledArticle } from "../lib/ingest/merge";
import type { FilterResult } from "../lib/filters/types";
import type { DailyContext } from "../lib/pipeline/context";

/**
 * 可注入依赖（e2e 测试用）：默认走真实函数；测试时替换网络/磁盘边界。
 * 仅暴露真正的副作用边界——采集（网络）、AI 管线（LLM）、side-outputs（LLM）、
 * 历史写盘、AI 资产写回、产物写盘。其余确定性阶段（runFilterPipeline /
 * applyDisplayCaps / 音频跳过）不注入，测试中也跑真实代码。
 */
export interface RunDailyDeps {
  ingestAll?: typeof ingestAll;
  runAiPipeline?: typeof runAiPipeline;
  buildSideOutputs?: typeof buildSideOutputs;
  mergeRollingAndSaveHistory?: typeof mergeRollingAndSaveHistory;
  saveAiAssets?: typeof saveAiAssets;
  renderAndWrite?: typeof renderAndWrite;
}

export async function runDaily(
  ctxArg?: DailyContext,
  deps: RunDailyDeps = {},
): Promise<void> {
  const ingestAllFn = deps.ingestAll ?? ingestAll;
  const runAiPipelineFn = deps.runAiPipeline ?? runAiPipeline;
  const buildSideOutputsFn = deps.buildSideOutputs ?? buildSideOutputs;
  const mergeRollingAndSaveHistoryFn =
    deps.mergeRollingAndSaveHistory ?? mergeRollingAndSaveHistory;
  const saveAiAssetsFn = deps.saveAiAssets ?? saveAiAssets;
  const renderAndWriteFn = deps.renderAndWrite ?? renderAndWrite;
  // 启动：凭证校验 + 加载缓存 + 构建 mode + 构建 tier 索引（PR1）
  const ctx = ctxArg ?? (await bootstrap());
  const date = ctx.date;
  console.log(`[daily] ${date} — fetching sources…\n`);

  // T1：每阶段 try/catch 包裹，失败 push ctx.errors，main 末尾统一汇总
  //    替代 .catch() 顶层只打最后一条错误——CI 失败时一眼看到所有失败点
  const stageError = (stage: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.errors.push({ stage, message: msg, ts: new Date().toISOString() });
    console.error(`[daily] ❌ stage "${stage}" failed: ${msg}`);
  };

  // ① 采集 + 归一化（PR2；T7 已并发化 fetchAllSources）
  let ingested: { articles: ArticleInput[]; rawArticles: ArticleInput[]; crawled: { ipo: CrawledArticle[]; gz: CrawledArticle[]; stocks: CrawledArticle[] } } | null = null;
  try {
    ingested = await ingestAllFn(ctx);
  } catch (e) {
    stageError("ingest", e);
    if (!ingested) throw e;  // ingest 是最关键阶段，失败则终止
  }
  const { articles: ingestedArticles, rawArticles, crawled } = ingested!;

  // ② 9 道过滤（PR3；B-1 返回 filterResults 给 side-outputs 提取风险候选）
  let filterOut: { articles: ArticleInput[]; filterResults: Map<string, FilterResult> } | null = null;
  try {
    filterOut = runFilterPipeline(ingestedArticles, ctx);
  } catch (e) {
    stageError("filter", e);
    filterOut = { articles: ingestedArticles, filterResults: new Map() };
  }
  const { articles, filterResults } = filterOut;

  // ③ AI 管线（PR4；runLlm 已有 3 次重试 + 指数退避）
  let report: DailyReport | null = null;
  try {
    report = await runAiPipelineFn(articles, ctx);
  } catch (e) {
    stageError("ai", e);
    throw e;  // AI 失败是致命（必读/商机/风险都依赖 LLM 输出）
  }

  // ④ 历史写盘 + 滚动列表 + 近7天并入（PR4）
  let step: { history: HistoryStore; rolling: ArticleInput[]; report: DailyReport; nowIso: string } | null = null;
  try {
    step = mergeRollingAndSaveHistoryFn(report, articles, ctx);
  } catch (e) {
    stageError("history", e);
    throw e;
  }
  const { rolling, report: mergedReport, nowIso } = step;

  // ⑤ 三个旁路：必读/商机 / 股市复盘 / 股市清单（PR4；模式自适应由 ctx.mode 派发）
  //    B-1：filterResults 透传给 executive-summary，LLM 用其喂 risk 段
  let finalReport: DailyReport = mergedReport;
  try {
    finalReport = await buildSideOutputsFn(
      mergedReport,
      step.history,
      articles,
      rawArticles,
      crawled,
      ctx,
      filterResults,
    );
  } catch (e) {
    stageError("side-outputs", e);
    // side-outputs 失败 → 用 mergedReport 兜底（无 exec/risk/recap，但主结构可用）
  }

  // ⑥ M2-④：AI 资产账本写回（daily 级：仅 trading；正文已随 report.json 落盘）
  try {
    const aiAssets = ctx.aiAssets;
    const dk = dailyAssetKey(date);
    const dailyPrev = assetDaily(aiAssets, date);
    aiAssets[dk] = {
      ...(dailyPrev ?? {}),
      updatedAt: nowIso,
    };
    saveAiAssetsFn(aiAssets);
    ctx.log.info("ai", `AI 资产账本已更新: ${Object.keys(aiAssets).length} 键`);
  } catch (e) {
    stageError("ai-assets", e);
  }

  // ⑦ 展示限额（PR5；按价值评分 + 每源/每板块上限）
  let cappedReport: DailyReport = finalReport;
  try {
    cappedReport = applyDisplayCaps(finalReport, ctx);
  } catch (e) {
    stageError("display-cap", e);
  }

  // ⑧ 语音播报（PR5；失败/缺失不阻断发布；AUDIO_ENABLED=false 直接跳过）
  let audio: Awaited<ReturnType<typeof synthesizeAudioIfAny>> = undefined;
  try {
    audio = await synthesizeAudioIfAny(cappedReport, ctx);
  } catch (e) {
    stageError("audio", e);
  }

  // ⑨ 渲染 + 写盘（PR5；唯一存储 + sidecar + 导出全量池）
  try {
    await renderAndWriteFn(
      { report: cappedReport, rolling, audio, filteredArticles: articles },
      ctx,
    );
  } catch (e) {
    stageError("render", e);
  }

  // T1：错误聚合汇总（2026-08-28）：CI 失败时一眼看到所有失败点
  if (ctx.errors.length > 0) {
    console.log("");
    console.warn(
      `[daily] ⚠️  本次运行共 ${ctx.errors.length} 条错误（非致命，已降级）：`,
    );
    for (const e of ctx.errors) {
      const src = e.source ? ` [${e.source}]` : "";
      console.warn(
        `  - [${e.stage}]${src} ${e.message.slice(0, 200)}`,
      );
    }
  }
}

// 仅在以 `tsx scripts/daily.ts` 直接运行时自执行；被测试 import 时不触发真实管线
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runDaily()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`[daily] FAILED:`, e);
      process.exit(1);
    });
}
