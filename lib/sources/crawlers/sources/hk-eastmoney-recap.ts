import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 东方财富·港股收评爬虫（2026-08-26 新增）
 *
 * 修复 8-26 报告港股卡 overview/sectors/spoken 全空：
 *   新浪港股只给"今天盘中异动"、披露易只给"今日公告"，
 *   没有任何源提供"昨日港股收盘复盘"素材 → LLM 生成不出三卡。
 *
 * 数据来源：https://hk.eastmoney.com/ 首页 + 评述列表页
 *   - 港股首页聚合「恒指收评」「恒生科技收评」「港股通净流入」等市场综述
 *   - URL 形如 https://hk.eastmoney.com/news/... 或 finance.eastmoney.com 港股频道
 *
 * 归属：category=stocks / subcategory=hk（与 hkex-stock / sina-hk-stock 同组，
 * 三个源合用提供"昨日港股复盘"完整素材：收评（本文）+ 公告（hkex）+ 解读（sina-hk））。
 */
const HK_LIST_URLS = [
  "https://hk.eastmoney.com/",                              // 港股首页（含港股要闻/滚动）
  "https://hk.eastmoney.com/news/cggdd.html",               // 港股大典（滚动，含收评/复盘）
  "https://hk.eastmoney.com/news/cgyw.html",                // 港股要闻
];

/** 匹配港股 收评 / 复盘 / 收盘 类文章链接 */
const HK_RECAP_RE =
  /<a[^>]*href="((?:https?:\/\/(?:hk\.)?eastmoney\.com)[^"]+)"[^>]*>([^<]{8,80})<\/a>/g;

export class HkEastMoneyRecapCrawler extends BaseCrawler {
  /** 港股收评日级窗口：3 天（CI 多在周一/节后首跑，需要拉到周五复盘） */
  windowDays = 3;
  constructor() {
    super({
      name: "东方财富·港股收评",
      keywords: [],
      timeout: 15000,
      retries: 3,
    });
  }

  async getUrls(): Promise<string[]> {
    return HK_LIST_URLS;
  }

  async parseArticle(html: string, _url: string): Promise<CrawlerResult[]> {
    const articles: CrawlerResult[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(HK_RECAP_RE)) {
      const link = m[1];
      const title = m[2].trim().replace(/\s+/g, "");
      if (seen.has(link)) continue;
      seen.add(link);
      // 标题里含"收评/复盘/收盘/收市"等关键词才收（其它如"开盘"不收）
      if (!/(收评|复盘|收盘|收市|盘前|港股周评)/.test(title)) continue;
      // 简单日期提取：URL 中可能含 YYYYMMDD（eastmoney 部分文章 URL 形如 .../news/202608261000.html）
      let publishedAt: string | undefined;
      const d = link.match(/(\d{4})(\d{2})(\d{2})/);
      if (d) publishedAt = `${d[1]}-${d[2]}-${d[3]}`;
      // 窗口过滤
      if (publishedAt) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - this.windowDays);
        const pd = new Date(publishedAt);
        if (!Number.isNaN(pd.getTime()) && pd < cutoff) continue;
      }
      articles.push({
        sourceId: "hk-eastmoney-recap",
        source: "东方财富·港股",
        title,
        url: link,
        excerpt: "",
        publishedAt,
        category: "stocks",
        subcategory: "hk",
        region: "nation",
      });
    }
    return articles;
  }
}
