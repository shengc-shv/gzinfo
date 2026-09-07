/**
 * AI 管线入口（PR4）。
 *
 * 抽取自 daily.ts main 中：
 * - toPass1Input（已抽到 ./pass1-input，M4 为解循环依赖）
 * - generateDaily 调用（两阶段管线 + 13 条校验）
 *
 * 旁路：SKIP_AI 模式由 ctx.mode 派发 runner，无需 main 构造。
 * 历史/账本/资产相关仍由 main 持有（避免循环依赖）。
 *
 * M4（2026-09-07）：接入 TagStore 缓存复用——命中标签库的条目零 LLM，
 * 未命中才走真 LLM；任何异常自动回退原全量路径，保证不漏损。
 */

import type { ArticleInput, DailyReport } from "../types";
import type { Pass1Input } from "../ai/pass1";
import { generateDaily, makeSkipAiRunner } from "../ai/pipeline";
import { toPass1Input } from "./pass1-input";
import { runCachedAiPipeline } from "../tagstore/pipeline";
import { tagStoreEnabled } from "../tagstore/store";
import type { DailyContext } from "./context";

/**
 * 执行两阶段 AI 管线。
 *
 * - SKIP_AI 模式：从 ctx.mode 拿 summaryCache + relevantUrls → makeSkipAiRunner（零 LLM）
 * - AI 模式 + 缓存开启：走 runCachedAiPipeline（分流复用，仅未命中调 LLM）
 * - AI 模式 + 缓存关闭：走原 generateDaily 全量（等价改造前）
 *
 * 失败抛错（与原 main 行为一致：管线失败 = 整个 daily 失败）。
 */
export async function runAiPipeline(
  articles: ArticleInput[],
  ctx: DailyContext,
): Promise<DailyReport> {
  const inputs: Pass1Input[] = articles.map(toPass1Input);
  ctx.log.info(
    "ai",
    `进入两阶段 AI 管线：${inputs.length} 条（PASS1 筛选 + PASS2 成稿 + 校验回炉/降级）`,
  );

  // SKIP_AI：完全本地合成，零 LLM（原行为，最高优先级）
  if (ctx.mode.kind === "skip-ai") {
    const runner = makeSkipAiRunner(ctx.mode.summaryCache, ctx.mode.relevantUrls);
    try {
      return await generateDaily(inputs, ctx.date, { runner });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`[daily] 管线生成失败：${msg}`);
    }
  }

  // M4：缓存复用路径（TAG_STORE=0 或 TAG_CACHE_PIPELINE=0 可关闭）
  const cacheOn = tagStoreEnabled() && process.env.TAG_CACHE_PIPELINE?.trim() !== "0";
  if (cacheOn) {
    try {
      const { report, stats } = await runCachedAiPipeline(articles, ctx);
      ctx.log.info(
        "ai",
        `管线产出（缓存复用）：正文 ${stats.finalItems} 条（复用 ${stats.reused} / LLM ${stats.llm}）`,
      );
      return report;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 不漏损：缓存路径任何异常都回退原全量路径
      console.error(`[ai] ⚠️ 缓存管线异常，回退全量 LLM 路径：${msg}`);
    }
  }

  try {
    const report = await generateDaily(inputs, ctx.date, {});
    const totalKept = (Object.values(report.sections) as { length: number }[]).reduce(
      (n, s) => n + s.length,
      0,
    );
    ctx.log.info(
      "ai",
      `管线产出：必读 ${report.must_read.length} 条 / 商机 ${report.insights.length} 条 / 正文 ${totalKept} 条`,
    );
    return report;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[daily] 管线生成失败：${msg}`);
  }
}
