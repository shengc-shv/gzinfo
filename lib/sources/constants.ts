/**
 * 领域常量集中地（M3-G）：region 前缀 / 分类 / 默认源 id。
 *
 * 消除散落在 merge.ts / daily.ts / 配置注释里的魔法字符串
 * （`gd-`→`gz-` 改写、'gz'/'ipo' region 分流等）。
 */
import type { Category } from "./types";

/** 爬虫产物 sourceId 前缀：gd-（广东全省）/ gz-（广州辖区，股份行广州分行重点）。 */
export const GD_PREFIX = "gd-";
export const GZ_PREFIX = "gz-";

/** 爬虫条目缺省 sourceId（crawled-articles.json / crawled-gz.json 未带 sourceId 时）。 */
export const DEFAULT_SCRAPER_SOURCE_ID = "gd-local-scraper";
export const DEFAULT_GZ_SOURCE_ID = "gz-local";

/** 归一化 region 分流的目标分类。 */
export const REGION_GZ: Category = "gz";
export const REGION_IPO: Category = "ipo";

/** 分类渲染/处理顺序（与 render.ts 的分类面板顺序一致）。 */
export const CATEGORY_ORDER: Category[] = [
  "tech",
  "finance",
  "gd-ipo",
  "ipo",
  "gz",
];

/** 把爬虫产物的 sourceId 改写为 gz- 前缀（仅广州辖区条目）。
 *  兼容历史 `gd-` 前缀源；2026-08-23 起爬虫已去 gd- 前缀（sse/szse/bse…），直接加 gz-。 */
export function rewriteGzPrefix(sourceId: string): string {
  if (sourceId.startsWith(GZ_PREFIX)) return sourceId;
  return sourceId.startsWith(GD_PREFIX)
    ? `${GZ_PREFIX}${sourceId.slice(GD_PREFIX.length)}`
    : `${GZ_PREFIX}${sourceId}`;
}

/**
 * 爬虫产物源的路由元数据（M3-D/A：从 sources.config.json 的 file:// 占位源
 * 中抽离，避免「源配置兼任路由表」的概念交叉）。
 *
 * 这些 sourceId 由 TS 爬虫（lib/sources/crawlers/*，M3-A 双采集合并）产出、
 * 经 fetchCrawledArticles() + lib/ingest/merge.ts 归一化接入；category/subcategory
 * 用于：daily.ts 的 regCat、history.ts 的 subcatOf、render groupRaw 的分组。
 * 配置里保留同名 disabled 源仅供 groupRaw 的 knownSourceIds 白名单识别，
 * 路由判定以本表为准。
 */
export const SOURCE_ROUTE: Record<string, { category: Category; subcategory?: string }> = {
  // 广州辖区（gz- 前缀）：股份行广州分行重点
  "gz-stats": { category: "gz", subcategory: "gz-customer" },
  "gz-gov": { category: "finance", subcategory: "gz-policy" },
  // 国家金融监督管理总局（NFRA）：部委级宏观政策/行政处罚，归 finance/cn-policy（国家政策标签）
  "nfra": { category: "finance", subcategory: "cn-policy" },
  // 中国人民银行（PBC）：部委级宏观政策/公告（新闻发布+公告信息），归 finance/cn-policy（国家政策标签）
  "pbc": { category: "finance", subcategory: "cn-policy" },
  // 新华财经（CNFIN）：综合财经媒体（要闻/宏观/区域/产业），归 finance/cn-finance（国内财经新闻标签）
  "cnfin": { category: "finance", subcategory: "cn-finance" },
  // 证券时报（STCN）：财经媒体（新闻/地方·广东/投资），归 finance/cn-finance（国内财经新闻标签）
  "stcn": { category: "finance", subcategory: "cn-finance" },
  // 新浪财经·银行频道（SINA-BANK）：银行业财经媒体，归 finance/cn-finance（国内财经新闻标签）
  "sina-bank": { category: "finance", subcategory: "cn-finance" },
  // 财联社（CLS）：金融深度媒体，归 finance/cn-finance（国内财经新闻标签）
  "cls": { category: "finance", subcategory: "cn-finance" },
  // 观察者网·金融（GUANCHA）：金融评论/深度媒体，归 finance/cn-finance（国内财经新闻标签）
  "guancha": { category: "finance", subcategory: "cn-finance" },
  // —— 广州本地媒体（2026-08-21 第一梯队，解决"热点发现"）——
  // 广州日报·大洋网广州频道 / 南方网·南方经济 / 中新网广东 / 央广网广东，
  // 归 gz 面板 gz-all 合并流（本地+全国+传导统一），subcategory=gz-media 供
  // Pass 1 的 locale 判定更易通过证据校验（广州本地媒体报道自带广州地名）。
  "dayoo-gz": { category: "gz", subcategory: "gz-media" },
  "southcn": { category: "gz", subcategory: "gz-media" },
  "chinanews-gd": { category: "gz", subcategory: "gz-media" },
  "cnr-gd": { category: "gz", subcategory: "gz-media" },
  "gz-sse": { category: "gz", subcategory: "gz-ipo" },
  "gz-szse": { category: "gz", subcategory: "gz-ipo" },
  "gz-bse": { category: "gz", subcategory: "gz-ipo" },
  "gz-hkex": { category: "gz", subcategory: "gz-ipo" },
  "gz-em-ipo": { category: "gz", subcategory: "gz-ipo" },
  // —— 全国 IPO / 新股参考区（2026-08-23 起爬虫去 gd- 前缀，广东识别交给 AI「粤」标签）——
  // 广东全省/全国 IPO 统一归 ipo（全国参考），广东企业由 AI 分析后打「粤」标签区分；
  // 不再用 sourceId 前缀判定地域（曾导致北交所全国公告被误标广东企业）。
  "gd-local-scraper": { category: "ipo", subcategory: "news" },
  "szse": { category: "ipo", subcategory: "szse" },
  "hkex": { category: "ipo", subcategory: "hkex" },
  "em-ipo": { category: "ipo", subcategory: "ipo-tutoring" },
  "sse": { category: "ipo", subcategory: "sse" },
  "bse": { category: "ipo", subcategory: "bse" },
};

/** 爬虫产物源 id 集合（供 dispatch 白名单 / 路由判断）。 */
export const CRAWLED_SOURCE_IDS: ReadonlySet<string> = new Set(Object.keys(SOURCE_ROUTE));
