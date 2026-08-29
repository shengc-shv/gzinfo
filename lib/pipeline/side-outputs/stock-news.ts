/**
 * 股市消息清单（底部「股市动态」面板，三市场）（PR4 引入）。
 *
 * 三市场原始新闻条目，按 A股/港股/美股 过滤展示。
 * 承载用户 2026-08-25 要求：把"具体板块细节与细节新闻"从顶部三卡下沉到底部消息清单。
 *
 * 模式自适应：
 * - AI 模式：analyzeStockNews 逐条归纳 → writeStockNews 持久化
 * - SKIP_AI 模式：仅从 store.json 复用；缺失则回退原始清单（打 warn）
 *
 * 注意：crawled 在 SKIP_AI 下仍抓取（fetchCrawled 不感知 mode），所以此 stage 仍能跑。
 */

import type { ArticleInput, DailyReport, StockNewsItem } from "../../types";
import type { CrawledArticle } from "../../ingest/merge";
import { filterByWindow } from "../../ingest/merge";
import { analyzeStockNews, writeStockNews, loadStockNews } from "../../ai/stock-news-analysis";
import { filterStockNewsAgainstSections } from "../../output/dedupe-sections";
import type { DailyContext } from "../context";

interface CrawledSubset {
  stocks: CrawledArticle[];
}

function toNewsItem(
  a: { title?: string; summary?: string; url?: string; source?: string; publishedAt?: Date | string },
  market: "a-share" | "hk" | "us",
): StockNewsItem {
  const pub =
    a.publishedAt !== undefined
      ? typeof a.publishedAt === "string"
        ? a.publishedAt
        : new Date(a.publishedAt).toISOString()
      : "";
  const mmdd = pub ? `${pub.slice(5, 7)}/${pub.slice(8, 10)}` : "";
  const summary = (a.summary || a.title || "").slice(0, 90).trim();
  return {
    url: a.url || "",
    title_cn: a.title || "无标题",
    source: a.source || "",
    source_type: "media",
    date: mmdd,
    summary: summary || (a.title || "无标题"),
    importance: 2,
    rank: 0,
    tags: [],
    locale: market === "us" ? "overseas" : "national",
    market,
  };
}

/**
 * 收集某市场的新闻（按窗口过滤 + 限条数）。
 */
function collect(
  items: Array<{ title?: string; summary?: string; url?: string; source?: string; publishedAt?: Date | string }>,
  market: "a-share" | "hk" | "us",
  win: number,
  cap: number,
): StockNewsItem[] {
  return filterByWindow(
    items as Array<{ publishedAt?: Date | string; fetchedAt?: Date }>,
    win,
  )
    .map((a) => toNewsItem(a, market))
    .slice(0, cap);
}

/**
 * 生成股市消息清单并写入 report.stock_news。
 * 返回新 report（不 mutate 入参）。空输入 → 返回原 report。
 */
export async function buildStockNews(
  report: DailyReport,
  rawArticles: ArticleInput[],
  crawled: CrawledSubset,
  ctx: DailyContext,
): Promise<DailyReport> {
  const PER_MARKET_CAP = 12;
  const rawNews: StockNewsItem[] = [
    ...collect(crawled.stocks.filter((a) => a.subcategory === "a-share"), "a-share", 3, PER_MARKET_CAP),
    ...collect(crawled.stocks.filter((a) => a.subcategory === "hk"), "hk", 3, PER_MARKET_CAP),
    ...collect(
      rawArticles.filter((a) => a.category === "stocks" && a.subcategory === "us"),
      "us",
      4,
      PER_MARKET_CAP,
    ),
  ];
  if (rawNews.length === 0) return report;

  const skipAi = ctx.mode.kind === "skip-ai";
  let news: StockNewsItem[] = rawNews;
  if (skipAi) {
    const persisted = loadStockNews(ctx.date);
    if (persisted) {
      news = persisted;
    } else {
      ctx.log.warn("stock-news", `⚠️ SKIP_AI 但 store 无 stock_news，回退原始清单`);
    }
  } else {
    // 与其它板块同逻辑：线上由 LLM 逐条归纳（中性事实，禁业务引申），并持久化供 SKIP_AI 复用
    news = await analyzeStockNews(rawNews);
    writeStockNews(ctx.date, news);
  }
  // 2026-08-29 用户：房贷40年出现在「股市动态」很奇怪。
  // 股市动态只承载市场/板块/个股信号——剔除已在主板块（政策/商机/本地等）出现的宏观政策条目。
  const dedupedNews = filterStockNewsAgainstSections(news, report.sections);
  if (dedupedNews.length !== news.length) {
    ctx.log.info(
      "stock-news",
      `🧹 股市动态剔除 ${news.length - dedupedNews.length} 条已在主板块出现的宏观政策条目`,
    );
  }
  ctx.log.info(
    "stock-news",
    `📋 股市消息清单构建：${dedupedNews.filter((n) => n.market === "a-share").length} A股 / ${dedupedNews.filter((n) => n.market === "hk").length} 港股 / ${dedupedNews.filter((n) => n.market === "us").length} 美股`,
  );
  return { ...report, stock_news: dedupedNews };
}
