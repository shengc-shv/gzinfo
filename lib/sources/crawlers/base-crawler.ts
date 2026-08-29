/**
 * 通用爬虫基类 - 专门为 gzcmbdf3 格式设计
 * 每个子类只需实现 getUrls() 和 parseArticle() 两个方法。
 *
 * M3-A 移植说明：原 scripts/crawlers/base-crawler.mjs 的逐字移植。
 * - 原 `import { fetch, Headers } from "undici"` 改为 Node 全局 `fetch`
 *   （Node 18+ 内置，底层同样是 undici 引擎，API 一致；并消除未声明依赖 undici）。
 * - 子类 fetch/解析逻辑保持不变。
 */

export interface CrawlUrl {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  sub?: string;
}

/** 爬虫单条结果（CrawledArticle 的超集：广州商机源会带 subcategory）。 */
export type CrawlerResult = {
  sourceId?: string;
  source?: string;
  title?: string;
  url?: string;
  excerpt?: string;
  publishedAt?: string;
  region?: string;
  category?: string;
  summary?: string;
  subcategory?: string;
};

export interface CrawlerOptions {
  name?: string;
  keywords?: string[];
  timeout?: number;
  retries?: number;
}

export class BaseCrawler {
  name: string;
  keywords: string[];
  timeout: number;
  retries: number;
  userAgent: string;
  results: CrawlerResult[];

  constructor(options: CrawlerOptions = {}) {
    this.name = options.name || "unknown";
    this.keywords = options.keywords || ["广州", "上市", "IPO", "辅导备案"];
    this.timeout = options.timeout || 15000;
    // 抓取失败后的重试次数（不含首次）。默认 0；易被反爬/WAF 掐断的源可设高，如 3。
    this.retries = options.retries ?? 0;
    this.userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    this.results = [];
  }

  /**
   * 子类必须实现：返回要抓取的 URL 列表
   */
  async getUrls(): Promise<Array<string | CrawlUrl>> {
    throw new Error("子类必须实现 getUrls() 方法");
  }

  /**
   * 子类必须实现：从 HTML 中解析出文章列表
   * 返回: [{ title, url, excerpt, publishedAt? }]
   */
  async parseArticle(_html: string, _url: string): Promise<CrawlerResult[]> {
    throw new Error("子类必须实现 parseArticle() 方法");
  }

  /**
   * 指数退避（仅用于重试之间）
   */
  _backoff(attempt: number): Promise<void> {
    const ms = 1000 * attempt * attempt + Math.random() * 1000; // 第1次重试~2s, 第2次~5s ...
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * 把底层错误原因（fetch 的 err.cause）转成可读字符串，否则只会看到 "fetch failed" 黑盒
   */
  _causeText(err: unknown): string {
    const e = err as { cause?: { code?: string; name?: string; message?: string } };
    const c = e?.cause;
    if (!c) return "";
    const code = c.code || c.name || "";
    const msg = c.message || String(c);
    return ` | cause=${code ? code + ": " : ""}${msg}`;
  }

  /**
   * 通用抓取方法 - 子类一般不需要重写（含失败重试）
   */
  async run(): Promise<CrawlerResult[]> {
    console.log(`[${this.name}] 开始抓取... retries=${this.retries}`);
    const items = await this.getUrls();
    let total = 0;
    const maxAttempts = this.retries + 1;

    for (const item of items) {
      const targetUrl = typeof item === "string" ? item : item.url;
      const method = typeof item === "string" ? "GET" : (item.method || "GET");
      const headers = typeof item === "string"
        ? { "User-Agent": this.userAgent }
        : (item.headers || { "User-Agent": this.userAgent });
      const body = typeof item === "string" ? undefined : (item.body || undefined);

      let articles: CrawlerResult[] = [];
      let ok = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const fetchOptions: RequestInit = {
            method,
            headers,
            signal: AbortSignal.timeout(this.timeout),
          };
          if (method === "POST" && body) {
            fetchOptions.body = body;
          }

          const resp = await fetch(targetUrl, fetchOptions);
          if (!resp.ok) {
            // 仅对可重试状态（5xx / 429 限流 / 403 反爬）重试；4xx 其他直接放弃
            const retriable =
              resp.status >= 500 || resp.status === 429 || resp.status === 403;
            console.warn(
              `[${this.name}] ${targetUrl} 返回 ${resp.status}（尝试 ${attempt}/${maxAttempts}）${retriable ? "，将重试" : "，放弃"}`,
            );
            if (retriable && attempt < maxAttempts) {
              await this._backoff(attempt);
              continue;
            }
            break;
          }

          const text = await resp.text();
          articles = await this.parseArticle(text, targetUrl);
          ok = true;
          break;
        } catch (err) {
          const e = err as Error;
          console.warn(
            `[${this.name}] ${targetUrl} 抓取失败（尝试 ${attempt}/${maxAttempts}）: ${e.message}${this._causeText(err)}`,
          );
          if (attempt < maxAttempts) {
            await this._backoff(attempt);
            continue;
          }
        }
      }

      // 直接使用全部数据，不过滤，由子类在 parseArticle 中自行决定
      this.results.push(...articles);
      total += articles.length;
      console.log(
        `[${this.name}] 从 ${targetUrl} 抓取 ${articles.length} 条${ok ? "" : "（最终失败）"}`,
      );

      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
    }

    console.log(`[${this.name}] 完成，共 ${this.results.length} 条`);
    return this.results;
  }

  /**
   * 转换格式供 gzcmbdf3 使用（IPO 源走此路径）
   */
  toGzcmbdf3Format() {
    return this.results.map((item) => ({
      title: item.title || "无标题",
      url: item.url || "",
      excerpt: item.excerpt || "",
      // 时间真实性红线（2026-08-25 用户要求，2026-08-29 强化）：不允许用抓取时间
      // 兜底 publishedAt —— 没有明确发布时间的条目由上游 ingest 丢弃，绝不伪造时间。
      publishedAt: item.publishedAt,
      source: this.name,
      // 子类可给每条结果带上 sourceId，daily.ts 据此路由到对应二级标签
      ...(item.sourceId ? { sourceId: item.sourceId } : {}),
      // region: 'gd' 广东（进「广东地区IPO」）/ 'nation' 全国（进「全国IPO/新股」）
      ...(item.region ? { region: item.region } : {}),
    }));
  }
}
