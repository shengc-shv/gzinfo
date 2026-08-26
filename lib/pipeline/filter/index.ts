/**
 * 过滤管线入口（PR3 + B-1）。
 *
 * 顺序遍历 FILTER_STAGES，对每个 stage：
 * - 若 stage.enabled() 返回 false → 跳过（保留原数组、不打日志）
 * - 否则调用 stage.apply()；若数量变化则记录日志
 *
 * B-1：返回 filterResults（url → FilterResult），供 side-outputs/.../executive-summary
 * 提取风险候选（risk_tracker 命中）喂给 LLM 的 risk 段。
 *
 * 行为与原 daily.ts main 中 105-245 行的 9 道过滤完全一致。
 */

import type { ArticleInput } from "../../types";
import type { FilterResult } from "../../filters/types";
import type { DailyContext } from "../context";
import type { FilterContext } from "./types";
import { FILTER_STAGES } from "./stages";
import { applyKeywordFilter } from "../../filters/keyword-filter";
import { loadKeywordConfig } from "../../filters/config";

/** 过滤管线产出（B-1 加）：articles + 各 url 的 FilterResult（用于风险候选回查） */
export interface FilterPipelineResult {
  articles: ArticleInput[];
  /** url → keyword 漏斗的 FilterResult。仅记录"留在池中"的文章（pass=true），供 side-outputs 提取 risk_tracker 命中 */
  filterResults: Map<string, FilterResult>;
}

/**
 * 构造 stage 共享上下文（从 DailyContext 投影）。
 * 一次构建、整条管线复用。
 */
function buildFilterContext(ctx: DailyContext): FilterContext {
  return {
    date: ctx.date,
    tierBySource: ctx.tierBySource,
    history: ctx.history,
    allSourceIds: new Set(ctx.sources.map((s) => s.id)),
    log: ctx.log,
  };
}

/**
 * 顺序执行所有 FILTER_STAGES，返回最终 articles 数组 + filterResults（B-1）。
 * 所有 stage 假定为纯函数（不 mutate 入参）。
 *
 * B-1 实现细节：keyword-funnel stage 内部用 applyKeywordFilter 计算 FilterResult，
 * 但 stage 输出不带这份数据。本函数在 stage 链跑完后**单独再跑一次** keyword 过滤
 * 给 pass=true 的文章建 url→FilterResult 表，供后续 side-outputs 提取风险。
 * 重复计算一次 keyword 过滤是 O(N) 字符串匹配，零 LLM 开销，可接受。
 */
export function runFilterPipeline(
  articles: ArticleInput[],
  ctx: DailyContext,
): FilterPipelineResult {
  const fctx = buildFilterContext(ctx);
  let cur = articles;
  for (const stage of FILTER_STAGES) {
    if (stage.enabled && !stage.enabled(fctx)) {
      ctx.log.info("filter", `⏭ ${stage.name} (disabled)`);
      continue;
    }
    cur = stage.apply(cur, fctx);
  }
  // B-1：单独再跑 keyword 过滤（仅 keyword 阶段），给 pass 的文章建 url→FilterResult
  // 让 side-outputs/.../executive-summary 能提取 risks 喂给 LLM 的 risk 段
  const filterResults = new Map<string, FilterResult>();
  if (cur.length > 0) {
    const kwConfig = loadKeywordConfig();
    for (const a of cur) {
      const r = applyKeywordFilter(
        {
          title: a.title ?? "",
          content: a.excerpt,
          sourceId: a.sourceId ?? "",
          url: a.url,
          category: a.category,
        },
        kwConfig,
      );
      if (r.risks && r.risks.length > 0) {
        filterResults.set(a.url, r);
      }
    }
  }
  return { articles: cur, filterResults };
}
