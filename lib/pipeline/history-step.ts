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
 * PASS2 摘要回流（2026-09-01）。
 *
 * 背景：report.sections 里的 AI 摘要此前**从未回流**到 articles —— saveHistory 写的是
 * 原始 articles（只带源层 excerpt），于是 LLM 每天现写的解读写完即弃，次日重抓同一条
 * 时历史库里仍是裸的。CI 归档实证：08-31 真 AI 模式跑完后，firstSeen=08-31 的 128 条
 * 中有 summary 的 **0 条**。
 *
 * 语义（与 PASS1/PASS2 职责一致）：
 *  - 进入 report.sections = PASS1 判定「值得保留」→ relevant: true（AI 认定相关）；
 *  - PASS2 为该条目写的 summary = AI 解读 → 写回 articles.summary；
 *  - PASS1 drop 的条目不动：业务关系不大，不值得再花 LLM 写摘要（符合设计，省成本）。
 *
 * 覆盖策略：仅在条目原本**没有** summary 时回填。原因：SKIP_AI 模式下 sections 的摘要
 * 本就来自 history 缓存，覆盖是幂等的，但历史预分析补标的精心摘要不能被 PASS2 的
 * 降级产物（`raw_text.slice(0, 90)` 原文截断）冲掉。
 */
export function backfillAiSummary(
  report: DailyReport,
  articles: ArticleInput[],
): { articles: ArticleInput[]; count: number } {
  const aiByUrl = new Map<string, string>();
  for (const arr of Object.values(report.sections) as ReportItem[][]) {
    for (const it of arr) {
      const s = (it.summary ?? "").trim();
      if (it.url && s) aiByUrl.set(it.url, s);
    }
  }
  if (aiByUrl.size === 0) return { articles, count: 0 };

  let count = 0;
  const out = articles.map((a): ArticleInput => {
    const s = aiByUrl.get(a.url);
    if (!s) return a;
    if (a.summary && a.summary.trim()) return a; // 已有摘要不覆盖
    count++;
    return { ...a, summary: s, relevant: true };
  });
  return { articles: out, count };
}

/**
 * 保存 history + 构建 rolling + merge rolling 到 report。
 *
 * 与原 main 行为完全一致（2026-09-01 增 PASS2 摘要回流）：
 * 0. backfillAiSummary（今日 AI 解读写回 articles）
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
  // 0. PASS2 摘要回流：今日被 AI 解读过的条目带摘要入历史库，供次日两天池 / 滚动并入复用
  const backfill = backfillAiSummary(report, filteredArticles);
  const articlesForHistory = backfill.articles;

  const history = saveHistory(articlesForHistory, ctx.history, nowIso);
  const rolling = buildRolling(articlesForHistory, history);
  ctx.log.info(
    "history",
    `历史缓存已更新: ${Object.keys(history).length} 条（含今日 ${filteredArticles.length} 条）；渲染滚动列表 ${rolling.length} 条`,
  );
  if (backfill.count > 0) {
    ctx.log.info(
      "history",
      `♻️ PASS2 摘要回流：${backfill.count} 条今日 AI 解读写入历史库（次日可复用，不再重复烧 LLM）`,
    );
  }

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
