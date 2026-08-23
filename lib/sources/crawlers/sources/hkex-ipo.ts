import { BaseCrawler } from "../base-crawler";
import { isGuangdongEnterprise } from "../../guangdong.mjs";

/**
 * 港交所（HKEX）IPO 公告爬虫
 * 数据来源: https://www1.hkexnews.hk/ncms/json/eds/lcisehk7relsde_1.json
 *          （披露易「最新公司公告」JSON 接口，云端可达）
 *
 * M3-A 移植：原 scripts/crawlers/sources/hkex-ipo.mjs 逐字移植。
 */

const IPO_KEYWORDS = [
  // 中文（港股 IPO 流程术语）
  "招股", "招股章程", "全球发售", "发售价", "股份发售", "配发结果", "新上市",
  "申请版本", "聆讯", "上市", "公开发售", "国际发售",
  // 英文
  "IPO", "global offer", "prospectus", "listing", "placing", "offer for sale",
  "subscription", "application proof", "post-vetting", "heard", "allotment",
  "public offer", "result", "initial public offering",
];

export class HKEXCrawler extends BaseCrawler {
  windowDays = 7;

  constructor() {
    super({
      name: "港交所IPO公告",
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

  async parseArticle(responseText: string, url: string) {
    const articles: import("../base-crawler").CrawlerResult[] = [];
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - this.windowDays);

    try {
      const data = JSON.parse(responseText);
      if (!data.newsInfoLst || !Array.isArray(data.newsInfoLst)) {
        console.warn(`[${this.name}] JSON中未找到 newsInfoLst 数组`);
        return articles;
      }

      const list = data.newsInfoLst;
      console.log(
        `[${this.name}] 接口共返回 ${list.length} 条公告（最近${this.windowDays}天窗口内筛选）`,
      );

      for (const item of list) {
        const title = item.title || item.lTxt || "";
        const shortTitle = item.sTxt || "";
        const relTime = item.relTime || "";
        const webPath = item.webPath || "";
        const fileExt = item.ext || "pdf";

        const stockInfo = item.stock || [];
        const stockCodes = stockInfo.map((s: { sc?: string }) => s.sc || "").filter(Boolean).join(", ");
        const stockNames = stockInfo.map((s: { sn?: string }) => s.sn || "").filter(Boolean).join(", ");

        // 解析日期（DD/MM/YYYY）
        let pubDate = relTime;
        if (pubDate) {
          const dateMatch = pubDate.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (dateMatch) {
            pubDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
          }
        } else {
          pubDate = new Date().toISOString().slice(0, 10);
        }

        const itemDate = new Date(pubDate);
        if (isNaN(itemDate.getTime()) || itemDate < sevenDaysAgo) continue;

        // ⭐ 过滤 1：必须是 IPO / 新股上市类公告
        const allText = `${title} ${shortTitle} ${stockNames}`.toLowerCase();
        const isIpo = IPO_KEYWORDS.some((kw) => allText.includes(kw.toLowerCase()));
        if (!isIpo) continue;

        // ⭐ 过滤 2：必须是广东企业。优先按港股代码 + 公司名在粤企注册表命中
        //   （覆盖"公告只写企业名/代码、不写地点"的情况，如腾讯/网易/小鹏），
        //   退化到城市名匹配。统一入口见 lib/sources/guangdong.mjs。
        const stockCodeArr = stockInfo.map((s: { sc?: string }) => s.sc || "").filter(Boolean);
        const isGuangdong = isGuangdongEnterprise(
          `${title} ${shortTitle} ${stockNames}`,
          { codes: stockCodeArr },
        );
        if (!isGuangdong) continue;

        // 标题：明确展示"哪家公司"
        let fullTitle = stockNames || title;
        if (stockCodes) fullTitle += ` (${stockCodes})`;
        if (title && title !== stockNames) fullTitle += ` — ${title}`;

        let pdfUrl = "";
        if (webPath) {
          pdfUrl = webPath.startsWith("http")
            ? webPath
            : `https://www1.hkexnews.hk${webPath}`;
        }

        let excerpt = `港交所公告`;
        if (stockCodes) excerpt += ` | 代码: ${stockCodes}`;
        if (stockNames) excerpt += ` | 公司: ${stockNames}`;
        if (relTime) excerpt += ` | 时间: ${relTime}`;
        if (fileExt) excerpt += ` | 格式: ${fileExt.toUpperCase()}`;

        articles.push({
          title: fullTitle,
          url: pdfUrl || url,
          excerpt,
          publishedAt: pubDate,
          sourceId: "hkex",
        });
      }

      console.log(
        `[${this.name}] 匹配到 ${articles.length} 家广东企业港股IPO相关公告`,
      );
    } catch (err) {
      console.error(`[${this.name}] 解析JSON失败:`, (err as Error).message);
    }

    return articles;
  }
}

export function createCrawler(): HKEXCrawler {
  return new HKEXCrawler();
}
