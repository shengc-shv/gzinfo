/**
 * 扎口：跨板块去重（2026-08-29 用户要求「合并同类项」）。
 *
 * 背景：同一事件（如房贷40年）因来源/分类不同，会**同时**进入 policy_market、
 * biz_insight，甚至经由东方财富爬虫进入 stock_news——报告里一处政策出现 7 次。
 * 入口（Stage 5 标题/指纹判重）只在**同一板块内**合并，跨板块仍需一道扎口。
 *
 * 规则：同一事件（URL 相同，或事件指纹共享 ≥2 个锚点）只在**一个**板块保留。
 * 板块保留优先级：policy_market > gz_local > biz_insight > tech > ipo
 *   —— 宏观政策归「政策与市场」；本地信息若未被政策板块收录则留在「广州本地」。
 *
 * 与入口判重互补：入口负责「同一事件多家转述只留一条」，扎口负责
 * 「同一事件不跨板块重复出现」，并顺带产出被移除条数便于日志观测。
 */
import type { DailyReport, ReportItem, ReportSectionKey } from "../types";
import { sameEvent } from "../ingest/dedup-similar";

/** 板块保留优先级（靠前者优先占位）。 */
const SECTION_PRIORITY: ReportSectionKey[] = [
  "policy_market",
  "gz_local",
  "biz_insight",
  "tech",
  "ipo",
];

function titleOf(it: ReportItem): string {
  return it.title_cn || it.title_orig || "";
}

/**
 * 跨板块去重（原地修改传入的 sections）。返回被移除的条目数。
 * 纯函数式副作用：只改动传入对象的数组引用，不触碰条目本身。
 */
export function dedupeSections(sections: DailyReport["sections"]): number {
  const seenUrls = new Set<string>();
  const keptTitles: string[] = [];
  let removed = 0;

  for (const sec of SECTION_PRIORITY) {
    const items = sections[sec];
    if (!Array.isArray(items)) continue;
    const out: ReportItem[] = [];
    for (const it of items) {
      const t = titleOf(it);
      // 1) 同 URL → 必定同一条，直接去重
      if (it.url && seenUrls.has(it.url)) {
        removed++;
        continue;
      }
      // 2) 同事件不同措辞（事件指纹共享 ≥2 锚点）→ 只保留优先级更高板块里的那一条
      if (t && keptTitles.some((k) => sameEvent(t, k))) {
        removed++;
        continue;
      }
      out.push(it);
      if (it.url) seenUrls.add(it.url);
      if (t) keptTitles.push(t);
    }
    sections[sec] = out;
  }
  return removed;
}

/**
 * 股市动态过滤（2026-08-29 用户：房贷40年出现在「股市动态」很奇怪）。
 * 移除那些已在主板块（sections）出现的宏观政策条目——它们虽影响板块，
 * 但对零售行领导属政策信息，应在政策板块，而不是混在股市新闻里。
 */
export function filterStockNewsAgainstSections<T extends { title_cn?: string; title_orig?: string; url?: string }>(
  news: T[],
  sections: DailyReport["sections"],
): T[] {
  const secTitles: string[] = [];
  for (const sec of SECTION_PRIORITY) {
    for (const it of sections[sec] ?? []) {
      const t = titleOf(it);
      if (t) secTitles.push(t);
    }
  }
  if (secTitles.length === 0) return news;
  return news.filter((n) => {
    const t = n.title_cn || n.title_orig || "";
    if (!t) return true;
    // 已是主板块条目 → 股市动态不再重复展示
    return !secTitles.some((k) => sameEvent(t, k));
  });
}
