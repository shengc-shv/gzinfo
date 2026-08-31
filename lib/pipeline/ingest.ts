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
  if (enabled.length === 0) return articles;

  // 2026-08-28 改造：24 源并发抓取（T7 设计模式：Parallel For / Promise.allSettled）。
  // 原 for 循环串行——最慢源阻塞整次 daily（24 源 × 平均 1-2s = 24-48s 顺序等待）。
  // 并发后总耗时 = max(单源耗时) ≈ 5-8s（节省 60-80%）。
  // 保留每源错误隔离（allSettled 而非 all）；保留源顺序输出（按 ctx.sources 顺序遍历结果）。
  const t0 = Date.now();
  const settled = await Promise.allSettled(
    enabled.map((source) => fetchSource(source)),
  );
  const dur = ((Date.now() - t0) / 1000).toFixed(1);

  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < enabled.length; i++) {
    const source = enabled[i];
    const r = settled[i];
    if (r.status === "fulfilled") {
      const items = r.value;
      succeeded++;
      console.log(`  ${source.id.padEnd(20)} ${items.length}`);
      // 采集层声明源等级 tier（T6）：源定义 → 文章；
      // 2026-08-27 核心规则：源级拿不到 publishedAt 直接丢弃（不写 fetchedAt 兜底 — 抓取时间≠发文时间）。
      // 无 publishedAt 的条目不进入 articles 数组；filter 阶段 no-date-fallback 是 defense in depth。
      const valid = items.filter((it) => it.publishedAt);
      const dropped = items.length - valid.length;
      if (dropped > 0) {
        console.log(`    (无发布时间丢弃 ${dropped} 条 — 2026-08-27 核心规则)`);
      }
      articles.push(
        ...valid.map((it) => ({
          ...it,
          source: source.name,
          tier: source.tier,
          // IPO 内容态（2026-08-31 3漏斗整改 commit②）：RSS/API 源直接进 articles，
          // 不经 toMergeArticle，故此处按归一化 category=gd-ipo/ipo 兜底标注 isIpo，
          // 供过滤层豁免单机构/相似度/跨天去重/窗口（替代原硬编码 category 字符串判断）。
          isIpo: it.category === "gd-ipo" || it.category === "ipo",
          // B：excerpt fallback（2026-08-28 用户反馈：用户给的 URL 抓时 excerpt 空，
          //   history 写入后 mergeRolling 看 summary 为空踢出 → 板块看不到）。
          //   无 excerpt 时用 title 前 90 字符占位（保证 history.excerpt 非空）。
          //   RSS 解析/scrape 列表页可能没 description，纯标题足够给 LLM 标 summary。
          excerpt: it.excerpt?.trim() || it.title?.slice(0, 90) || "",
        })),
      );
    } else {
      failed++;
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`  ${source.id.padEnd(20)} FAILED — ${msg}`);
      // T1：错误聚合：把失败源也 push 到 ctx.errors（后续 main 末尾汇总）
      if (ctx.errors) {
        ctx.errors.push({ stage: "fetchAllSources", source: source.id, message: msg });
      }
    }
  }
  console.log(
    `  [并发] ${succeeded}/${enabled.length} 源成功${failed ? `，${failed} 源失败` : ""}（总耗时 ${dur}s）`,
  );
  return articles;
}

/**
 * 抓取爬虫产物：失败非致命（降级为 0 条）。
 */
async function fetchCrawlers(ctx: DailyContext): Promise<CrawledBundle> {
  try {
    const r = await fetchCrawledArticles();
    console.log(
      `[daily] ✅ 爬虫抓取: IPO/新股 ${r.ipo.length} 条 / 广州商机 ${r.gz.length} 条 / 昨日股市 ${r.stocks.length} 条`,
    );
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[daily] ⚠️ 爬虫抓取失败（跳过爬虫源）: ${msg}`);
    // T1：推 ctx.errors
    ctx.errors.push({ stage: "fetchCrawlers", message: msg, ts: new Date().toISOString() });
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
 * 采集 + 归一化入口（PR2 引入；2026-08-27 移除本地手动采集）。
 *
 * 顺序：fetchAll → 抓爬虫 → 合并三类爬虫 → tier 补齐
 * 移除原因：data/local-acquired.json（NFRA/PBC/财联社/同花顺 WAF 4 源本地直连）
 * 资源质量差、成本高（需本地 runner/WorkBuddy skill），改由远端可达源覆盖。
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
  const crawled = await fetchCrawlers(ctx);

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

  // ④ tier 补齐
  articles = backfillTier(articles, ctx);

  if (articles.length === 0) {
    throw new Error("no articles fetched — aborting");
  }

  return { articles, rawArticles, crawled };
}
