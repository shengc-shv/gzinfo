import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, loadAllSources, REPORT_LOCALE } from "../lib/sources/registry";
import { SOURCE_ROUTE } from "../lib/sources/constants";
import { fetchSource } from "../lib/sources/dispatch";
import {
  toMergeArticle,
  dedupeByUrl,
  filterByWindow,
  type CrawledArticle,
} from "../lib/ingest/merge";
import { fetchCrawledArticles } from "../lib/sources/crawlers";
import {
  loadLocalAcquired,
  filterLocalAcquiredRecent,
} from "../lib/sources/local-acquired";
import { applyKeywordFilter } from "../lib/filters/keyword-filter";
import {
  keywordFilterEnabled,
  keywordFilterFallbackEnabled,
  loadKeywordConfig,
  dedupSimilarEnabled,
  loadDedupConfig,
} from "../lib/filters/config";
import {
  dedupeByTitleSimilarity,
  dedupeAgainstHistory,
  type HistorySimilarEntry,
} from "../lib/ingest/dedup-similar";
import type { FilterResult, RawArticleInput } from "../lib/filters/types";
import {
  type ArticleInput,
  type DailyReport,
  type ReportItem,
} from "../lib/types";
import { validateBackendCredentials } from "../lib/ai/llm";
import { generateDaily, makeSkipAiRunner } from "../lib/ai/pipeline";
import type { Pass1Input } from "../lib/ai/pass1";
import { LIGHT_AI_SOURCES, LIGHT_AI_MAX_PER_SOURCE, LIGHT_AI_RAW_CAP, capLightAiSources } from "../lib/ai/light-ai";
import {
  enrichFinanceNewsSummaries,
  enrichGithubTrendingSummaries,
} from "../lib/ai/enrich";
import {
  isSportsArticle,
  MERGED_SUBGROUP_LIMITS,
  MERGE_PER_SOURCE_CAP,
  SOURCE_DISPLAY_LIMITS,
  renderHtml,
  renderMarkdown,
  mergeRollingIntoReport,
  mergeStoredExecutive,
} from "../lib/output/render";
import { loadStore, generateExecutiveSummary, writeStore } from "../lib/ai/executive-summary";
import { buildTwoDayExecPool } from "../lib/ai/exec-pool";
import { DISPLAY_WINDOW_DAYS, GZ_ANCHOR_RE } from "../lib/output/render/cards";
import {
  loadHistory,
  buildRolling,
  saveHistory,
  FETCH_WINDOW_DAYS,
  type HistoryStore,
} from "../lib/output/history";
import { analyzeWatchlist } from "../lib/trading/runner";
import type { TradingSection } from "../lib/types";
import { todayKey } from "../lib/utils";
import {
  loadAiAssets,
  saveAiAssets,
  dailyAssetKey,
  assetSummary,
  assetDaily,
  type AiAssetStore,
  type ArticleAiAsset,
} from "../lib/ai/assets";
import { REPORTS_DIR } from "../lib/output/paths";

// SKIP_AI 开关已收敛到 lib/ai/mode.ts（唯一 env 读取点，行为不变；stage 维度供 M2-③ 埋点复用）。
import { aiEnabled } from "../lib/ai/mode";
const SKIP_AI = !aiEnabled();

/**
 * Rolling 30-day article history + AI-summary cache. Loaded once in main(),
 * read by every `enrich*` helper (to skip LLM calls for already-analyzed
 * URLs), and rewritten at the end of the run.
 */
let history: HistoryStore = {};
/** M2-④：AI 付费产物账本（data/ai-assets/store.json）。读取优先、写回 append-only。 */
let aiAssets: AiAssetStore = {};

/**
 * Reuse previously-generated AI summaries from the history so we don't pay
 * to re-analyze the same URL. Returns the subset that still needs analysis.
 */
function applyCache(items: ArticleInput[]): ArticleInput[] {
  const pending: ArticleInput[] = [];
  for (const a of items) {
    // M2-④：AI 资产账本优先（付费资产永不丢），history 缓存兜底
    const cached = assetSummary(aiAssets, a.url) ?? history[a.url]?.summary;
    if (cached) {
      a.summary = cached;
    } else {
      pending.push(a);
    }
  }
  return pending;
}

async function fetchAll(): Promise<ArticleInput[]> {
  const articles: ArticleInput[] = [];
  const enabled = sources.filter((s) => s.enabled !== false);
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

async function enrichGhTrending(articles: ArticleInput[]): Promise<void> {
  // Only the final displayed slice — matches SOURCE_DISPLAY_LIMITS["tech:github-trending"].
  const gh = articles
    .filter((a) => a.sourceId === "github-trending")
    .slice(0, SOURCE_DISPLAY_LIMITS["tech:github-trending"] ?? 20);
  if (gh.length === 0) return;
  const pending = applyCache(gh);
  if (pending.length === 0) {
    console.log(`[daily] enriching GitHub Trending: ${gh.length} 条全部命中历史缓存，跳过 LLM`);
    return;
  }
  if (SKIP_AI) {
    console.log(`[daily] SKIP_AI: 跳过 GitHub Trending LLM 富集（${pending.length} 条仅用历史缓存摘要）`);
    return;
  }
  console.log(
    `[daily] enriching ${pending.length}/${gh.length} GitHub Trending repos with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichGithubTrendingSummaries(pending);
  for (const a of pending) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${pending.length}`,
  );
}

/**
 * finance:news is rendered as a merged time-sorted list (see
 * MERGED_SUBGROUP_LIMITS in render.ts). Enrich exactly the items that
 * will be displayed: take all enabled finance:news articles, sort by
 * publishedAt desc, slice to the merge limit, ask Sonnet for Chinese
 * factual summaries.
 */
async function enrichFinanceNews(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "finance", "news");
}

async function enrichPolitics(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "politics", "world");
}

async function enrichOverseasTech(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "tech", "overseas-tech");
}

/**
 * Shared implementation for "merged subgroup" enrichment: collect all
 * enabled articles in (category, subcategory), sort by date desc, take
 * the display cap (from MERGED_SUBGROUP_LIMITS), and ask the LLM to
 * summarize them into REPORT_LOCALE in a single batch. Symmetric to the
 * merge logic in render.ts groupRaw, so display and enrichment stay aligned.
 *
 * Sources whose `lang` already matches REPORT_LOCALE are skipped — no
 * point translating English to English (en mode) or Chinese to Chinese
 * (zh mode).
 */
async function enrichMergedSubgroup(
  articles: ArticleInput[],
  category: "tech" | "finance" | "politics",
  subcategory: string,
): Promise<void> {
  const subSources = sources.filter(
    (s) =>
      s.category === category &&
      s.subcategory === subcategory &&
      s.enabled !== false,
  );
  const sameLocaleIds = new Set(
    subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:${subcategory}`] ?? 12;
  const perCap = MERGE_PER_SOURCE_CAP[`${category}:${subcategory}`];
  // Mirror render.ts groupRaw EXACTLY: cap each source to perCap (so one
  // fresh source can't flood the whole merged timeline), concat, then take
  // the top-N by date. This keeps AI enrichment scoped to the FINAL displayed
  // items only — no LLM spend on items the reader will never see.
  const perSourceItems: ArticleInput[] = [];
  for (const s of subSources) {
    const srcItems = articles
      .filter((a) => a.sourceId === s.id)
      .filter((a) => category !== "politics" || !isSportsArticle(a.title))
      .sort(
        (a, b) =>
          (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
      );
    perSourceItems.push(...(perCap ? srcItems.slice(0, perCap) : srcItems));
  }
  const top = perSourceItems
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    .slice(0, limit);
  const toEnrich = top.filter((a) => !sameLocaleIds.has(a.sourceId));
  const pending = applyCache(toEnrich);
  if (pending.length === 0) {
    console.log(
      `[daily] enriching ${category}:${subcategory}: ${toEnrich.length} 条全部命中历史缓存，跳过 LLM`,
    );
    return;
  }
  if (SKIP_AI) {
    console.log(`[daily] SKIP_AI: 跳过 ${category}:${subcategory} LLM 富集（${pending.length} 条仅用历史缓存摘要）`);
    return;
  }
  console.log(
    `[daily] enriching ${pending.length}/${toEnrich.length} ${category}:${subcategory} items with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(pending);
  for (const a of pending) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${pending.length}`,
  );
}

/**
 * 市场行情（2026-08-21 用户：去加密、去 LLM 点评，保留宏观资产技术指标）。
 * 从 Yahoo 拉取宏观资产 OHLCV，计算指标 + 信号；不再抓取加密恐慌贪婪/总市值，
 * 不再调用 LLM 生成点评（速览职能由「今日必读」承担）。返回 null 表示无 ticker。
 */
async function runTrading(): Promise<TradingSection | null> {
  console.log(`[daily] analyzing watchlist (Yahoo indicators)…`);
  const t0 = Date.now();
  const tickers = await analyzeWatchlist();
  console.log(
    `[daily] indicators ready in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${tickers.length} tickers`,
  );
  if (tickers.length === 0) return null;
  return {
    tickers,
    generated_at: new Date().toISOString(),
  };
}

/** 归一化 ArticleInput → Pass1Input（新管线输入）：raw_text 截断 1200 字、date 转 MM/DD。 */
function toPass1Input(a: ArticleInput): Pass1Input {
  const d = a.publishedAt ?? a.fetchedAt;
  const date = d
    ? `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`
    : "";
  const isLight = LIGHT_AI_SOURCES.has(a.sourceId ?? "");
  const raw = (a.excerpt || a.summary || "").slice(0, isLight ? LIGHT_AI_RAW_CAP : 1200);
  return {
    url: a.url,
    title: a.title,
    source: a.source,
    date,
    raw_text: raw,
    category: a.category,
    // gz_hint 提权（2026-08-21 第二梯队）：标题命中广州锚词 → 标记，降低被
    // 保留标准第2~4条门槛刷掉的概率，Pass 1 倾向判 locale=gz / section=gz_local。
    gz_hint: GZ_ANCHOR_RE.test(a.title) || undefined,
  };
}

async function main() {
  // Fail fast on misconfigured backend before we spend 30s fetching
  // 500+ articles only to discover the LLM has no credentials.
  // SKIP_AI 模式不调用 LLM，无需凭证，跳过该校验。
  if (!SKIP_AI) validateBackendCredentials();

  // 加载滚动 30 天历史（含已解读的 AI 摘要缓存），供富集去重 + 过去30天 tab 使用。
  history = loadHistory();
  console.log(`[daily] 已加载历史缓存: ${Object.keys(history).length} 条（来自 data/article-history.json）`);
  aiAssets = loadAiAssets();
  console.log(`[daily] 已加载 AI 资产账本: ${Object.keys(aiAssets).length} 键（data/ai-assets/，${process.env.PERSIST_AI === "off" ? "PERSIST_AI=off 旁路" : "启用"}`);

  const date = todayKey();
  console.log(`[daily] ${date} — fetching sources…\n`);
  let articles = await fetchAll();
  console.log(`\n[daily] total articles: ${articles.length}`);

  // —— 归一化（边界②）：采集产物汇合 + URL 去重 + region 分流（gd-→gz- 前缀改写）——
  // M3-A：爬虫已 TS 化并由本进程内 fetchCrawledArticles() 直接调用（不再 shell 出去写
  // crawled-articles.json / crawled-gz.json 中间文件）；逻辑集中在 lib/ingest/merge.ts（纯函数、可单测）。
  let crawled: { ipo: CrawledArticle[]; gz: CrawledArticle[] } = { ipo: [], gz: [] };
  try {
    crawled = await fetchCrawledArticles();
    console.log(
      `[daily] ✅ 爬虫抓取: IPO/新股 ${crawled.ipo.length} 条 / 广州商机 ${crawled.gz.length} 条`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[daily] ⚠️ 爬虫抓取失败（跳过爬虫源）: ${msg}`);
  }

  // IPO / 新股（crawled-articles.json 等价路径，mode=ipo）
  if (crawled.ipo.length) {
    const { merged, added, skipped } = dedupeByUrl(
      articles,
      crawled.ipo.map((it) => toMergeArticle(it, "ipo")),
    );
    articles = merged;
    console.log(`[daily] ✅ 加载爬虫数据 ${added} 条（跳过 ${skipped} 条重复）`);
  }

  // 广州商机（crawled-gz.json 等价路径，mode=gz）。category 按集中路由表判定
  // （M3-D：SOURCE_ROUTE，不依赖 config 里的 file:// 占位源）。
  // 注意：走「今日抓取」数组 → buildRolling 自动打 fetchedToday=true（当天）；
  // 次日经 saveHistory 进入历史缓存后 fetchedToday 自动为 false（过去7天）。当天/历史严格区分。
  if (crawled.gz.length) {
    const regCat = (id?: string) => (id ? SOURCE_ROUTE[id]?.category : undefined);
    const { merged, added, skipped } = dedupeByUrl(
      articles,
      crawled.gz.map((it) => toMergeArticle(it, "gz", { gzCategory: regCat(it.sourceId) })),
    );
    articles = merged;
    console.log(`[daily] ✅ 加载广州商机数据 ${added} 条（跳过 ${skipped} 条重复）`);
  }

  // —— 本地手动采集（data/local-acquired.json，2026-08-20 方案）——
  // 被 WAF 拦的国内源（NFRA/PBC/财联社/同花顺）由用户本地 skill（local-acquire）抓取后
  // 提交到该文件；此处只取「最新 7 天」条目，按 region/sourceId 分 ipo/gz 两类，
  // 与爬虫产物同构（toMergeArticle + dedupeByUrl）并入同一管线（后续漏斗/AI/分类/渲染一致）。
  const localAcq = loadLocalAcquired();
  if (localAcq && localAcq.items.length) {
    const recent = filterLocalAcquiredRecent(localAcq.items);
    const isIpoItem = (it: CrawledArticle) =>
      it.region === "gd" || (it.sourceId ?? "").startsWith("gd-");
    const localIpo = recent.filter(isIpoItem);
    const localGz = recent.filter((it) => !isIpoItem(it));
    if (localIpo.length) {
      const { merged, added, skipped } = dedupeByUrl(
        articles,
        localIpo.map((it) => toMergeArticle(it, "ipo")),
      );
      articles = merged;
      console.log(`[daily] ✅ 本地手动采集(IPO) ${added} 条（跳过 ${skipped} 条重复，共 ${recent.length} 条 7 天内）`);
    }
    if (localGz.length) {
      const regCat = (id?: string) => (id ? SOURCE_ROUTE[id]?.category : undefined);
      const { merged, added, skipped } = dedupeByUrl(
        articles,
        localGz.map((it) => toMergeArticle(it, "gz", { gzCategory: regCat(it.sourceId) })),
      );
      articles = merged;
      console.log(`[daily] ✅ 本地手动采集(商机财经) ${added} 条（跳过 ${skipped} 条重复，共 ${recent.length} 条 7 天内）`);
    }
  } else {
    console.log(`[daily] ℹ️ 无本地手动采集文件（data/local-acquired.json 缺失或为空）`);
  }

  // —— 源等级 tier 补齐（T6）：爬虫产物未带 tier 的条目，按源定义透传（归一化层只透传、不渲染）——
  const tierBySource = new Map(loadAllSources().map((s) => [s.id, s.tier]));
  articles = articles.map((a) =>
    a.tier === undefined && tierBySource.has(a.sourceId)
      ? { ...a, tier: tierBySource.get(a.sourceId) }
      : a,
  );
  if (articles.length === 0) {
    throw new Error("no articles fetched — aborting");
  }

  // —— 源层前置窗口过滤（2026-08-20 用户决策：减少滚动列表白抓；2026-08-22 改为抓 2 天）——
  // RSS/爬虫抓的是滚动列表，天然混入大量超窗口旧文。在进入关键词漏斗/标题去重前，
  // 先按「抓取窗口（今天+昨天，共 ${FETCH_WINDOW_DAYS} 天）」丢弃，减少无效处理量；
  // 展示窗口（${DISPLAY_WINDOW_DAYS} 天）仍由后段 filterByWindow(DISPLAY_WINDOW_DAYS) 保证，但数据已被前置截断到 ${FETCH_WINDOW_DAYS} 天。
  const preW = articles.length;
  articles = filterByWindow(articles, FETCH_WINDOW_DAYS);
  if (articles.length !== preW) {
    console.log(
      `[daily] 🧹 源层前置窗口过滤: ${preW} → ${articles.length} 条（移除 ${preW - articles.length} 条超 ${FETCH_WINDOW_DAYS} 天旧文）`,
    );
  }

  // —— 关键词漏斗（边界③最前端，零成本）：银行零售关键词体系硬过滤 ——
  // 未命中直接丢弃（决策②：硬过滤），不进入任何 AI 富集/分类；KEYWORD_FILTER=off 旁路。
  if (keywordFilterEnabled()) {
    const kwConfig = loadKeywordConfig();
    const before = articles.length;
    const keep: ArticleInput[] = [];
    let opp = 0;
    let weekly = 0;
    for (const a of articles) {
      const input: RawArticleInput = {
        title: a.title,
        content: a.excerpt,
        sourceId: a.sourceId,
        url: a.url,
        category: a.category, // 参考区（tech/ipo/gd-ipo/politics）豁免漏斗，仅商机扫描
      };
      const r = applyKeywordFilter(input, kwConfig);
      if (!r.pass) continue;
      const tagged = a as ArticleInput & {
        filterBucket?: string;
        filterDimensions?: string[];
        filterOpportunities?: FilterResult["opportunities"];
      };
      tagged.filterBucket = r.bucket;
      tagged.filterDimensions = r.dimensions;
      if (r.opportunities?.length) tagged.filterOpportunities = r.opportunities;
      if (r.bucket === "opportunity") opp++;
      if (r.bucket === "weekly") weekly++;
      keep.push(a);
    }
    if (keep.length === 0 && keywordFilterFallbackEnabled()) {
      console.warn(`[daily] ⚠️ 关键词漏斗将全部 ${before} 条过滤为 0（疑似误杀/词表过严）— 回退全量保底，避免空报告`);
    } else {
      articles = keep;
      console.log(`[daily] 🔻 关键词漏斗: ${before} → ${articles.length} 条（商机 ${opp} / 周报 ${weekly}，其余日报池）`);
    }
  }

  // —— 标题相似度判重（归一化②，漏斗之后 AI 之前）：同一主题最多 maxPerTheme 条、
  // 同 tier 只留 1 条（政府+媒体 = 政府 1 + 媒体 1）。让 LLM 只处理保留条目（省钱）。
  if (dedupSimilarEnabled()) {
    const dd = loadDedupConfig();
    const before = articles.length;
    const { kept, removed } = dedupeByTitleSimilarity(articles, {
      threshold: dd.threshold,
      maxPerTheme: dd.maxPerTheme,
    });
    if (removed.length > 0) {
      console.log(
        `[daily] 🔁 标题相似度判重: ${before} → ${kept.length} 条（阈值 ${dd.threshold}、每主题 ≤${dd.maxPerTheme}、同 tier 只留 1；移除 ${removed.length} 条重复报道）`,
      );
    }
    articles = kept;
  }

  // —— 超窗口旧文过滤（归一化②）：rss 流混入的超展示窗口旧文不进 AI、不展示（展示窗口 ${DISPLAY_WINDOW_DAYS} 天）——
  // 否则旧文 URL 不在历史缓存，会被误判为「新条目」进 AI 分类（白花钱）。
  const wBefore = articles.length;
  articles = filterByWindow(articles, DISPLAY_WINDOW_DAYS);
  if (articles.length !== wBefore) {
    console.log(
      `[daily] 🗓 超窗口旧文过滤: ${wBefore} → ${articles.length} 条（移除 ${wBefore - articles.length} 条超 ${DISPLAY_WINDOW_DAYS} 天窗口旧文）`,
    );
  }

  // —— 跨天标题判重（先来后到）：新抓取 vs 历史库已有条目 ——
  // 同主题（标题相似 ≥0.7）重复报道：同 tier 只留 1、不同 tier 最多 2 条、
  // 历史先来者优先占位。例：政府今天发公积金，明天某媒体再发、后天又一家——
  // 仅当该 tier 空缺且总数 < 2 时才补充，否则视为无效重复丢弃。
  const histSim: HistorySimilarEntry[] = Object.values(history).map((e) => ({
    title: e.title,
    url: e.url,
    tier: tierBySource.get(e.sourceId),
  }));
  const dhBefore = articles.length;
  const dh = dedupeAgainstHistory(articles, histSim, { maxPerTheme: 2 }) // 跨天阈值默认 0.6（Dice）;
  if (dh.removed.length > 0) {
    console.log(
      `[daily] 🔄 跨天标题判重: ${dhBefore} → ${dh.kept.length} 条（历史库已覆盖 ${dh.removed.length} 条重复主题）`,
    );
  }
  articles = dh.kept;

  // —— 兜底：无准确发布时间/发布日期的条目不参与任何 AI 分析（2026-08-21 用户要求）——
  // 任务一已让所有源补上 publishedAt（RSS pubDate / URL 日期提取 / 详情页解析），
  // 此过滤为防御性兜底：未来任何源若产出无日期条目，直接在此丢弃，
  // 不进 AI 富集/分类/执行摘要，也不落历史库（saveHistory 只存过滤后的数组）。
  const noDateBefore = articles.length;
  articles = articles.filter((a) => a.publishedAt);
  if (articles.length < noDateBefore) {
    console.log(
      `[daily] ⏭ 无发布时间/日期条目 ${noDateBefore - articles.length} 条跳过 AI 分析（兜底丢弃）`,
    );
  }

  // —— 降本（2026-08-22）：lightAi 源（命中率低但保留热点发现）每源每天最多取 N 条，
  // 减少进 PASS1 的总量；其 raw_text 在 toPass1Input 已截断到 LIGHT_AI_RAW_CAP 字。 ——
  const beforeLight = articles.length;
  articles = capLightAiSources(articles, LIGHT_AI_SOURCES, LIGHT_AI_MAX_PER_SOURCE);
  if (articles.length < beforeLight) {
    console.log(
      `[daily] 🔻 lightAi 限流: 移除 ${beforeLight - articles.length} 条（cnfin/stcn/dayoo-gz/southcn/cnr-gd 每源≤${LIGHT_AI_MAX_PER_SOURCE}）`,
    );
  }

  // Enrich tech / politics subgroups with summaries (tech/politics 不参与银行相关分类，
  // 走各自专属摘要 prompt)。finance 不再单独 enrich——其摘要+分类统一由下方
  // classifyItemsWithLlm 一次批量调用完成（中文/英文源全覆盖，省一次重复调用）。
  // ===== 新管线：两阶段 AI 生成 + 13 条确定性校验（取代旧 enrich/classify/executive）=====
  const inputs: Pass1Input[] = articles.map(toPass1Input);
  console.log(`[daily] 进入两阶段 AI 管线：${inputs.length} 条（PASS1 筛选 + PASS2 成稿 + 校验回炉/降级）`);

  // —— 预分析缓存：article-history.json / ai-assets 中已回填的摘要，供 SKIP_AI 重跑直接展示 ——
  // 使「预加载分析报告」后本地 SKIP_AI 预览能显示预填解读，无需再调 LLM。
  const summaryCache = new Map<string, string>();
  for (const url of new Set([...Object.keys(history), ...Object.keys(aiAssets)])) {
    const s = assetSummary(aiAssets, url) ?? history[url]?.summary;
    if (s && s.trim()) summaryCache.set(url, s);
  }
  // 相关性白名单（2026-08-22）：历史库 ai_relevant===true 的 url 集合。SKIP_AI 的
  // PASS1 只保留白名单内条目（宁缺毋滥），防止今天新抓的非 L0 垃圾（绿色算力/
  // 银行中报/科技公司业绩）在预览/发布时混入板块——此前 SKIP_AI 是「全部 keep」，
  // ai_relevant 只挡滚动合并，不挡当日板块，是「数据清了还显示」的真根因。
  const relevantUrls = new Set(
    Object.entries(history)
      .filter(([, e]) => e?.ai_relevant === true)
      .map(([url]) => url),
  );
  const runner = SKIP_AI ? makeSkipAiRunner(summaryCache, relevantUrls) : undefined;
  let report: DailyReport;
  try {
    report = await generateDaily(inputs, date, { runner });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[daily] 管线生成失败：${msg}`);
  }
  const totalKept = (Object.values(report.sections) as ReportItem[][]).reduce((n, s) => n + s.length, 0);
  console.log(
    `[daily] 管线产出：必读 ${report.must_read.length} 条 / 商机 ${report.insights.length} 条 / 正文 ${totalKept} 条`,
  );
  
  // 回写历史缓存（含今日 AI 摘要），并构建「当天 + 过去30天」滚动列表用于渲染。
  const nowIso = new Date().toISOString();
  history = saveHistory(articles, history, nowIso);
  const rolling = buildRolling(articles, history);
  console.log(
    `[daily] 历史缓存已更新: ${Object.keys(history).length} 条（含今日 ${articles.length} 条）；渲染滚动列表 ${rolling.length} 条`,
  );

  // —— 近7天历史并入（2026-08-21 用户：过去符合要求的都展示 + 区分零售各部门）——
  // renderHtml 只消费 report.sections（今日 AI 成稿）；此处把 rolling 中近7天符合要求的
  // 条目（AI 判相关、有摘要/可摘录）并入对应板块，有摘要用摘要、无则摘录，卡片带部门 tag。
  const mergedReport = mergeRollingIntoReport(report, rolling, tierBySource);
  const mergedCount = (Object.values(mergedReport.sections) as ReportItem[][]).reduce(
    (n, s) => n + s.length,
    0,
  );
  if (mergedCount !== totalKept) {
    console.log(
      `[daily] 🕘 近7天历史并入: ${totalKept} → ${mergedCount} 条（追加 ${mergedCount - totalKept} 条历史符合要求条目）`,
    );
  }

  // —— 必读/商机：「今天 + 昨天」2 天窗口（2026-08-23 用户需求）——
  // 非 SKIP_AI：
  //  - 当天已有 store.json（早上 AI 跑已生成 / 手工回填）→ 直接复用，跳过重复 LLM 调用；
  //  - 缺失才用 buildTwoDayExecPool（今日 PASS2 sections + history 昨日 ai_relevant 有摘要）
  //    拼出 2 天窗口 finance/gz 池 → generateExecutiveSummary 生成必读/商机/hero_line
  //    （hero_line 与必读/商机均来自 2 天窗口，不再只基于本次进入管线的 kept），
  //    覆盖 PASS2 产出并 writeStore 持久化，供 SKIP_AI 重跑 / 发布复用。
  if (!SKIP_AI) {
    const stored = loadStore(date);
    if (stored && (stored.hero_line || stored.must_read?.length || stored.insights?.length)) {
      // 复用：hero_line 独立覆盖（store 为 2 天窗口版本，优先），must_read/insights 走适配回匹配
      if (stored.hero_line) mergedReport.hero_line = stored.hero_line;
      mergeStoredExecutive(mergedReport, stored);
      console.log(
        `[daily] 🧠 复用 store.json 执行摘要（跳过 LLM 生成）：${stored.must_read?.length ?? 0} 必读 / ${stored.insights?.length ?? 0} 商机`,
      );
    } else {
      try {
        const pool = buildTwoDayExecPool({ history, articles, report: mergedReport, today: date });
        const exec = await generateExecutiveSummary({ date, finance: pool.finance, gz: pool.gz });
        if (exec) {
          if (exec.hero_line) mergedReport.hero_line = exec.hero_line;
          const mustRead = exec.must_read
            .filter((m) => !!m.url)
            .map((m) => ({ title: m.title, why: m.why, url: m.url as string }));
          if (mustRead.length) mergedReport.must_read = mustRead;
          if (exec.insights.length) {
            mergedReport.insights = exec.insights.map((it) => ({
              topic: it.topic,
              tags: it.tag ?? [],
              impact: it.impact,
              action: it.action,
              ...(it.sources && it.sources.length ? { sources: it.sources } : {}),
            }));
          }
          writeStore(date, exec);
          console.log(
            `[daily] 🧠 必读/商机(今昨2天窗口)生成：${exec.must_read.length} 必读 / ${exec.insights.length} 商机（输入 finance ${pool.finance.length} + gz ${pool.gz.length}）`,
          );
        } else {
          console.log(`[daily] ℹ️ 2天窗口执行摘要为空（沿用 PASS2 产出）`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[daily] ⚠️ 2天窗口执行摘要生成失败（沿用 PASS2）: ${msg}`);
      }
    }
  }

  // —— SKIP_AI 执行摘要回填（2026-08-21 修复：store.json 复用断链）——
  // SKIP_AI 下 PASS2 不产出 must_read/insights（无 LLM）；history/<date>/store.json
  // 保存了当天真实 AI 的执行摘要（CI 正式跑生成、随报告提交进 main）。此处放在
  // mergeRolling 之后执行：sections 已含近7天历史条目，store 的 must_read 标题
  // （如「8月LPR不变」）能回匹配到更大标题池（316 条 vs 仅今日 31 条），匹配率更高。
  if (SKIP_AI) {
    try {
      const stored = loadStore(date);
      if (stored && (stored.must_read?.length || stored.insights?.length)) {
        const before = { must: mergedReport.must_read.length, ins: mergedReport.insights.length };
        mergeStoredExecutive(mergedReport, stored);
        console.log(
          `[daily] 🧠 SKIP_AI 复用 store.json 执行摘要：必读 ${before.must}→${mergedReport.must_read.length} / 商机 ${before.ins}→${mergedReport.insights.length}`,
        );
      } else {
        console.log(`[daily] ℹ️ SKIP_AI 无 store.json 执行摘要可复用（history/${date}/store.json 缺失或为空）`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[daily] ⚠️ SKIP_AI 执行摘要回填失败（继续）: ${msg}`);
    }
  }

  // —— M2-④：AI 资产账本写回（daily 级：仅 trading；正文已随 report.json 落盘）——
  const dk = dailyAssetKey(date);
  const dailyPrev = assetDaily(aiAssets, date);
  aiAssets[dk] = {
    ...(dailyPrev ?? {}),
    updatedAt: nowIso,
  };
  saveAiAssets(aiAssets);
  console.log(`[daily] AI 资产账本已更新: ${Object.keys(aiAssets).length} 键`);

  // —— M2-⑤ 存储合并（去双写，2026-08-19 用户确认未上线）——
  // data/history/reports/ 是唯一报告存储；daily_reports/（gh-pages 发布目录）
  // 由 build-site.mjs 在构建时从唯一存储同步，daily.ts 不再写旧目录。
  const html = renderHtml(mergedReport, date);
  const md = process.env.OUTPUT_MARKDOWN === "true" ? renderMarkdown(mergedReport, date) : null;
  const writeBundle = (dir: string) => {
    const d = path.join(dir, date);
    fs.mkdirSync(d, { recursive: true });
    const b = path.join(d, date);
    fs.writeFileSync(`${b}.json`, JSON.stringify(mergedReport, null, 2), "utf8");
    // Sidecar with the rolling article list (today + past-30d) + LLM-attached
    // summary, so scripts/render.ts can rebuild HTML/MD for UI iteration
    // without re-fetching or re-calling the LLM.
    fs.writeFileSync(
      `${b}-articles.json`,
      JSON.stringify({ date, articles: rolling }, null, 2),
      "utf8",
    );
    fs.writeFileSync(`${b}.html`, html, "utf8");
    if (md) fs.writeFileSync(`${b}.md`, md, "utf8");
    return b;
  };
  const base = writeBundle(REPORTS_DIR);
  console.log(`[daily] wrote ${base}.{json,html${md ? ",md" : ""},articles.json}（唯一存储 data/history/reports/）`);

  // 导出归一化后的全量池（关键词漏斗后），供「预分析」任务或人工核查比对。
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/fetched-articles.json", JSON.stringify(articles, null, 2), "utf8");
  console.log(`[daily] 📤 归一化全量池导出: ${articles.length} 条 → data/fetched-articles.json`);

  console.log(`[daily] done.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[daily] FAILED:`, e);
    process.exit(1);
  });
