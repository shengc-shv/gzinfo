import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 港交所披露易·最新上市公司公告爬虫（2026-08-25 新增，昨日股市 tab 的港股信息源）
 *
 * 数据来源: https://www1.hkexnews.hk/ncms/json/eds/lcisehk7relsde_1.json
 * （披露易「最新公司公告」JSON 接口，与 hkex-ipo 同源）
 *
 * 与港交所IPO爬虫（hkex-ipo.ts）区分：本爬虫**过滤掉 IPO 关键词**，保留
 * 业绩/盈警/回购/配售/停牌/交易安排等市场相关公告——供「昨日股市·港股」分组。
 * 归属：category=stocks / subcategory=hk。
 */
const IPO_KEYWORDS = [
  // 中文（港股 IPO 流程术语）
  "招股", "招股章程", "全球发售", "发售价", "股份发售", "配发结果", "新上市",
  "申请版本", "聆讯", "上市", "公开发售", "国际发售",
  // 英文
  "ipo", "global offer", "prospectus", "listing", "placing", "offer for sale",
  "subscription", "application proof", "post-vetting", "heard", "allotment",
  "public offer", "initial public offering",
];

export class HKEXStockCrawler extends BaseCrawler {
  /** 只保留最近 N 天公告（披露易接口返回 ~500 条，需窗口过滤避免淹没管线）。
   *  用 3 天而非 2 天：CI 多在周一/节后首跑，上一港股交易日是周五（距抓取日 3 个日历日），
   *  2 天窗口会误删正确的周五数据；3 天扛住周末缺口，多余旧文由复盘 LLM 按日期取最新忽略。 */
  windowDays = 3;
  /** 单次最多保留条数（按日期倒序取最新，防全量英文公告淹没「港股」分组）。 */
  maxItems = 40;

  constructor() {
    super({
      name: "港交所披露易·最新公告",
      keywords: [],
      timeout: 15000,
      retries: 3,
    });
  }

  async getUrls(): Promise<string[]> {
    const timestamp = Date.now();
    return [
      `https://www1.hkexnews.hk/ncms/json/eds/lcisehk7relsde_1.json?_=${timestamp}`,
    ];
  }

  async parseArticle(responseText: string, _url: string): Promise<CrawlerResult[]> {
    const articles: CrawlerResult[] = [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.windowDays);
    try {
      const data = JSON.parse(responseText);
      if (!data.newsInfoLst || !Array.isArray(data.newsInfoLst)) {
        console.warn(`[${this.name}] JSON中未找到 newsInfoLst 数组`);
        return articles;
      }
      const list = data.newsInfoLst;
      console.log(`[${this.name}] 接口共返回 ${list.length} 条公告（${this.windowDays} 天窗口内保留市场类 ≤${this.maxItems}）`);

      for (const item of list) {
        const title = item.lTxt || item.sTxt || "";
        const shortTitle = item.sTxt || "";
        // 跳过 IPO 相关公告（避免与港交所IPO爬虫重复归桶）
        const lower = title.toLowerCase();
        if (IPO_KEYWORDS.some((k) => lower.includes(k))) continue;

        const relTime = item.relTime || "";
        // 解析日期（DD/MM/YYYY）
        let pubDate = relTime;
        if (pubDate) {
          const dateMatch = pubDate.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (dateMatch) {
            pubDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
          }
        } else {
          // 时间真实性红线（2026-08-25 用户要求，2026-08-29 强化）：接口未给发布时间 →
          // 该条废弃（不产出），绝不回退用抓取日（new Date()）兜底。
          continue;
        }

        // 窗口过滤：只保留最近 windowDays 天
        const itemDate = new Date(pubDate);
        if (!Number.isNaN(itemDate.getTime()) && itemDate < cutoff) continue;

        const webPath = item.webPath || "";
        const pdfUrl = webPath.startsWith("http")
          ? webPath
          : `https://www1.hkexnews.hk${webPath}`;

        articles.push({
          sourceId: "hkex-stock",
          source: "港交所披露易",
          title,
          url: pdfUrl,
          excerpt: shortTitle || "",
          publishedAt: pubDate,
          category: "stocks",
          subcategory: "hk",
          region: "nation",
        });
      }
      // 按日期倒序取最新 maxItems 条
      articles.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
      if (articles.length > this.maxItems) articles.length = this.maxItems;
    } catch (err) {
      console.warn(`[${this.name}] JSON 解析失败: ${(err as Error).message}`);
    }
    return articles;
  }
}
