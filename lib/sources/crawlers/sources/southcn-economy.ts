import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 南方网·南方经济（economy.southcn.com）爬虫
 *
 * 背景（2026-08-21 用户第一梯队：广州本地媒体解决"热点发现"）：
 * 南方日报 8-17 有广州深度稿（深度报道第一梯队），但此前未接入。
 * 实测「广州频道」dishi.southcn.com/node_0da5263540 内容偏政务科普/微信外链，
 * 价值低；改用「南方经济」economy.southcn.com（含 Token贷/金饰克价/广州写字楼
 * 等高质量产经内容），符合用户"抓广州/产经频道页"的意图。
 *
 * 经实测（2026-08-21）：
 *   经济频道 https://economy.southcn.com/ 服务端渲染 45KB，正文列表为
 *     <li><a href="https://news.southcn.com/node_<栏目>/<hash>.shtml">标题</a></li>
 *   URL 无日期（hash 形式）→ 详情页有 <span id="pubtime_baidu">2026-08-21 16:23</span>
 *   v1 策略：列表页标题全取，publishedAt 用抓取当天近似（同 stcn 模式，列表为最新
 *   滚动误差 ±1 天）；如需精确时间后续可进详情页提取。
 *
 * 产物：sourceId=southcn，category=gz（经 SOURCE_ROUTE），subcategory=gz-media（广州本地媒体）。
 */
const SOUTHCN_URL = "https://economy.southcn.com/";
const SOUTHCN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SOUTHCN_REF = "https://economy.southcn.com/";

/**
 * 匹配文章链接并捕获标题：
 *   <li><a href="https://news.southcn.com/node_<栏目>/<hash>.shtml" ...>标题</a></li>
 *   <li><a href="https://economy.southcn.com/node_<栏目>/<hash>.shtml" ...>标题</a></li>
 * 经济频道文章分布在 news.southcn.com 与 economy.southcn.com 两个子域；
 * 仅匹配 node_ 文章页（排除 /node_<栏目> 裸栏目导航），标题在 <a> 内直接文本。
 */
const ARTICLE_RE =
  /<a[^>]*href="(https:\/\/(?:news|economy)\.southcn\.com\/node_[^/]+\/[a-f0-9]+\.shtml)"[^>]*>([\s\S]*?)<\/a>/g;

/** 去 HTML 标签 + 折叠空白 */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 北京时区当天日期 YYYY-MM-DD（列表为最新滚动，用抓取日近似发布日期） */
function todayBeijing(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

interface ParsedItem {
  title: string;
  url: string;
}

export class SouthcnEconomyCrawler extends BaseCrawler {
  constructor() {
    super({ name: "南方网·经济", timeout: 15000, retries: 2 });
  }

  /** GET 返回 HTML 文本（带重试 + 超时 + 中文 UA/Referer） */
  private async _getHtml(url: string): Promise<string | null> {
    const maxAttempts = this.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": SOUTHCN_UA,
            Referer: SOUTHCN_REF,
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

  /** 从频道页 HTML 解析文章链接 + 标题 */
  private _parseList(html: string): ParsedItem[] {
    return parseSouthcnEconomyHtml(html);
  }

  async run(): Promise<CrawlerResult[]> {
    console.log(`[${this.name}] 开始抓取 (南方经济)`);
    const html = await this._getHtml(SOUTHCN_URL);
    if (!html) return this.results;
    const seen = new Set<string>();
    const items: ParsedItem[] = [];
    for (const it of this._parseList(html)) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      items.push(it);
    }
    // 时间真实性红线（2026-08-25 用户要求）：列表页无日期 → 必须进详情页提取
    // 真实发布时间（<span id="pubtime_baidu">YYYY-MM-DD HH:MM</span>）；
    // 提取不到真实时间 → 该条废弃（不产出，避免旧闻被兜底成"今天新鲜"混入报告）。
    const CONCURRENCY = 5;
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const it = items[cursor++];
        try {
          const detail = await this._getHtml(it.url);
          if (!detail) continue;
          const pub = extractDetailPubtime(detail);
          if (!pub) continue; // 无真实时间 → 废弃
          this.results.push({
            title: it.title,
            url: it.url,
            excerpt: "",
            publishedAt: pub,
            sourceId: "southcn",
            source: "南方网·经济",
          });
        } catch {
          continue; // 单条失败 → 废弃
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()),
    );
    console.log(`[${this.name}] 完成，共 ${this.results.length} 条（详情页无真实时间已废弃 ${items.length - this.results.length} 条）`);
    return this.results;
  }
}

/** 从详情页提取真实发布时间：<span id="pubtime_baidu">2026-08-21 16:23</span> 或 <meta name="PubDate"> */
export function extractDetailPubtime(html: string): string | undefined {
  const span = html.match(/<span[^>]*id=["']pubtime_baidu["'][^>]*>([^<]{10,25})<\/span>/i);
  if (span) {
    const m = span[1].match(/(20\d{2})[-\/年](\d{1,2})[-\/月](\d{1,2})日?\s*(\d{1,2}:\d{2})?/);
    if (m) {
      const d = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
      return m[4] ? `${d} ${m[4]}` : d;
    }
  }
  const meta =
    html.match(/<meta[^>]+name=["']PubDate["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']PubDate["']/i);
  if (meta) {
    const m = meta[1].match(/(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  return undefined;
}

export function createCrawler(): SouthcnEconomyCrawler {
  return new SouthcnEconomyCrawler();
}

/** 纯解析：从南方经济频道 HTML 提取文章（导出供单测，与 run() 共用）。 */
export function parseSouthcnEconomyHtml(html: string): ParsedItem[] {
  const out: ParsedItem[] = [];
  ARTICLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARTICLE_RE.exec(html))) {
    const url = m[1];
    const title = stripTags(m[2]);
    if (!title || title.length < 8) continue;
    out.push({ title, url });
  }
  return out;
}
