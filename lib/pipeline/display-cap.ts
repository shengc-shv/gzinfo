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

/**
 * gz 展示保底（2026-09-01 用户指令 #2）：
 * 广州本地板块不足 GZ_FLOOR 条时，从其他板块（biz_insight/policy_market）的
 * locale==="gz" 条目（PASS1/merge 已按内容判定的广州锚）按价值分移入补足。
 * 宁缺毋滥：找不到相关候选就不补，绝不引入 locale!==gz 的「不相关」条目。
 */
const GZ_FLOOR = 3;

function ensureGzFloor(
  gz: ReportItem[],
  ...others: ReportItem[][]
): { gz: ReportItem[]; others: ReportItem[][] } {
  if (gz.length >= GZ_FLOOR) return { gz, others };
  // 收集候选并记录其来源板块索引，未选中的需放回原板块（不得丢失）
  const candidates: Array<{ it: ReportItem; listIdx: number }> = [];
  const kept = others.map((list, listIdx) => {
    const k: ReportItem[] = [];
    for (const it of list) {
      if (it.locale === "gz") candidates.push({ it, listIdx });
      else k.push(it);
    }
    return k;
  });
  // 价值分优先（importance + gz +5 + 业务线挂钩 +3），取最高的补足
  candidates.sort((a, b) => valueScore(b.it) - valueScore(a.it));
  const need = GZ_FLOOR - gz.length;
  const moved = candidates.slice(0, need);
  for (const c of candidates.slice(need)) kept[c.listIdx].push(c.it); // 未选中的放回原板块
  return { gz: [...gz, ...moved.map((c) => c.it)], others: kept };
}

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
  const cappedGz = capSrc(sec.gz_local ?? [], 4, 10);
  const cappedBiz = capSrc(sec.biz_insight ?? [], 4, 8);
  const cappedPolicy = capSrc(sec.policy_market ?? [], 4, 12);
  // gz 保底：不足 3 条时从 biz/policy 移入 locale=gz 条目（宁缺毋滥）
  const { gz, others } = ensureGzFloor(cappedGz, cappedBiz, cappedPolicy);
  const [biz, policy] = others;
  const newSections = {
    ...report.sections,
    gz_local: gz,
    biz_insight: biz,
    policy_market: policy,
  };

  const moved = gz.length - cappedGz.length;
  if (moved > 0) {
    ctx.log.info(
      "cap",
      `♻️ gz 展示保底：从 biz/policy 移入 ${moved} 条 locale=gz 条目（共 ${gz.length} 条，目标 ${GZ_FLOOR}）`,
    );
  } else if (gz.length < GZ_FLOOR) {
    ctx.log.info(
      "cap",
      `⚠️ gz 展示保底：池内 ${gz.length} 条且其他板块无 locale=gz 候选，宁缺毋滥（不引入不相关条目）`,
    );
  }

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
