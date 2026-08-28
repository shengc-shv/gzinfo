import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 新浪财经·港股频道（finance.sina.com.cn/stock/hkstock）爬虫
 *
 * 用途：补足「昨日股市·港股」分组的**市场新闻/解读类**内容。
 * 原港股源 hkex-stock 抓的是披露易「最新公司公告」JSON（全英文公司级公告，
 * 如 Circulars / Proxy Forms / Share Buyback），对「收盘解读/板块/资金」支撑弱；
 * 本爬虫抓新浪港股频道列表页，得到中文的券商评级、恒指季检、港股通/南向资金、
 * 港元配售等市场解读新闻，更贴合「股市解读」需求。
 *
 * 经实测（2026-08-25）：频道页 https://finance.sina.com.cn/stock/hkstock/
 * 首屏约 49 条 dated doc 链接；按「港股相关性」过滤（标题含港股关键词或
 * 港股代码 (0XXXX)）保留 ~22 条，A股/通用项被排除。
 *
 * 产物：sourceId=sina-hk-stock，category=stocks / subcategory=hk（与 hkex-stock 同组）。
 */
const SINA_HK_URL = "https://finance.sina.com.cn/stock/hkstock/";
const SINA_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SINA_REF = "https://finance.sina.com.cn/stock/hkstock/";

/** 匹配新浪财经文章链接并捕获标题与路径日期 */
const ARTICLE_RE =
  /<a[^>]*href="(https?:\/\/finance\.sina\.com\.cn\/[^"]*\/(\d{4}-\d{2}-\d{2})\/doc-[a-z0-9]+\.shtml)"[^>]*>([\s\S]*?)<\/a>/g;

/** 港股相关性关键词（标题命中其一即视为港股市场新闻） */
const HK_KEYWORDS = [
  "港股", "恒生", "恒指", "南向", "港股通", "港交所", "香港", "港元",
  "H股", "红筹", "中资", "北水", "蓝筹", "仙股", "大湾区",
];
/** 港股代码特征：如 携程集团-S(09961)、贝壳-W(02423)、中兴通讯(00763) */
const HK_CODE_RE = /\(0\d{4}\)/;

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 大盘收评/总结类（恒指收评、港股收评、港股市场综述、盘后复盘等）——最贴合「大盘解读」主源 */
const RECAP_PRIORITY_RE =
  /收评|综述|盘点|盘后|复盘|收市|收盘点评|港股收评|市场总结|港股分析|大势研判/;

function validDate(raw: string): string {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export class SinaHkStockCrawler extends BaseCrawler {
  /** 只保留最近 N 天（复盘卡要取「抓取日-1」港股收盘数据）。
   *  用 3 天而非 2 天：CI 多在周一/节后首跑，上一港股交易日是周五（距抓取日 3 个日历日），
   *  2 天窗口会误删正确的周五数据；3 天扛住周末缺口，多余旧文由复盘 LLM 按日期取最新忽略。 */
  windowDays = 3;
  /** 单次最多保留条数 */
  maxItems = 40;

  constructor() {
    super({ name: "新浪财经·港股频道", timeout: 15000, retries: 2 });
  }

  private async _getHtml(url: string): Promise<string | null> {
    const maxAttempts = this.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": SINA_UA,
            Referer: SINA_REF,
            Accept: "text/html,application/xhtml+xml",
          },
          signal: AbortSignal.timeout(this.timeout),
        });
        if (!resp.ok) {
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }
          console.warn(`[${this.name}] ${url} 返回 ${resp.status}`);
          return null;
        }
        return await resp.text();
      } catch (err) {
        console.warn(
          `[${this.name}] ${url} 抓取失败（尝试 ${attempt}/${maxAttempts}）: ${(err as Error).message}`,
        );
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  async run(): Promise<CrawlerResult[]> {
    console.log(`[${this.name}] 开始抓取 (SSR 列表页)`);
    const html = await this._getHtml(SINA_HK_URL);
    if (!html) {
      console.log(`[${this.name}] 列表页抓取失败，返回 0 条`);
      return this.results;
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.windowDays);
    const seen = new Set<string>();
    let matched = 0;

    ARTICLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ARTICLE_RE.exec(html))) {
      const url = m[1].replace(/^http:/, "https:");
      const date = validDate(m[2]);
      const title = stripTags(m[3]);
      if (!title || title === "【详细】" || title.length < 6 || !date) continue;
      if (seen.has(url)) continue;
      matched++;
      seen.add(url);
      // 港股相关性过滤：标题含港股关键词或港股代码
      const isHk =
        HK_KEYWORDS.some((k) => title.includes(k)) || HK_CODE_RE.test(title);
      if (!isHk) continue;
      // 2 天窗口过滤
      if (new Date(date) < cutoff) continue;
      this.results.push({
        title,
        url,
        excerpt: "",
        publishedAt: date,
        sourceId: "sina-hk-stock",
        source: "新浪财经·港股",
        category: "stocks",
        subcategory: "hk",
        region: "nation",
      });
    }

    // 排序：大盘收评/总结类优先（最贴合「大盘解读」主源），其次按日期倒序；限 maxItems
    const prio = (t: string): number => (RECAP_PRIORITY_RE.test(t) ? 1 : 0);
    this.results.sort((a, b) => {
      const pa = prio(a.title);
      const pb = prio(b.title);
      if (pa !== pb) return pb - pa;
      return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    });
    if (this.results.length > this.maxItems) this.results.length = this.maxItems;

    console.log(
      `[${this.name}] 完成：匹配 ${matched} 条 dated doc，港股命中 ${this.results.length} 条（窗口 ${this.windowDays} 天）`,
    );
    return this.results;
  }
}

export function createCrawler(): SinaHkStockCrawler {
  return new SinaHkStockCrawler();
}
