import { BaseCrawler } from "../base-crawler";

/**
 * 东方财富 - IPO辅导备案信息爬虫（API版）
 * 数据来源: https://datacenter-web.eastmoney.com/api/data/v1/get
 *
 * 过滤逻辑：保留广东地区企业（数据本身已是辅导备案，无需额外 IPO 过滤）
 * - 地区关键词：广东、广州、深圳、东莞、佛山、珠海等
 *
 * M3-A 移植：原 scripts/crawlers/sources/eastmoney-ipo.mjs 逐字移植。
 */
export class EastMoneyIPOCrawler extends BaseCrawler {
  constructor() {
    super({
      name: "东方财富IPO辅导",
      keywords: [], // 父类不过滤，传空数组
      timeout: 15000,
    });
  }

  async getUrls(): Promise<string[]> {
    const baseUrl = "https://datacenter-web.eastmoney.com/api/data/v1/get";
    const params = new URLSearchParams({
      reportName: "RPT_IPO_TUTRECORD",
      columns:
        "TUTOR_OBJECT,ORG_CODE,TUTOR_ORG_CODE,TUTOR_ORG,TUTOR_PROCESS_STATE,REPORT_TYPE,DISPATCH_ORG,REPORT_TITLE,RECORD_DATE",
      sortColumns: "RECORD_DATE,TUTOR_OBJECT",
      sortTypes: "-1,-1",
      source: "WEB",
      client: "WEB",
      pageNumber: "1",
      pageSize: "100",
    });

    return [`${baseUrl}?${params.toString()}`];
  }

  async parseArticle(responseText: string): Promise<import("../base-crawler").CrawlerResult[]> {
    const articles: import("../base-crawler").CrawlerResult[] = [];
    // 计算 7 天前的时间戳
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // 地区关键词（广东及主要城市）
    const regionKeywords = [
      "广东", "广州", "深圳", "东莞", "佛山", "珠海", "中山", "惠州",
      "江门", "汕头", "湛江", "肇庆", "梅州", "汕尾", "河源", "阳江",
      "清远", "潮州", "揭阳", "云浮",
    ];

    try {
      const data = JSON.parse(responseText);

      if (!data.result || !data.result.data || !Array.isArray(data.result.data)) {
        console.warn(`[${this.name}] API返回数据格式异常`);
        return articles;
      }

      const list = data.result.data;
      console.log(`[${this.name}] API共返回 ${list.length} 条辅导备案记录`);

      for (const item of list) {
        const companyName = item.TUTOR_OBJECT || "";
        const tutorOrg = item.TUTOR_ORG || "";
        const status = item.TUTOR_PROCESS_STATE || "";
        const reportType = item.REPORT_TYPE || "";
        const dispatchOrg = item.DISPATCH_ORG || "";
        const recordDate = item.RECORD_DATE || "";
        const orgCode = item.ORG_CODE || "";

        // 解析日期
        const pubDate =
          (recordDate || "").match(/(\d{4}-\d{2}-\d{2})/)?.[1] ||
          new Date().toISOString().slice(0, 10);

        // 过滤 7 天前的数据
        const itemDate = new Date(pubDate);
        if (itemDate < sevenDaysAgo) {
          continue;
        }

        // ⭐ 检查地区（公司名或派出机构包含地区关键词）
        const allText = `${companyName} ${dispatchOrg}`;
        const isRegion = regionKeywords.some((kw) => allText.includes(kw));

        if (!isRegion) {
          continue;
        }

        // 构建标题
        let title = companyName;
        if (status) title += ` (${status})`;
        if (dispatchOrg) title += ` [${dispatchOrg}]`;

        // 构建摘要
        let excerpt = `IPO辅导备案`;
        if (tutorOrg) excerpt += ` | 辅导机构: ${tutorOrg}`;
        if (recordDate) excerpt += ` | 备案时间: ${recordDate}`;
        if (status) excerpt += ` | 状态: ${status}`;
        if (reportType) excerpt += ` | 报告: ${reportType}`;

        // 构造详情链接
        const detailUrl = orgCode
          ? `https://data.eastmoney.com/xg/ipo/fd/${orgCode}.html`
          : "";

        articles.push({
          title,
          url: detailUrl,
          excerpt,
          publishedAt: pubDate,
          sourceId: "em-ipo",
        });
      }

      console.log(
        `[${this.name}] 匹配到 ${articles.length} 家广东辅导企业（最近7天）`,
      );
    } catch (err) {
      console.error(`[${this.name}] 解析API失败:`, (err as Error).message);
    }

    return articles;
  }
}

export function createCrawler(): EastMoneyIPOCrawler {
  return new EastMoneyIPOCrawler();
}
