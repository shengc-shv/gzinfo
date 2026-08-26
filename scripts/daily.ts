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

async function main() {
  // 启动：凭证校验 + 加载缓存 + 构建 mode + 构建 tier 索引（PR1）
  const ctx = await bootstrap();
  const date = ctx.date;
  console.log(`[daily] ${date} — fetching sources…\n`);

  // ① 采集 + 归一化（PR2）
  const { articles: ingestedArticles, rawArticles, crawled } = await ingestAll(ctx);

  // ② 9 道过滤（PR3；B-1 返回 filterResults 给 side-outputs 提取风险候选）
  const { articles, filterResults } = runFilterPipeline(ingestedArticles, ctx);

  // ③ AI 管线（PR4）
  const report = await runAiPipeline(articles, ctx);

  // ④ 历史写盘 + 滚动列表 + 近7天并入（PR4）
  const step = mergeRollingAndSaveHistory(report, articles, ctx);
  const { rolling, report: mergedReport, nowIso } = step;

  // ⑤ 三个旁路：必读/商机 / 股市复盘 / 股市清单（PR4；模式自适应由 ctx.mode 派发）
  //    B-1：filterResults 透传给 executive-summary，LLM 用其喂 risk 段
  const finalReport = await buildSideOutputs(
    mergedReport,
    step.history,
    articles,
    rawArticles,
    crawled,
    ctx,
    filterResults,
  );

  // ⑥ M2-④：AI 资产账本写回（daily 级：仅 trading；正文已随 report.json 落盘）
  const aiAssets = ctx.aiAssets;
  const dk = dailyAssetKey(date);
  const dailyPrev = assetDaily(aiAssets, date);
  aiAssets[dk] = {
    ...(dailyPrev ?? {}),
    updatedAt: nowIso,
  };
  saveAiAssets(aiAssets);
  ctx.log.info("ai", `AI 资产账本已更新: ${Object.keys(aiAssets).length} 键`);

  // ⑦ 展示限额（PR5；按价值评分 + 每源/每板块上限）
  const cappedReport = applyDisplayCaps(finalReport, ctx);

  // ⑧ 语音播报（PR5；失败/缺失不阻断发布）
  const audio = await synthesizeAudioIfAny(cappedReport, ctx);

  // ⑨ 渲染 + 写盘（PR5；唯一存储 + sidecar + 导出全量池）
  await renderAndWrite(
    { report: cappedReport, rolling, audio, filteredArticles: articles },
    ctx,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[daily] FAILED:`, e);
    process.exit(1);
  });
