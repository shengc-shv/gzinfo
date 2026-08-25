import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 东方财富·A股股市新闻爬虫（2026-08-25 新增，昨日股市 tab 的 A股信息源）
 *
 * 数据来源: https://stock.eastmoney.com/a/cgsxw.html（股市新闻列表页，静态 HTML）
 * 链接形如 https://finance.eastmoney.com/a/202608243850908921.html（/a/YYYYMMDDxxxx.html），
 * URL 内嵌发布日期，无需进详情页即可得到发布时间。
 * 归属：category=stocks / subcategory=a-share（「昨日股市」tab 的 A股分组）。
 */
const LINK_RE =
  /<a[^>]*href="(https:\/\/finance\.eastmoney\.com\/a\/\d{18}\.html)"[^>]*>([^<]{8,80})<\/a>/g;

export class EastMoneyStockCrawler extends BaseCrawler {
  constructor() {
    super({
      name: "东方财富·A股股市新闻",
      keywords: [],
      timeout: 15000,
      retries: 3,
    });
  }

  async getUrls(): Promise<string[]> {
    return ["https://stock.eastmoney.com/a/cgsxw.html"];
  }

  async parseArticle(html: string, _url: string): Promise<CrawlerResult[]> {
    const articles: CrawlerResult[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(LINK_RE)) {
      const link = m[1];
      let title = m[2].trim().replace(/\s+/g, "");
      if (seen.has(link)) continue;
      seen.add(link);
      // 标题含 &nbsp; 等 HTML 实体时解码常用实体
      title = title
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&ldquo;|&rdquo;/g, "“")
        .replace(/&hellip;/g, "…")
        .trim();
      if (!title) continue;
      // URL 内嵌日期 YYYYMMDD（18 位：8 位日期 + 10 位流水号）
      const d = link.match(/\/a\/(\d{8})\d{10}\.html/);
      let publishedAt: string | undefined;
      if (d) {
        publishedAt = `${d[1].slice(0, 4)}-${d[1].slice(4, 6)}-${d[1].slice(6, 8)}`;
      }
      articles.push({
        sourceId: "eastmoney-stock",
        source: "东方财富",
        title,
        url: link,
        excerpt: "",
        publishedAt,
        category: "stocks",
        subcategory: "a-share",
        region: "nation",
      });
    }
    return articles;
  }
}
