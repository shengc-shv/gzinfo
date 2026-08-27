/**
 * 昨日股市复盘三卡（美股 / A股 / 港股）（PR4 引入）。
 *
 * 输入来自原始抓取（不经 PASS1 过滤，复盘参考区豁免漏斗）：
 * - 美股：rawArticles 中 category=stocks & subcategory=us
 * - A股：crawled.stocks 中 subcategory=a-share
 * - 港股：crawled.stocks 中 subcategory=hk
 *
 * 模式自适应：
 * - AI 模式：合并三市场 → fetchMarketQuotes（行情指数） → generateStockRecap → writeStore
 * - SKIP_AI 模式：仅从 store.json 复用，零 LLM；quotes 也不取（store 中已含指数）
 *
 * 失败优雅降级（无 recap → 页面不渲染该区，不阻断整页）。
 */

import type { ArticleInput, DailyReport } from "../../types";
import type { CrawledArticle } from "../../ingest/merge";
import {
  generateStockRecap,
  writeStockRecap,
  loadStockRecap,
  selectStockRecap,
  synthesizeFallbackCard,
  type StockItem,
} from "../../ai/stock-recap";
import { filterByWindow } from "../../ingest/merge";
import { fetchMarketQuotes, prevTradingDay } from "../../sources/quote-api";
import type { DailyContext } from "../context";

interface CrawledSubset {
  stocks: CrawledArticle[];
}

function toStockItem(it: {
  title?: string;
  summary?: string;
  url?: string;
  source?: string;
  publishedAt?: Date | string;
}): StockItem {
  return {
    title: it.title || "无标题",
    summary: it.summary || "",
    url: it.url || "",
    source: it.source || "",
    publishedAt: it.publishedAt
      ? typeof it.publishedAt === "string"
        ? it.publishedAt.slice(0, 10)
        : new Date(it.publishedAt).toISOString().slice(0, 10)
      : undefined,
  };
}

/**
 * 生成股市复盘三卡并写入 report.stock_recap。
 * 返回新 report（不 mutate 入参）。失败返回原 report。
 */
export async function buildStockRecap(
  report: DailyReport,
  rawArticles: ArticleInput[],
  crawled: CrawledSubset,
  ctx: DailyContext,
): Promise<DailyReport> {
  const date = ctx.date;
  const skipAi = ctx.mode.kind === "skip-ai";

  // 美股：用 fetchAll 原始快照（未受全局 2 天窗口过滤），本地 4 天窗口兜底防陈旧。
  // 保证周一/节后首跑也能取到「上一美股交易日」的收盘复盘。
  const usItems: StockItem[] = filterByWindow(
    rawArticles.filter((a) => a.category === "stocks" && a.subcategory === "us"),
    4,
  ).map(toStockItem);
  const aShareItems: StockItem[] = crawled.stocks
    .filter((a) => a.subcategory === "a-share")
    .map(toStockItem);
  const hkItems: StockItem[] = crawled.stocks
    .filter((a) => a.subcategory === "hk")
    .map(toStockItem);

  const persistedRecap = loadStockRecap(date);
  // 行情指数（新浪行情 API）：取「上一交易日」收盘精确点位 + 涨跌幅；
  // 失败优雅降级（quotes=null → 三卡缺指数块，不阻断整页）。
  // 2026-08-27 修：SKIP_AI 也拉指数（fetchMarketQuotes 不调 LLM，仅 HTTP），
  // 让 synthesizeFallbackCard 在 SKIP_AI 也能用指数合成空卡 → 港股/A股永不空。
  const quotes = await fetchMarketQuotes(prevTradingDay(date));

  try {
    const recap = await selectStockRecap({
      skipAi,
      persisted: persistedRecap,
      generate: () =>
        generateStockRecap({ date, us: usItems, aShare: aShareItems, hk: hkItems }, quotes),
    });
    if (!recap) {
      ctx.log.info("recap", "ℹ️ 股市复盘无可用输入或生成失败（跳过该区）");
      return report;
    }
    // 2026-08-27 修：selectStockRecap 在 LLM 模式优先用 persisted（绕过了 generate 内的
    // synthesizeFallbackCard）。这里对任何空卡**始终**应用指数兜底 — 即使 persisted
    // 里的 hk/us/aShare 仍空、quotes 有数据，也用指数合成最小复盘。
    if (quotes) {
      recap.us = synthesizeFallbackCard(recap.us, quotes.quotes.us) ?? recap.us;
      recap.aShare = synthesizeFallbackCard(recap.aShare, quotes.quotes.aShare) ?? recap.aShare;
      recap.hk = synthesizeFallbackCard(recap.hk, quotes.quotes.hk) ?? recap.hk;
    }
    if (!skipAi) {
      writeStockRecap(date, recap);
      ctx.log.info(
        "recap",
        `📈 股市复盘三卡生成：美股 ${usItems.length} / A股 ${aShareItems.length} / 港股 ${hkItems.length} 条输入`,
      );
    } else {
      ctx.log.info("recap", "📈 SKIP_AI 复用 store.json 股市复盘三卡");
    }
    return { ...report, stock_recap: recap };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log.warn("recap", `⚠️ 股市复盘生成失败（继续）: ${msg}`);
    return report;
  }
}
