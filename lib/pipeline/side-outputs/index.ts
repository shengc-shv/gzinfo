/**
 * 三个旁路编排（PR4 引入 + B-1）。
 *
 * 顺序：
 * 1. 必读/商机（hero_line + must_read + insights）—— 最高优先级
 * 2. 股市复盘三卡（stock_recap）—— 输入来自 rawArticles + crawled
 * 3. 股市消息清单（stock_news）—— 底部面板
 *
 * 每个 stage 返回新 report（非破坏性）；main 中可链式调用。
 *
 * B-1：filterResults（url → FilterResult）从 keyword-funnel 透传到 executive-summary，
 * 让 LLM 知道哪些文章已被关键词层标为风险候选，避免漏掉明显风险。
 */

import type { ArticleInput, DailyReport } from "../../types";
import type { HistoryStore } from "../../output/history";
import type { FilterResult } from "../../filters/types";
import type { CrawledBundle } from "../ingest";
import type { DailyContext } from "../context";
import { buildExecutiveSummary } from "./executive-summary";
import { buildStockRecap } from "./stock-recap";
import { buildStockNews } from "./stock-news";

/**
 * 执行三个旁路，返回最终 report。
 * history 在主流程中由调用方管理（saveHistory 返回新 store 后回传）。
 * filterResults（B-1）可选，缺省时 executive-summary 不传 risk_candidates 给 LLM。
 */
export async function buildSideOutputs(
  mergedReport: DailyReport,
  history: HistoryStore,
  filteredArticles: ArticleInput[],
  rawArticles: ArticleInput[],
  crawled: CrawledBundle,
  ctx: DailyContext,
  filterResults?: Map<string, FilterResult>,
): Promise<DailyReport> {
  // 1. 必读 / 商机
  let report = await buildExecutiveSummary(mergedReport, history, filteredArticles, ctx, filterResults);
  // 2. 股市复盘三卡
  report = await buildStockRecap(report, rawArticles, crawled, ctx);
  // 3. 股市消息清单
  report = await buildStockNews(report, rawArticles, crawled, ctx);
  return report;
}
