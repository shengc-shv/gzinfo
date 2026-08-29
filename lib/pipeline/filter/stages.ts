/**
 * 9 道过滤 stage 实现（PR3）。
 *
 * 顺序与原 daily.ts main 中 105-245 行严格一致：
 *   1. pre-window-2d        —— 源层前置窗口（FETCH_WINDOW_DAYS=2）
 *   2. single-institution   —— 单家非白名单金融机构新闻
 *   3. stock-single         —— 股市单股新闻（非巨头/非广州本地）
 *   4. keyword-funnel       —— 银行零售关键词漏斗（v4，五维命中 + 五商机追踪器）
 *   5. title-similarity     —— 标题相似度判重（同主题/同 tier）
 *   6. display-window-2d    —— 展示窗口（DISPLAY_WINDOW_DAYS=2，旧文过滤）
 *   7. cross-day-dedup      —— 跨天标题判重（与历史库先来者合并）
 *   8. no-date-fallback     —— 无发布时间兜底丢弃
 *   9. per-source-cap-10    —— 每源限额（每源 ≤ LIGHT_AI_MAX_PER_SOURCE=10）
 *
 * 行为差异：keyword-funnel stage 移除了原 main 中给 article 写 filterBucket/filterDimensions/
 * filterOpportunities 的"幽灵字段"——grep 验证全仓无读，**这是死代码**（与 PR1 死代码清理同性质）。
 * 此外 keyword-funnel 保留"全量误杀回退保底"行为。
 */

import { filterByWindow } from "../../ingest/merge";
import { filterSingleInstitution } from "../../filters/single-institution";
import { filterStockNews } from "../../filters/stock-single";
import { applyKeywordFilter } from "../../filters/keyword-filter";
import {
  keywordFilterEnabled,
  keywordFilterFallbackEnabled,
  loadKeywordConfig,
  dedupSimilarEnabled,
  loadDedupConfig,
} from "../../filters/config";
import {
  dedupeByTitleSimilarity,
  dedupeAgainstHistory,
  type HistorySimilarEntry,
} from "../../ingest/dedup-similar";
import { DISPLAY_WINDOW_DAYS } from "../../output/render/cards";
import { FETCH_WINDOW_DAYS } from "../../output/history";
import { capLightAiSources, LIGHT_AI_MAX_PER_SOURCE } from "../../ai/light-ai";
import { scoreBranchRelevance } from "../../ai/relevance-score";
import type { ArticleInput } from "../../types";
import type { FilterStage } from "./types";

/**
 * Stage 1：源层前置窗口（2026-08-20 用户决策：减少滚动列表白抓；2026-08-22 改为抓 2 天）。
 * RSS/爬虫抓的是滚动列表，天然混入超窗口旧文；先按 FETCH_WINDOW_DAYS 截断。
 */
const preWindowStage: FilterStage = {
  name: "pre-window-2d",
  apply: (articles, ctx) => {
    const before = articles.length;
    const out = filterByWindow(articles, FETCH_WINDOW_DAYS);
    if (out.length !== before) {
      ctx.log.info(
        "filter",
        `🧹 源层前置窗口过滤: ${before} → ${out.length} 条（移除 ${before - out.length} 条超 ${FETCH_WINDOW_DAYS} 天旧文）`,
      );
    }
    return out;
  },
};

/**
 * Stage 2：单机构新闻过滤（2026-08-25 用户决定，永久生效）。
 * 单家非白名单（六大国有行 + 广州银行）金融机构新闻 → 丢；≥2 家或 0 家 → 留。
 */
const singleInstitutionStage: FilterStage = {
  name: "single-institution",
  apply: (articles, ctx) => {
    const before = articles.length;
    const out = filterSingleInstitution(articles);
    if (out.length !== before) {
      ctx.log.info(
        "filter",
        `🏛️ 单机构过滤: ${before} → ${out.length} 条（移除 ${before - out.length} 条非白名单单机构新闻）`,
      );
    }
    return out;
  },
};

/**
 * Stage 3：股市单股过滤（2026-08-25 用户决定，永久生效；仅 stocks 类）。
 * 仅留巨头 + 广州本地大企业 + 宏观/指数/板块级；其他单股 → 丢。
 */
const stockSingleStage: FilterStage = {
  name: "stock-single",
  apply: (articles, ctx) => {
    const before = articles.length;
    const out = filterStockNews(articles);
    if (out.length !== before) {
      ctx.log.info(
        "filter",
        `📈 股市单股过滤: ${before} → ${out.length} 条（移除 ${before - out.length} 条非巨头/非广州本地单股新闻）`,
      );
    }
    return out;
  },
};

/**
 * Stage 4：关键词漏斗（边界③最前端，零成本）。
 * 未命中即丢（决策②：硬过滤）；KEYWORD_FILTER=off 旁路。
 * 全量误杀时回退保底（避免空报告）。
 */
const keywordFunnelStage: FilterStage = {
  name: "keyword-funnel",
  enabled: () => keywordFilterEnabled(),
  apply: (articles, ctx) => {
    const kwConfig = loadKeywordConfig();
    const before = articles.length;
    const keep: ArticleInput[] = [];
    let opp = 0;
    let weekly = 0;
    for (const a of articles) {
      const r = applyKeywordFilter(
        {
          title: a.title,
          content: a.excerpt,
          sourceId: a.sourceId,
          url: a.url,
          category: a.category, // 参考区（tech/ipo/gd-ipo/politics）豁免漏斗，仅商机扫描
        },
        kwConfig,
      );
      if (!r.pass) continue;
      keep.push(a);
      if (r.bucket === "opportunity") opp++;
      if (r.bucket === "weekly") weekly++;
    }
    if (keep.length === 0 && keywordFilterFallbackEnabled()) {
      ctx.log.warn(
        "filter",
        `⚠️ 关键词漏斗将全部 ${before} 条过滤为 0（疑似误杀/词表过严）— 回退全量保底，避免空报告`,
      );
      return articles;
    }
    ctx.log.info(
      "filter",
      `🔻 关键词漏斗: ${before} → ${keep.length} 条（商机 ${opp} / 周报 ${weekly}，其余日报池）`,
    );
    return keep;
  },
};

/**
 * Stage 5：标题相似度判重（归一化②，漏斗之后 AI 之前）。
 * 同主题最多 maxPerTheme 条、同 tier 只留 1。
 */
const titleSimilarityStage: FilterStage = {
  name: "title-similarity",
  enabled: () => dedupSimilarEnabled(),
  apply: (articles, ctx) => {
    const dd = loadDedupConfig();
    const before = articles.length;
    const { kept, removed } = dedupeByTitleSimilarity(articles, {
      threshold: dd.threshold,
      maxPerTheme: dd.maxPerTheme,
    });
    if (removed.length > 0) {
      ctx.log.info(
        "filter",
        `🔁 标题相似度判重: ${before} → ${kept.length} 条（阈值 ${dd.threshold}、每主题 ≤${dd.maxPerTheme}、同 tier 只留 1；移除 ${removed.length} 条重复报道）`,
      );
    }
    return kept;
  },
};

/**
 * Stage 6：超窗口旧文过滤（展示窗口 DISPLAY_WINDOW_DAYS=2）。
 * rss 流混入的展示窗口外旧文不进 AI、不展示。
 */
const displayWindowStage: FilterStage = {
  name: "display-window-2d",
  apply: (articles, ctx) => {
    const before = articles.length;
    const out = filterByWindow(articles, DISPLAY_WINDOW_DAYS);
    if (out.length !== before) {
      ctx.log.info(
        "filter",
        `🗓 超窗口旧文过滤: ${before} → ${out.length} 条（移除 ${before - out.length} 条超 ${DISPLAY_WINDOW_DAYS} 天窗口旧文）`,
      );
    }
    return out;
  },
};

/**
 * Stage 7：跨天标题判重（先来后到）。
 * 新抓取 vs 历史库已有条目；历史先来者优先占位。
 */
const crossDayDedupStage: FilterStage = {
  name: "cross-day-dedup",
  apply: (articles, ctx) => {
    const histSim: HistorySimilarEntry[] = Object.values(ctx.history).map((e) => ({
      title: e.title,
      url: e.url,
      tier: ctx.tierBySource.get(e.sourceId),
    }));
    const before = articles.length;
    const { kept, removed } = dedupeAgainstHistory(articles, histSim, { maxPerTheme: 2 });
    if (removed.length > 0) {
      ctx.log.info(
        "filter",
        `🔄 跨天标题判重: ${before} → ${kept.length} 条（历史库已覆盖 ${removed.length} 条重复主题）`,
      );
    }
    return kept;
  },
};

/**
 * Stage 8：无发布时间兜底（2026-08-21 用户要求）。
 * 无 publishedAt 的条目防御性丢弃（未来任何源若产出无日期条目，直接在此丢弃）。
 */
const noDateFallbackStage: FilterStage = {
  name: "no-date-fallback",
  apply: (articles, ctx) => {
    const before = articles.length;
    const out = articles.filter((a) => a.publishedAt);
    if (out.length < before) {
      ctx.log.info(
        "filter",
        `⏭ 无发布时间/日期条目 ${before - out.length} 条跳过 AI 分析（兜底丢弃）`,
      );
    }
    return out;
  },
};

/**
 * Stage 9：每源限额（2026-08-25 用户指令：所有媒体源每源 ≤10 条进 LLM 分析/展示）。
 */
const perSourceCapStage: FilterStage = {
  name: "per-source-cap-10",
  apply: (articles, ctx) => {
    const before = articles.length;
    // 2026-08-29 价值预筛：每源限额不再「取最新」，改用分行相关性评分降序——
    // 高分行相关性条目优先进 AI，低价值条目让位（命中「价值优先」+「节约AI」）。
    const out = capLightAiSources(
      articles,
      ctx.allSourceIds,
      LIGHT_AI_MAX_PER_SOURCE,
      (a) =>
        scoreBranchRelevance({
          title: a.title_cn ?? a.title ?? "",
          summary: a.summary ?? "",
          sourceId: a.source,
          category: a.category,
          subcategory: a.subcategory,
          url: a.url,
        }).score,
    );
    if (out.length < before) {
      ctx.log.info(
        "filter",
        `🔻 每源限额: 移除 ${before - out.length} 条（全部媒体源每源≤${LIGHT_AI_MAX_PER_SOURCE} 条进 LLM 分析/展示）`,
      );
    }
    return out;
  },
};

/** 9 道 stage 顺序数组。调换顺序 = 改这一行。 */
export const FILTER_STAGES: FilterStage[] = [
  preWindowStage,
  singleInstitutionStage,
  stockSingleStage,
  keywordFunnelStage,
  titleSimilarityStage,
  displayWindowStage,
  crossDayDedupStage,
  noDateFallbackStage,
  perSourceCapStage,
];
