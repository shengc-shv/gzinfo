/**
 * 展示层限额（PR5 抽出，PR4 内联在 main 的 50 行块）。
 *
 * 业务逻辑（2026-08-25 用户指令：行长每天最多看 5 分钟，几百条无意义；
 * 2026-08-29 P0 收敛：信息精确性>信息丰富性 + 价值优先）：
 * - 每源 ≤4 条（保来源多样性，避免单一媒体占满板块），但**按价值排序选取**
 *   （importance 必知>默认>折叠 + 广州本地 + 业务线挂钩 优先），再按板块 rank 恢复顺序；
 * - 每板块总量 ≤ N（gz ≤10 / biz ≤8 / policy ≤12）；
 * - 股市新闻面板每市场 ≤5（三张解读卡已有板块总结，下面不堆几十条）。
 *
 * 返回新 report（不 mutate 入参）。
 */

import type { DailyReport, ReportItem } from "../types";
import type { DailyContext } from "./context";

/** 业务线挂钩 tags（命中加 3 分） */
const BIZ_TAGS = new Set(["财富", "信贷", "私行", "客群", "贵金属", "保险", "对公", "财富管理"]);

/** 价值评分（以客户为中心）：importance 权重最高，其次广州本地、业务线挂钩 */
function valueScore(it: ReportItem): number {
  let s = 0;
  s += (it.importance ?? 2) * 10; // 3=今日必知 30 / 2=默认 20 / 1=折叠 10
  if (it.locale === "gz") s += 5; // 广州本地优先
  if ((it.tags ?? []).some((t) => BIZ_TAGS.has(t))) s += 3; // 与零售业务线挂钩
  return s;
}

/** 每源按价值排序选取 ≤perSrc 条，再按板块 rank 恢复顺序后取 maxTotal。 */
function capSrc(items: ReportItem[], perSrc: number, maxTotal: number): ReportItem[] {
  const bySrc = new Map<string, ReportItem[]>();
  for (const it of items) {
    const s = it.source || "?";
    if (!bySrc.has(s)) bySrc.set(s, []);
    bySrc.get(s)!.push(it);
  }
  const selected: ReportItem[] = [];
  for (const list of bySrc.values()) {
    const ranked = [...list].sort((a, b) => valueScore(b) - valueScore(a));
    selected.push(...ranked.slice(0, perSrc));
  }
  return selected
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .slice(0, maxTotal);
}

/**
 * 应用展示限额并返回新 report。
 * 行为与原 daily.ts main 中 66-119 行完全一致。
 */
export function applyDisplayCaps(report: DailyReport, ctx: DailyContext): DailyReport {
  const sec = report.sections as unknown as Record<string, ReportItem[]>;
  const newSections = {
    ...report.sections,
    gz_local: capSrc(sec.gz_local ?? [], 4, 10),
    biz_insight: capSrc(sec.biz_insight ?? [], 4, 8),
    policy_market: capSrc(sec.policy_market ?? [], 4, 12),
  };

  // 股市新闻面板：每市场 ≤5
  let newStockNews = report.stock_news;
  if (Array.isArray(report.stock_news)) {
    const byMkt = new Map<string, NonNullable<typeof report.stock_news>>();
    for (const n of report.stock_news) {
      const m = n.market || "?";
      if (!byMkt.has(m)) byMkt.set(m, []);
      byMkt.get(m)!.push(n);
    }
    const cappedNews: NonNullable<typeof report.stock_news> = [];
    for (const list of byMkt.values()) cappedNews.push(...list.slice(0, 5));
    newStockNews = cappedNews;
  }

  ctx.log.info(
    "cap",
    `📉 展示限额(价值排序): gz ${newSections.gz_local.length} / biz ${newSections.biz_insight.length} / policy ${newSections.policy_market.length} / stock_news ${newStockNews?.length ?? 0}`,
  );

  return { ...report, sections: newSections, stock_news: newStockNews };
}
