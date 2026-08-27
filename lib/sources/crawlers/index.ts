/**
 * 爬虫 runner 入口（M3-A：双采集系统合并）
 *
 * 原 scripts/crawlers/run-all.mjs（IPO 六源 → data/crawled-articles.json）与
 * scripts/crawlers/run-gz.mjs（广州商机三源 → data/crawled-gz.json）的逻辑合并：
 * 由 daily.ts 进程内直接调用本入口，不再 shell 出去写 JSON 中间文件。
 *
 * 每个爬虫独立 try/catch 隔离（单源失败不连坐），结果按 URL 去重。
 */
import type { CrawledArticle } from "../../ingest/merge";
import { BaseCrawler } from "./base-crawler";
import { HKEXCrawler } from "./sources/hkex-ipo";
import { SSEAPICrawler } from "./sources/sse-api";
import { SZSEAPICrawler } from "./sources/szse-api-crawler";
import { BSEAPICrawler } from "./sources/bse-api";
import { EastMoneyIPOCrawler } from "./sources/eastmoney-ipo";
import { GzStatsCrawler } from "./sources/gz-stats";
import { GzGovCrawler } from "./sources/gz-gov";
import { CnfinCrawler } from "./sources/cnfin-web";
import { StcnCrawler } from "./sources/stcn-web";
import { SinaBankCrawler } from "./sources/sina-bank-web";
import { GuanchaCrawler } from "./sources/guancha-web";
// 2026-08-21 广州本地媒体第一梯队（解决"热点发现"）：大洋网广州/南方经济/中新网广东/央广网广东
// （金羊网 ycwb.com 有 JS 反爬壳暂缓，后续专项处理）
import { DayooGzCrawler } from "./sources/dayoo-gz";
import { SouthcnEconomyCrawler } from "./sources/southcn-economy";
import { CnrGdCrawler } from "./sources/cnr-gd";
// 2026-08-25 昨日股市信息源（A股/港股新闻采集）
import { EastMoneyStockCrawler } from "./sources/eastmoney-stock";
import { HKEXStockCrawler } from "./sources/hkex-stock";
// 2026-08-25 新浪港股市场新闻（补足港股解读类内容，披露易公告偏英文公司级）
// 2026-08-27 升级为港股解读主源（用户要求：港股总结走新浪而非东方财富）
import { SinaHkStockCrawler } from "./sources/sina-hk-stock";
import { SinaAStockCrawler } from "./sources/sina-a-stock";
// 2026-08-22：chinanews-gd（中新网广东）命中率 0% 已砍掉，Crawler 文件保留便于未来恢复。
// 2026-08-20 用户决定：取消南沙信息源（只看广州市政府 gz-gov），GzNanshaCrawler 停用，
// 文件保留便于未来恢复。
// 2026-08-20 本地化停用：TonghuashunIPOCrawler / NfraCrawler / PbcCrawler / ClsCrawler
// 已被 WAF 拦截国外 IP，改由本地 skill（local-acquire，scripts/acquire-local.mts）抓取后
// 经 data/local-acquired.json 并入 daily 管线；此处不再 import/实例化（远程不查），
// 文件保留便于未来恢复。

export interface CrawledBundle {
  ipo: CrawledArticle[];
  gz: CrawledArticle[];
  stocks: CrawledArticle[];
}

/** 按 URL 去重（保留首次出现） */
function dedupeByUrl<T extends { url?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const key = it.url || "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(it);
  }
  return out;
}

export async function fetchCrawledArticles(): Promise<CrawledBundle> {
  // —— IPO / 新股（2026-08-25 用户决定：全部 IPO 功能废弃，明天重新设计；代码保留）——
  // 停用 HKEXCrawler / SSEAPICrawler / SZSEAPICrawler / BSEAPICrawler / EastMoneyIPOCrawler
  // 2026-08-25 用户红线：IPO 相关功能全部废弃（数据太老/方案要重设计），不抓取、不渲染
  const ipoCrawlers: BaseCrawler[] = [];

  const ipo: CrawledArticle[] = [];
  for (const crawler of ipoCrawlers) {
    try {
      await crawler.run();
      ipo.push(...(crawler.toGzcmbdf3Format() as CrawledArticle[]));
    } catch (err) {
      console.error(`[${crawler.name}] 爬虫异常:`, (err as Error).message);
    }
  }

  // —— 广州商机 + 财经媒体（2026-08-20 起南沙停用；nfra/pbc/cls 已本地化停用）→ 取原始 results（保留 category/subcategory/region/sourceId）——
  // 注：nfra/pbc/cls（国家金融监督管理总局/中国人民银行/财联社）被 WAF 拦国外 IP，
  // 已本地化停用（本地 skill local-acquire → data/local-acquired.json → daily 读取并入）；
  // 其 SOURCE_ROUTE（finance/cn-policy、finance/cn-finance）仍保留供 local-acquired 路由。
  // 2026-08-25 用户决定：废弃广州市政府 gz-gov / 广州统计局 gz-stats（数据太老，无用），代码保留
  const gzCrawlers: BaseCrawler[] = [
    // new GzStatsCrawler(),  // 2026-08-25 废弃：数据太老
    // new GzGovCrawler(),    // 2026-08-25 废弃：数据太老
    new CnfinCrawler(),
    new StcnCrawler(),
    new SinaBankCrawler(),
    new GuanchaCrawler(),
    // 2026-08-21 广州本地媒体第一梯队（config enabled:false + 实测通过后启用）
    new DayooGzCrawler(),
    new SouthcnEconomyCrawler(),
    // 2026-08-22：chinanews-gd 命中率 0% 已停用（Crawler 类保留）
    new CnrGdCrawler(),
  ];

  const gz: CrawledArticle[] = [];
  for (const crawler of gzCrawlers) {
    try {
      await crawler.run();
      gz.push(...(crawler.results as CrawledArticle[]));
    } catch (err) {
      console.error(`[${crawler.name}] 异常:`, (err as Error).message);
    }
  }

  // —— 昨日股市信息源（2026-08-25 新增）：A股（东方财富 + 新浪A股交叉验证）+ 港股（披露易公告 + 新浪港股解读）——
  // 美股由 RSS 源 investing-news 走 fetchAll 抓取（CI 可达），不在此列。
  const stocksCrawlers: BaseCrawler[] = [
    new EastMoneyStockCrawler(),
    new SinaAStockCrawler(),
    new HKEXStockCrawler(),
    new SinaHkStockCrawler(),
  ];

  const stocks: CrawledArticle[] = [];
  for (const crawler of stocksCrawlers) {
    try {
      await crawler.run();
      stocks.push(...(crawler.results as CrawledArticle[]));
    } catch (err) {
      console.error(`[${crawler.name}] 异常:`, (err as Error).message);
    }
  }

  return { ipo: dedupeByUrl(ipo), gz: dedupeByUrl(gz), stocks: dedupeByUrl(stocks) };
}
