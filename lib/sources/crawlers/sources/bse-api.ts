import { BaseCrawler } from "../base-crawler";
import { regionOf } from "../province-resolver";

const BSE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// IPO / 发行上市 相关关键词（标题命中即视为 IPO 动态）
const IPO_KEYWORDS = [
  "发行", "上市", "招股", "公开发行", "IPO",
  "注册", "受理", "问询", "上会", "过会", "注册生效",
  "首次公开发行", "申购", "中签", "路演", "询价",
  "辅导备案", "辅导验收",
];

export class BSEAPICrawler extends BaseCrawler {
  constructor() {
    super({
      name: "北交所IPO公告",
      keywords: [], // 地区过滤交给省份解析器
      timeout: 20000,
      retries: 3, // 北交所云端偶发连接层抖动，给足重试
    });
  }

  /**
   * 北交所公告接口需要先访问一次公告页拿 C3VK Cookie（历史经验），
   * 再带 Cookie POST 列表接口。这里在 getUrls 里完成「预热 -> 组装 POST」，
   * 这样基类 run() 的 fetch/重试逻辑可以复用，而不用自己重写整套 run()。
   * Cookie 拿不到也不致命：实测不带 Cookie 也能返回数据。
   */
  async getUrls(): Promise<import("../base-crawler").CrawlUrl[]> {
    let cookie = "";
    try {
      const warm = await fetch("https://www.bse.cn/disclosure/announcement.html", {
        headers: { "User-Agent": BSE_UA },
        redirect: "manual",
      });
      cookie = (warm.headers.get("set-cookie") || "").split(";")[0];
      if (cookie) console.log(`[${this.name}] 已取得预热 Cookie`);
      else console.warn(`[${this.name}] 未取得北交所 Cookie，将不带 Cookie 请求`);
    } catch (err) {
      console.warn(`[${this.name}] 预热取 Cookie 失败（忽略）: ${(err as Error).message}`);
    }

    const body = new URLSearchParams({
      siteId: "6",
      flag: "0",
      page: "0",
      companyCd: "",
      isNewThree: "1",
      keyword: "",
      "xxfcbj[]": "2",
      sortfield: "publish_date",
      sorttype: "desc",
    });
    for (const f of [
      "companyCd", "companyName", "disclosureTitle",
      "disclosurePostTitle", "destFilePath", "publishDate",
      "fileExt", "xxzrlx",
    ]) {
      body.append("needFields[]", f);
    }

    const headers: Record<string, string> = {
      "User-Agent": BSE_UA,
      Referer: "https://www.bse.cn/disclosure/announcement.html",
      Origin: "https://www.bse.cn",
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    };
    if (cookie) headers["Cookie"] = cookie;

    return [
      {
        url: "https://www.bse.cn/disclosureInfoController/initDisclosureList.do",
        method: "POST",
        headers,
        body: body.toString(),
      },
    ];
  }

  async parseArticle(responseText: string): Promise<import("../base-crawler").CrawlerResult[]> {
    const articles: import("../base-crawler").CrawlerResult[] = [];
    try {
      const text = responseText.trimStart();
      if (!text.startsWith("{")) {
        console.warn(`[${this.name}] 接口返回非 JSON（可能是反爬拦截）`);
        return articles;
      }
      const data = JSON.parse(text);
      const content = data?.data?.content;
      if (!Array.isArray(content)) {
        console.warn(`[${this.name}] 返回数据格式异常`);
        return articles;
      }

      // 展平所有披露
      const flat: any[] = [];
      for (const g of content) {
        for (const d of g.disclosures || []) flat.push(d);
      }
      console.log(`[${this.name}] 接口共返回 ${flat.length} 条公告`);

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const seen = new Set<string>(); // 按股票代码去重（每家公司只保留第一条命中公告）
      let provinceChecks = 0;

      for (const item of flat) {
        const stockName = item.companyName || "";
        const stockCode = item.companyCd || "";
        const titleText = item.disclosureTitle || "";

        // 同公司多条公告只处理一次
        if (seen.has(stockCode)) continue;

        // 1) IPO 关键词廉价本地过滤
        const isIpo = IPO_KEYWORDS.some((k) => titleText.includes(k));
        if (!isIpo) continue;

        // 2) 按股票代码解析省份，标记是否广东企业（不再丢弃非广东——全国进「全国IPO/新股」）
        provinceChecks++;
        const reg = await regionOf(stockCode, "BJ");

        // 日期
        // 时间真实性红线（2026-08-25 用户要求，2026-08-29 强化）：接口未给发布时间 →
        // 该条废弃（不产出），绝不回退用抓取日（new Date()）兜底。
        const pubDate =
          (item.publishDate || "").match(/(\d{4}-\d{2}-\d{2})/)?.[1] ||
          (item.pubDate ? new Date(item.pubDate).toISOString().slice(0, 10) : "");
        if (!pubDate) continue;
        if (new Date(pubDate) < sevenDaysAgo) continue;

        seen.add(stockCode);

        const title = `${stockName} (${stockCode})`;
        const excerpt = `北交所公告 | ${titleText} | 日期: ${pubDate}`;
        const detailUrl = item.destFilePath
          ? `https://www.bse.cn${item.destFilePath}`
          : "";

        articles.push({
          title,
          url: detailUrl,
          excerpt,
          publishedAt: pubDate,
          sourceId: "bse",
          region: reg || "nation",
        });
      }

      console.log(
        `[${this.name}] IPO 命中 ${provinceChecks} 家，其中广东企业 ${articles.length} 家`,
      );
      return articles;
    } catch (err) {
      console.error(`[${this.name}] 解析失败:`, (err as Error).message);
      return articles;
    }
  }
}

export function createCrawler(): BSEAPICrawler {
  return new BSEAPICrawler();
}
