/**
 * 历史 / 滚动 / 合并（PR4 引入）。
 *
 * 抽取自 daily.ts main 中：
 * - saveHistory（写盘：含今日 AI 摘要）
 * - buildRolling（当天 + 过去 30 天滚动列表）
 * - mergeRollingIntoReport（近 7 天历史并入对应板块）
 *
 * 注意：history 是从 ctx 拿，但本函数返回**新的** history（saveHistory 返回新 store）。
 * 调用方需要把返回的 history 写回 ctx（PR5 会让 history 完全归 ctx 拥有，本步骤只动一次）。
 */

import {
  buildRolling,
  saveHistory,
  type HistoryStore,
} from "../output/history";
import { mergeRollingIntoReport } from "../output/render";
import type { ArticleInput, DailyReport, ReportItem } from "../types";
import type { DailyContext } from "./context";

export interface HistoryStepResult {
  /** 新 history（已写盘 + 含今日） */
  history: HistoryStore;
  /** 滚动列表（当天 + 过去 30 天） */
  rolling: ArticleInput[];
  /** 近 7 天并入后的 report */
  report: DailyReport;
  /** ISO 时间戳（写盘时间） */
  nowIso: string;
}

/**
 * 保存 history + 构建 rolling + merge rolling 到 report。
 *
 * 与原 main 行为完全一致：
 * 1. saveHistory 写盘（articles 携带的 AI 摘要进入 history 缓存）
 * 2. buildRolling 拼当天 + 过去 30 天
 * 3. mergeRollingIntoReport 把近 7 天历史并入对应板块
 */
export function mergeRollingAndSaveHistory(
  report: DailyReport,
  filteredArticles: ArticleInput[],
  ctx: DailyContext,
  nowIso: string = new Date().toISOString(),
): HistoryStepResult {
  const history = saveHistory(filteredArticles, ctx.history, nowIso);
  const rolling = buildRolling(filteredArticles, history);
  ctx.log.info(
    "history",
    `历史缓存已更新: ${Object.keys(history).length} 条（含今日 ${filteredArticles.length} 条）；渲染滚动列表 ${rolling.length} 条`,
  );

  const mergedReport = mergeRollingIntoReport(report, rolling, ctx.tierBySource);
  const totalKept = (Object.values(report.sections) as ReportItem[][]).reduce(
    (n, s) => n + s.length,
    0,
  );
  const mergedCount = (Object.values(mergedReport.sections) as ReportItem[][]).reduce(
    (n, s) => n + s.length,
    0,
  );
  if (mergedCount !== totalKept) {
    ctx.log.info(
      "history",
      `🕘 近7天历史并入: ${totalKept} → ${mergedCount} 条（追加 ${mergedCount - totalKept} 条历史符合要求条目）`,
    );
  }

  return { history, rolling, report: mergedReport, nowIso };
}
