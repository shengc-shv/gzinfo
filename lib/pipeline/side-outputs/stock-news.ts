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
  return filterByWindow(items, win)
    .map((a) => toNewsItem(a, market))
    .slice(0, cap);
}

/**
 * P1④ 美股/港股 二次业务相关性过滤（纯函数，不耗 AI）。
 * 只留能挂钩客群/财富/私行/信贷/市场涨跌的条目；砍掉纯地缘/海外个股等弱相关噪声
 * （Buffett 96岁、伊朗去美元化、Trump 石油协议类）。A股为内地零售主战场，不过滤。
 */
const STOCK_BIZ_KW = [
  "财富", "私行", "理财", "保险", "基金", "黄金", "贵金属", "存款", "房贷", "消费贷",
  "经营贷", "信贷", "普惠", "客群", "高净值", "零售", "降息", "加息", "利率", "汇率",
  "人民币", "港元", "结售汇", "QDII", "分红", "股息", "回购", "港股通", "南向", "北水",
  "外资", "资金", "券商", "投行", "资本市场", "科创", "专精特新",
];
const STOCK_MARKET_KW = [
  "涨", "跌", "收评", "收盘", "盘", "指数", "恒指", "上证", "纳指", "道指", "标普",
  "板块", "成交", "市值", "业绩", "盈警", "盈喜", "财报", "破发", "创新高", "波动", "异动",
];
export function stockNewsRelevant(n: StockNewsItem): boolean {
  if (n.market === "a-share") return true; // A股为内地零售主战场，不过滤
  const t = `${n.title_cn || ""}${n.summary || ""}`;
  return STOCK_BIZ_KW.some((k) => t.includes(k)) || STOCK_MARKET_KW.some((k) => t.includes(k));
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
  // P1④ 美股/港股 二次业务相关性过滤：砍掉纯地缘/海外个股等弱相关噪声（纯函数，不耗 AI）
  const relNews = dedupedNews.filter(stockNewsRelevant);
  if (relNews.length !== dedupedNews.length) {
    ctx.log.info(
      "stock-news",
      `🧹 美股/港股弱相关过滤 ${dedupedNews.length - relNews.length} 条（纯地缘/海外个股噪声）`,
    );
  }
  ctx.log.info(
    "stock-news",
    `📋 股市消息清单构建：${relNews.filter((n) => n.market === "a-share").length} A股 / ${relNews.filter((n) => n.market === "hk").length} 港股 / ${relNews.filter((n) => n.market === "us").length} 美股`,
  );
  return { ...report, stock_news: relNews };
}
