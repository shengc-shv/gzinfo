/**
 * AI 管线入口（PR4）。
 *
 * 抽取自 daily.ts main 中：
 * - toPass1Input（归一化 ArticleInput → Pass1Input）
 * - generateDaily 调用（两阶段管线 + 13 条校验）
 *
 * 旁路：SKIP_AI 模式由 ctx.mode 派发 runner，无需 main 构造。
 * 历史/账本/资产相关仍由 main 持有（避免循环依赖）。
 */

import type { ArticleInput, DailyReport } from "../types";
import type { Pass1Input } from "../ai/pass1";
import {
  GZ_ANCHOR_RE,
} from "../output/render/cards";
import { LIGHT_AI_SOURCES, LIGHT_AI_RAW_CAP } from "../ai/light-ai";
import { generateDaily, makeSkipAiRunner } from "../ai/pipeline";
import type { DailyContext } from "./context";

/** 归一化 ArticleInput → Pass1Input：raw_text 截断 + date MM/DD + gz_hint 提权。 */
function toPass1Input(a: ArticleInput): Pass1Input {
  const d = a.publishedAt ?? a.fetchedAt;
  const date = d
    ? `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`
    : "";
  const isLight = LIGHT_AI_SOURCES.has(a.sourceId ?? "");
  const raw = (a.excerpt || a.summary || "").slice(0, isLight ? LIGHT_AI_RAW_CAP : 1200);
  return {
    url: a.url,
    title: a.title,
    source: a.source,
    date,
    raw_text: raw,
    category: a.category,
    // gz_hint 提权（2026-08-21 第二梯队）：标题命中广州锚词 → 标记，降低被
    // 保留标准第2~4条门槛刷掉的概率，Pass 1 倾向判 locale=gz / section=gz_local。
    gz_hint: GZ_ANCHOR_RE.test(a.title) || undefined,
  };
}

/**
 * 执行两阶段 AI 管线。
 *
 * - AI 模式：runner = undefined（generateDaily 内部走默认 LLM 路径）
 * - SKIP_AI 模式：从 ctx.mode 拿 summaryCache + relevantUrls → makeSkipAiRunner
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

  const runner =
    ctx.mode.kind === "skip-ai"
      ? makeSkipAiRunner(ctx.mode.summaryCache, ctx.mode.relevantUrls)
      : undefined;

  try {
    const report = await generateDaily(inputs, ctx.date, { runner });
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
