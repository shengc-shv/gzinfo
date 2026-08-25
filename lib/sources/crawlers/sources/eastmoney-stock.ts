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
  /**
   * 日期窗口（天）：A股复盘卡要取「抓取日-1」最近交易日收盘数据。
   * 用 3 天而非 2 天：CI 多在周一/节后首跑，上一交易日是周五（距抓取日 3 个日历日），
   * 2 天窗口会把正确的周五数据误删；3 天可扛住周末/单休缺口，且多余旧文由复盘 LLM 按日期取最新忽略。
   */
  windowDays = 3;
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
      // 窗口过滤：无日期者保留（宁可保留），有日期且早于 cutoff 跳过，避免陈旧项泄漏
      if (publishedAt) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - this.windowDays);
        const pd = new Date(publishedAt);
        if (!Number.isNaN(pd.getTime()) && pd < cutoff) continue;
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
