/**
 * 归一化层（边界②）：把采集产物（TS 源 + .mjs 爬虫）汇合成统一结构。
 *
 * 边界纪律：本模块是**唯一**允许做以下事情的地方——
 *  1. 按 URL 去重（dedupeByUrl）
 *  2. region 分流 + `gd-`→`gz-` 前缀改写（routeRegion）
 *  3. 源等级 tier 透传（toMergeArticle）
 * 其他层一律只读归一化结果。全部为纯函数、无 IO，便于单测。
 */
import type { SourceTier } from "../sources/tiers";
import type { Category } from "../sources/types";
import {
  DEFAULT_GZ_SOURCE_ID,
  DEFAULT_SCRAPER_SOURCE_ID,
  REGION_GZ,
  REGION_GD_IPO,
  REGION_IPO,
  rewriteGzPrefix,
} from "../sources/constants";
import { extractDateFromUrl, isWithinCalendarDays } from "../utils";

/**
 * 国内/香港源（+08:00）的裸时间字符串按北京时间解释（2026-08-31 修复时区偏移 bug）。
 *
 * 背景：stcn/southcn 等爬虫从详情页抓出的发布时间是「2026-08-29 20:37」这类**无时区后缀**
 * 的裸时间（北京时间）。归一化时 `new Date("2026-08-29 20:37")` 在 CI（UTC）下被当成 UTC
 * → 存成 `2026-08-29T20:37Z`；换算到报告时区(Asia/Shanghai) = 08-30 04:37 → 2 天窗口
 * （今天+昨天）误判为「昨天」→ 晚间发布的文章被错放进次日报告（如 08-29 晚的证券时报稿
 * 混入 08-31 报告）。用户 2026-08-31 点原文核实确为 8/29，根因为爬虫把北京时间当 UTC 存。
 *
 * 修复：裸时间（含 HH:MM 且无时区后缀）强制补 `+08:00`；已有 `Z`/`±HH:MM` 后缀的不动
 * （API 源返回的合法 ISO）；纯日期（无时间）不动（date-only 在 UTC 下即当天 00:00，
 * 上海时区同日，无偏移）。
 */
function normalizePubTime(s: string | undefined): string | undefined {
  if (!s) return s;
  const t = s.trim();
  if (
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t) &&
    !/[Zz]|[+-]\d{2}:?\d{2}$/.test(t)
  ) {
    return t.replace(" ", "T") + "+08:00";
  }
  return t;
}


/** TS 爬虫产物（fetchCrawledArticles() 的条目；原 .mjs 爬虫 crawled-*.json 的等价结构）。 */
export interface CrawledArticle {
  sourceId?: string;
  source?: string;
  title?: string;
  url?: string;
  excerpt?: string;
  publishedAt?: string;
  /** 来源地域标记：gz（股份行广州分行辖区）/ gd / nation / 其它或缺省。 */
  region?: string;
  category?: string;
  /** 条目级子标签（昨日股市：a-share / hk / us）。爬虫产物标注，路由复盘卡输入用。 */
  subcategory?: string;
  summary?: string;
  /** 源等级（T6）：T1 官方一手 / T1.5 准官方·机构一手 / T2 媒体·智库。 */
  tier?: SourceTier;
  /**
   * 注册省份（结构化地域信号，gdIpo 三道闸第一优先级，2026-08-30 爬虫透传）。
   * 例：东财在审企业表 REG_ADDRESS 字段值为 "广东"。
   */
  registeredProvince?: string;
  /** 已知股票代码（可选，供广东判定离线精确匹配）。 */
  stockCode?: string;
}

/** 爬虫数据的两条进入路径：IPO/新股（mode=ipo）与广州商机（mode=gz）。 */
export type CrawlMode = "ipo" | "gz";

/** 归一化后的统一文章结构（与 ArticleInput 结构兼容，由调用方透传）。 */
export interface MergeArticle {
  sourceId: string;
  source: string;
  title: string;
  url: string;
  excerpt: string;
  publishedAt?: Date;
  category: Category;
  summary: string;
  tier?: SourceTier;
  /** 注册省份结构化信号（透传爬虫产物，供 gdIpo 三道闸第一优先级判定）。 */
  registeredProvince?: string;
  /** 已知股票代码（透传，供广东判定离线精确匹配）。 */
  stockCode?: string;
  /**
   * IPO 内容态（2026-08-31 3漏斗整改 commit②，红线：过滤行为不得依赖源分类字符串）。
   * routeRegion 解析出 category=gd-ipo/ipo 时为真；过滤层据此豁免单机构/相似度/
   * 跨天去重/窗口，替代原硬编码 category 字符串判断。
   */
  isIpo?: boolean;
}

export interface RouteOpts {
  /** gz 模式下，若调用方查得到注册表 category（如 gz-gov → finance）则传入，缺省 'gz'。 */
  gzCategory?: Category;
  /** ipo 模式下爬虫条目的 region 标记（'gz' → 归入广州辖区并改写 gz- 前缀）。 */
  region?: string;
}

/**
 * region 分流 + 前缀改写（原 daily.ts 第 400-402 行逻辑的纯函数版）。
 * - ipo 模式：region==='gz' → category='gz' 且 sourceId `gd-`→`gz-` 改写；
 *   region==='gd' → category='gd-ipo'（广东企业，进「广东地区IPO」板块，2026-08-30 重启）；
 *   否则 category='ipo'（全国 IPO/新股）不改写。
 * - gz 模式：sourceId 原样保留，category 用 gzCategory ?? 'gz'。
 */
export function routeRegion(
  srcId: string,
  mode: CrawlMode,
  opts: RouteOpts = {},
): { sourceId: string; category: Category } {
  if (mode === "ipo") {
    const category =
      opts.region === "gz" ? REGION_GZ : opts.region === "gd" ? REGION_GD_IPO : REGION_IPO;
    const sourceId = category === REGION_GZ ? rewriteGzPrefix(srcId) : srcId;
    return { sourceId, category };
  }
  return { sourceId: srcId, category: opts.gzCategory ?? REGION_GZ };
}

/** 单条爬虫产物 → MergeArticle（含默认值映射与 tier 透传）。 */
export function toMergeArticle(
  item: CrawledArticle,
  mode: CrawlMode,
  opts: RouteOpts = {},
): MergeArticle {
  const srcId =
    item.sourceId || (mode === "ipo" ? DEFAULT_SCRAPER_SOURCE_ID : DEFAULT_GZ_SOURCE_ID);
  const { sourceId, category } = routeRegion(srcId, mode, {
    gzCategory: opts.gzCategory,
    region: item.region,
  });
  const resolvedPub = item.publishedAt || extractDateFromUrl(item.url);
  return {
    sourceId,
    source: item.source || (mode === "ipo" ? "广东本地爬虫" : "广州商机"),
    title: item.title || "无标题",
    url: item.url || "",
    // B：excerpt fallback（2026-08-28 用户反馈）：无 excerpt 时用 title 前 90 字符占位
    excerpt: item.excerpt?.trim() || item.title?.slice(0, 90) || "",
    publishedAt: resolvedPub ? new Date(normalizePubTime(resolvedPub)!) : undefined,
    // 2026-08-27 核心规则：无发布时间直接 discarded — 上游调用方（fetchCrawledArticles
    // 入口或 filter 阶段 no-date-fallback）负责丢弃，不再写 fetchedAt 兜底。
    category,
    // IPO 内容态（3漏斗整改 commit②）：爬虫产物归一化时按 routeRegion 结果兜底标注，
    // 供过滤层豁免。category 为 gd-ipo/ipo 即 IPO（region=gz 时归 gz 辖区不在此列，
    // 与旧硬编码 category 豁免口径完全一致）。
    ...(category === REGION_GD_IPO || category === REGION_IPO ? { isIpo: true } : {}),
    summary: item.summary || "",
    ...(item.tier ? { tier: item.tier } : {}),
    ...(item.registeredProvince ? { registeredProvince: item.registeredProvince } : {}),
    ...(item.stockCode ? { stockCode: item.stockCode } : {}),
  };
}

/** 按 URL 去重合并：保留 base 中已存在者（incoming 重复项跳过），返回合并结果与计数。 */
export function dedupeByUrl<T extends { url: string }>(
  base: T[],
  incoming: T[],
): { merged: T[]; added: number; skipped: number } {
  const merged = [...base];
  let added = 0;
  for (const it of incoming) {
    if (merged.some((a) => a.url === it.url)) continue;
    merged.push(it);
    added++;
  }
  return { merged, added, skipped: incoming.length - added };
}

/**
 * 超窗口旧文过滤（归一化②）：publishedAt 早于窗口（默认 7 天）的条目丢弃。
 *
 * 动机（2026-08-19 用户反馈）：rss 流会混入 7 天前甚至更早的旧文，其 URL 不在
 * 7 天历史缓存 → 被误判为「新条目」进 AI 分类（白花模型费用），且会显示在当日
 * 面板。过滤后：旧文不进 AI、不展示。
 * 时间红线（2026-08-29 用户）：**无真实发布时间的条目一律丢弃，不回退 fetchedAt
 * 兜底**（采集时间不是发布时间）。源层 ingest.ts:73 已弃无日期条目，此处兜底清理。
 */
export function filterByWindow<T extends { publishedAt?: Date | string }>(
  articles: T[],
  days = 7,
): T[] {
  // 日历日窗口（2026-08-31 修复）：发布日期(报告时区)∈ 最近 days 个日历日，替代 48h 滑动。
  // 时间红线：无真实发布时间 → 丢弃（isWithinCalendarDays 内部处理）。
  return articles.filter((a) => isWithinCalendarDays(a.publishedAt, days));
}
