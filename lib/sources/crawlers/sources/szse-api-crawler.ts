import { BaseCrawler } from "../base-crawler";
import { regionOf } from "../province-resolver";

/**
 * 深交所 IPO 公告爬虫（数据源：巨潮资讯 cninfo）
 *
 * 为什么用 cninfo 而不是 www.szse.cn：
 * - www.szse.cn/api/disc/announcement/detailinfo 在 GitHub Actions 云 Runner（境外 IP）
 *   上连接层直接 ETIMEDOUT（被 WAF/网络层拦截），本地能通但云端永远失败；
 * - 巨潮资讯(www.cninfo.com.cn) 是沪深北三交所的官方统一披露平台，云端可达、本地也可达，
 *   其 hisAnnouncement/query 接口支持按 column=szse + searchkey 全文检索召回 IPO 类公告，
 *   单页 30 条、可翻页，结果集可控。
 *
 * 过滤逻辑：
 * 1) searchkey="首次公开发行" 召回招股说明书/上市公告书/发行结果/路演/申购等核心 IPO 公告；
 * 2) 按股票代码前缀过滤出真正的深交所（0/3 开头，剔除上交所 6、北交所 8/9/920/4）；
 * 3) 按股票代码解析注册省份=广东（覆盖深圳/广州等地），精准识别广东企业。
 * 注：cninfo 的 column 过滤较宽松（会混入其他交易所），故用代码前缀二次过滤保证只取深交所。
 *
 * M3-A 移植：原 scripts/crawlers/sources/szse-api-crawler.mjs 逐字移植；`import { fetch } from "undici"`
 * 改为全局 fetch（同引擎，去除未声明依赖）。
 */

const CNINFO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 深交所代码：0 开头（主板/中小板）、3 开头（创业板）
export const SZSE_PREFIX = /^[03]/;

export class SZSEAPICrawler extends BaseCrawler {
  windowDays = 7; // 回溯窗口（天）
  maxPages = 12; // 翻页上限，防止异常时无限翻
  searchKey = "首次公开发行";

  constructor() {
    super({
      name: "深交所IPO公告",
      keywords: [],
      timeout: 15000,
      retries: 3,
    });
  }

  _buildBody(pageNum: number): string {
    const end = new Date();
    const start = new Date(Date.now() - this.windowDays * 86400000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const seDate = `${fmt(start)}~${fmt(end)}`;
    return new URLSearchParams({
      pageNum: String(pageNum),
      pageSize: "30",
      column: "szse",
      tabName: "fulltext",
      plate: "",
      stock: "",
      searchkey: this.searchKey,
      secid: "",
      category: "",
      trade: "",
      seDate,
      sortName: "",
      sortType: "",
      isHLtitle: "true",
    }).toString();
  }

  async _fetchPage(pageNum: number): Promise<any | null> {
    const maxAttempts = this.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch("https://www.cninfo.com.cn/new/hisAnnouncement/query", {
          method: "POST",
          headers: {
            Referer: "https://www.cninfo.com.cn/new/index",
            Origin: "https://www.cninfo.com.cn",
            "User-Agent": CNINFO_UA,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          },
          body: this._buildBody(pageNum),
          signal: AbortSignal.timeout(this.timeout),
        });
        if (!resp.ok) {
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 1000 * attempt * attempt));
            continue;
          }
          console.warn(`[${this.name}] 第${pageNum}页返回 ${resp.status}`);
          return null;
        }
        return await resp.json();
      } catch (err) {
        console.warn(
          `[${this.name}] 第${pageNum}页抓取失败（尝试 ${attempt}/${maxAttempts}）: ${(err as Error).message}`,
        );
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000 * attempt * attempt));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  async run(): Promise<import("../base-crawler").CrawlerResult[]> {
    console.log(
      `[${this.name}] 开始抓取 (cninfo, 最近${this.windowDays}天, 关键词="${this.searchKey}")`,
    );
    const articles: import("../base-crawler").CrawlerResult[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let provinceChecks = 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.windowDays);

    for (let page = 1; page <= this.maxPages; page++) {
      const data = await this._fetchPage(page);
      if (!data) break;
      const list = data.announcements || [];
      if (!list.length) break;

      let oldestTs = Infinity;
      for (const item of list) {
        const code = String(item.secCode || "").replace(/^[a-zA-Z]+/, "");
        const name = item.secName || "";
        const title = item.announcementTitle || "";
        const ts = Number(item.announcementTime) || 0;
        // 时间真实性红线（2026-08-25 用户要求，2026-08-29 强化）：接口未给发布时间 →
        // 该条废弃（不产出），绝不回退用抓取日（new Date()）兜底。
        if (!ts) continue;
        const pubDate = new Date(ts).toISOString().slice(0, 10);
        if (ts) oldestTs = Math.min(oldestTs, ts);

        // 仅保留真正的深交所代码（0/3 开头），剔除上交所/北交所等
        if (!SZSE_PREFIX.test(code)) continue;
        if (new Date(pubDate) < cutoff) continue;
        // searchkey 已召回 IPO 类，这里再兜一道关键词
        if (!title.includes(this.searchKey)) continue;

        // 按股票代码解析省份，标记是否广东企业（轻微限速避免 emweb 限流）
        // 注：不再丢弃非广东企业——广东的进「广东地区IPO」，其余进「全国IPO/新股」
        provinceChecks++;
        await new Promise((r) => setTimeout(r, 80));
        const reg = await regionOf(code, "SZ");

        // 每家公司只保留一条
        if (seen.has(code)) continue;
        seen.add(code);

        const detailUrl = item.adjunctUrl
          ? `https://static.cninfo.com.cn/${item.adjunctUrl}`
          : "";
        articles.push({
          title: `${name} (${code})`,
          url: detailUrl,
          excerpt: `深交所公告 | ${title} | 日期: ${pubDate}`,
          publishedAt: pubDate,
          sourceId: "szse",
          region: reg || "nation",
        });
      }

      scanned += list.length;
      // 本页最旧公告已超出窗口，停止翻页
      if (oldestTs < cutoff.getTime()) break;
      if (!data.hasMore) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log(
      `[${this.name}] 扫描 ${scanned} 条，IPO 命中 ${provinceChecks} 家，其中广东企业 ${articles.filter((a) => a.region === "gd").length} 家、全国共 ${articles.length} 家`,
    );
    this.results.push(...articles);
    console.log(`[${this.name}] 完成，共 ${this.results.length} 条`);
    return this.results;
  }
}

export function createCrawler(): SZSEAPICrawler {
  return new SZSEAPICrawler();
}
