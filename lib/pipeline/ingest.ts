/**
 * 采集 + 归一化（PR2）。
 *
 * 抽取自 daily.ts 原 126-228 行（fetchAll + 爬虫合并 + 本地手动采集 + tier 补齐）。
 * 负责边界①（采集）+ 边界②（归一化）的**数据汇合**部分（URL 去重 + region 分流）；
 * 后续 8 道过滤在 PR3 由 lib/pipeline/filter/ 处理。
 *
 * 设计原则：
 * - ingest 不知道 mode（SKIP_AI 也走相同的采集路径，与原行为一致）
 * - 源级失败非致命（per-source try/catch 保留在 fetchAll）
 * - 爬虫失败非致命（try/catch 包住整个 fetchCrawledArticles）
 * - tier 补齐在此完成（一次扫描，不再在 main 单独跑）
 * - 返回 rawArticles 供后续「股市复盘」使用（美股原始抓取不经过窗口过滤）
 */

import { fetchSource } from "../sources/dispatch";
import { fetchCrawledArticles } from "../sources/crawlers";
import {
  toMergeArticle,
  dedupeByUrl,
  type CrawledArticle,
} from "../ingest/merge";
import { SOURCE_ROUTE } from "../sources/constants";
import {
  loadLocalAcquired,
  filterLocalAcquiredRecent,
} from "../sources/local-acquired";
import type { ArticleInput } from "../types";
import type { Category } from "../sources/types";
import type { DailyContext } from "./context";

/** 抓取产物结构：与 PR4 side-outputs 共享（股市复盘三卡直接消费 crawled.stocks）。 */
export interface CrawledBundle {
  ipo: CrawledArticle[];
  gz: CrawledArticle[];
  stocks: CrawledArticle[];
}

/** ingest 阶段产物：articles 已合并 + tier 补齐，rawArticles 保留 fetchAll 原始快照。 */
export interface IngestResult {
  articles: ArticleInput[];
  rawArticles: ArticleInput[];
  crawled: CrawledBundle;
}

/**
 * 单源抓取：失败非致命（仅打 log，daily.ts main 行为不变）。
 * 封装为模块内函数而非顶层，便于单测。
 */
async function fetchAllSources(ctx: DailyContext): Promise<ArticleInput[]> {
  const articles: ArticleInput[] = [];
  const enabled = ctx.sources.filter((s) => s.enabled !== false);
  for (const source of enabled) {
    try {
      const items = await fetchSource(source);
      console.log(`  ${source.id.padEnd(20)} ${items.length}`);
      // 采集层声明源等级 tier（T6）：源定义 → 文章；
      // 无发布时间 → 回退采集时间（本次抓取时刻）
      articles.push(
        ...items.map((it) => ({
          ...it,
          source: source.name,
          tier: source.tier,
          ...(it.publishedAt ? {} : { fetchedAt: new Date() }),
        })),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ${source.id.padEnd(20)} FAILED — ${msg}`);
    }
  }
  return articles;
}

/**
 * 抓取爬虫产物：失败非致命（降级为 0 条）。
 */
async function fetchCrawlers(): Promise<CrawledBundle> {
  try {
    const r = await fetchCrawledArticles();
    console.log(
      `[daily] ✅ 爬虫抓取: IPO/新股 ${r.ipo.length} 条 / 广州商机 ${r.gz.length} 条 / 昨日股市 ${r.stocks.length} 条`,
    );
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[daily] ⚠️ 爬虫抓取失败（跳过爬虫源）: ${msg}`);
    return { ipo: [], gz: [], stocks: [] };
  }
}

/**
 * 把爬虫的某类产物合并到 articles。
 * - ipo 模式：gd-→gz- region 分流（toMergeArticle 内部）
 * - gz 模式：按 SOURCE_ROUTE 路由集中表定 category（M3-D）
 */
function mergeCrawledBatch(
  articles: ArticleInput[],
  batch: CrawledArticle[],
  mode: "ipo" | "gz",
  gzCategory?: (id?: string) => Category | undefined,
  label?: string,
): ArticleInput[] {
  if (!batch.length) return articles;
  const mapped = batch.map((it) =>
    mode === "ipo"
      ? toMergeArticle(it, "ipo")
      : toMergeArticle(it, "gz", { gzCategory: gzCategory?.(it.sourceId) }),
  );
  const { merged, added, skipped } = dedupeByUrl(articles, mapped);
  if (label) {
    console.log(`[daily] ✅ 加载${label} ${added} 条（跳过 ${skipped} 条重复）`);
  }
  return merged;
}

/**
 * 本地手动采集合并：data/local-acquired.json 7 天窗口内条目按 region/sourceId 分流。
 * 文案特殊：除 added/skipped 外还打印「共 N 条 7 天内」，与原 main 一致。
 */
function mergeLocalAcquired(articles: ArticleInput[]): ArticleInput[] {
  const localAcq = loadLocalAcquired();
  if (!localAcq || !localAcq.items.length) {
    console.log(`[daily] ℹ️ 无本地手动采集文件（data/local-acquired.json 缺失或为空）`);
    return articles;
  }
  const recent = filterLocalAcquiredRecent(localAcq.items);
  const isIpoItem = (it: CrawledArticle) =>
    it.region === "gd" ||
    ["sse", "szse", "bse", "hkex", "em-ipo"].includes(it.sourceId ?? "");
  const localIpo = recent.filter(isIpoItem);
  const localGz = recent.filter((it) => !isIpoItem(it));
  const regCat = (id?: string) => (id ? SOURCE_ROUTE[id]?.category : undefined);

  let out = articles;
  if (localIpo.length) {
    const { merged, added, skipped } = dedupeByUrl(
      out,
      localIpo.map((it) => toMergeArticle(it, "ipo")),
    );
    out = merged;
    console.log(
      `[daily] ✅ 本地手动采集(IPO) ${added} 条（跳过 ${skipped} 条重复，共 ${recent.length} 条 7 天内）`,
    );
  }
  if (localGz.length) {
    const { merged, added, skipped } = dedupeByUrl(
      out,
      localGz.map((it) => toMergeArticle(it, "gz", { gzCategory: regCat(it.sourceId) })),
    );
    out = merged;
    console.log(
      `[daily] ✅ 本地手动采集(商机财经) ${added} 条（跳过 ${skipped} 条重复，共 ${recent.length} 条 7 天内）`,
    );
  }
  return out;
}

/**
 * tier 补齐：爬虫产物未带 tier 的条目按源定义透传（归一化层只透传、不渲染）。
 * PR1 之前在 main 中构建 tierBySource；现在用 ctx.tierBySource。
 */
function backfillTier(articles: ArticleInput[], ctx: DailyContext): ArticleInput[] {
  const tierBySource = ctx.tierBySource;
  return articles.map((a) =>
    a.tier === undefined && tierBySource.has(a.sourceId)
      ? { ...a, tier: tierBySource.get(a.sourceId) }
      : a,
  );
}

/**
 * 采集 + 归一化入口（PR2 引入）。
 *
 * 顺序：fetchAll → 抓爬虫 → 合并三类爬虫 → 合并本地采集 → tier 补齐
 * 与原 main 中 136-228 行顺序一致，确保行为不变。
 */
export async function ingestAll(ctx: DailyContext): Promise<IngestResult> {
  // ① fetchAll
  let articles = await fetchAllSources(ctx);
  // 保留 fetchAll 原始快照（未被后续 2 天窗口过滤），供「股市解读」美股输入使用：
  // 美股复盘要取「抓取日当日凌晨」的美股收盘（恰为上一美股交易日，北京时间周末/周一距抓取日 3 个日历日），
  // 若用已被 FETCH/DISPLAY_WINDOW_DAYS=2 过滤后的 articles，周一跑会误删正确的周五美股复盘。
  const rawArticles = articles;
  console.log(`\n[daily] total articles: ${articles.length}`);

  // ② 爬虫
  const crawled = await fetchCrawlers();

  // ③ 合并爬虫三类（IPO / 广州商机 / 昨日股市）
  const regCat = (id?: string) => (id ? SOURCE_ROUTE[id]?.category : undefined);
  articles = mergeCrawledBatch(articles, crawled.ipo, "ipo", undefined, "爬虫数据");
  articles = mergeCrawledBatch(articles, crawled.gz, "gz", regCat, "广州商机数据");
  articles = mergeCrawledBatch(
    articles,
    crawled.stocks,
    "gz",
    () => "stocks", // 强制 category=stocks
    "昨日股市数据",
  );

  // ④ 本地手动采集
  articles = mergeLocalAcquired(articles);

  // ⑤ tier 补齐
  articles = backfillTier(articles, ctx);

  if (articles.length === 0) {
    throw new Error("no articles fetched — aborting");
  }

  return { articles, rawArticles, crawled };
}
