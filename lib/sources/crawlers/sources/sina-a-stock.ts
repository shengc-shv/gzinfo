import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 新浪财经·A股频道（finance.sina.com.cn/stock）爬虫
 *
 * 用途：A股「股市解读」的**交叉验证源**（2026-08-25 用户确认，与东财构成 A股双源）。
 * 主源 eastmoney-stock 抓东方财富「股市新闻」列表页；本爬虫抓新浪财经 A股频道列表页，
 * 两源独立（不同站点/不同编辑），涨跌概况与关键板块可互相印证。
 *
 * 经实测（2026-08-25）：频道页 https://finance.sina.com.cn/stock/ 返回 200，
 * 首屏约 173 条 dated doc 链接（其中混有 2025 年旧文，须 3 天窗口过滤）；
 * 按「A股相关性」过滤（标题含 A股关键词或 6 位 A股代码，且不含港股/美股标记）保留近 3 天条目。
 *
 * 产物：sourceId=sina-a-stock，category=stocks / subcategory=a-share（与 eastmoney-stock 同组）。
 */
const SINA_A_URL = "https://finance.sina.com.cn/stock/";
const SINA_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SINA_REF = "https://finance.sina.com.cn/stock/";

/** 匹配新浪财经文章链接并捕获标题与路径日期 */
const ARTICLE_RE =
  /<a[^>]*href="(https?:\/\/finance\.sina\.com\.cn\/[^"]*\/(\d{4}-\d{2}-\d{2})\/doc-[a-z0-9]+\.shtml)"[^>]*>([\s\S]*?)<\/a>/g;

/** A股相关性关键词（标题命中其一视为 A股市场新闻） */
const A_KEYWORDS = [
  "A股", "沪指", "深成指", "创业板", "上证", "深证", "两市", "沪深",
  "大盘", "北向", "个股", "涨停", "跌停", "板块", "成交", "沪市",
  "深市", "科创板", "北交所", "半年报", "年报", "分红", "回购", "机构",
];
/** A股代码特征：6 位代码（沪 600/601/688、深 000/002/300 等）；港股为 5 位 (0XXXX) 不误伤 */
const A_CODE_RE = /\(\d{6}\)/;
/** 排除明显的港股/美股市场标记，避免频道混入的境外市场条目污染 A股 交叉源 */
const A_EXCLUDE = /港股|恒指|恒生|美股|纳斯达克|道指|标普|隔夜外盘/;

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validDate(raw: string): string {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export class SinaAStockCrawler extends BaseCrawler {
  /** 只保留最近 N 天（复盘卡要取「抓取日-1」A股收盘数据）。
   *  用 3 天而非 2 天：CI 多在周一/节后首跑，上一 A股交易日是周五（距抓取日 3 个日历日），
   *  2 天窗口会误删正确的周五数据；3 天扛住周末缺口，多余旧文由复盘 LLM 按日期取最新忽略。 */
  windowDays = 3;
  /** 单次最多保留条数 */
  maxItems = 40;

  constructor() {
    super({ name: "新浪财经·A股频道", timeout: 15000, retries: 2 });
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
    const html = await this._getHtml(SINA_A_URL);
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
      // A股相关性：命中 A股关键词或 6 位代码，且不含港股/美股标记
      const isA =
        A_KEYWORDS.some((k) => title.includes(k)) || A_CODE_RE.test(title);
      if (!isA || A_EXCLUDE.test(title)) continue;
      // 窗口过滤：3 天内（周一/节后首跑也能保留上一交易日的周五数据）
      if (new Date(date) < cutoff) continue;
      this.results.push({
        title,
        url,
        excerpt: "",
        publishedAt: date,
        sourceId: "sina-a-stock",
        source: "新浪财经·A股",
        category: "stocks",
        subcategory: "a-share",
        region: "nation",
      });
    }

    // 按日期倒序，限 maxItems
    this.results.sort((a, b) =>
      (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
    );
    if (this.results.length > this.maxItems) this.results.length = this.maxItems;

    console.log(
      `[${this.name}] 完成：匹配 ${matched} 条 dated doc，A股命中 ${this.results.length} 条（窗口 ${this.windowDays} 天）`,
    );
    return this.results;
  }
}

export function createCrawler(): SinaAStockCrawler {
  return new SinaAStockCrawler();
}
