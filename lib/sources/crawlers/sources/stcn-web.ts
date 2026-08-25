import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 证券时报（Securities Times / stcn.com）财经新闻爬虫
 *
 * 为什么不用 type:scrape 直接抓首页：www.stcn.com 首页是 180KB 服务端渲染导航壳，
 * 真实文章在各栏目静态列表页（/article/list/<栏>.html）；列表页与无限滚动分页接口
 * （$.getJSON /article/list.html?type=xw&page_time=&last_time=）返回的均为 HTML 片段，
 * **均不含发布日期字段**（文章 ID 为纯数字，无时间戳），故 publishedAt 用抓取当天近似
 * （栏目为首屏最新滚动，误差为当天±1天，可接受；判重靠 /article/detail/<id>.html 唯一 URL）。
 *
 * 经实测（2026-08-20）选定三栏（每栏首屏约 10 条）：
 *   新闻        /article/list/xw.html            —— 综合财经新闻（宏观/市场/产业）
 *   地方·广东   /article/list/area.html?subType=粤 —— 广东本地财经（广州产业链/东莞/惠州等，直接服务广州商机）
 *   投资        /article/list/investment.html     —— 投资/资本市场资讯
 * 列表项结构：<div class="tt"><a href="/article/detail/<id>.html">标题</a></div>
 *
 * 未纳入（v1 排除）：快讯 /article/list/kx.html（滚动短讯、量大噪声高）、
 * 专题 /article/list/zt.html 等 —— 如需覆盖可后续扩展（含无限滚动分页 JSON）。
 *
 * 产物：sourceId=stcn，category=finance（经 SOURCE_ROUTE），subcategory=cn-finance（国内财经新闻标签）。
 */
const STCN_BASE = "https://www.stcn.com";
const STCN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const STCN_REF = "https://www.stcn.com/";

interface StcnColumn {
  name: string;
  listUrl: string;
}

/** 目标栏目（均为静态列表页；area 用 URL 编码的 subType=粤 过滤广东内容） */
const STCN_COLUMNS: StcnColumn[] = [
  { name: "新闻", listUrl: `${STCN_BASE}/article/list/xw.html` },
  {
    name: "地方·广东",
    listUrl: `${STCN_BASE}/article/list/area.html?subType=%E7%B2%A4`,
  },
  { name: "投资", listUrl: `${STCN_BASE}/article/list/investment.html` },
];

/** 匹配列表项：<div class="tt"><a href="/article/detail/<id>.html" ...>标题</a></div> */
const DETAIL_RE =
  /<div class="tt">\s*<a href="(\/article\/detail\/\d+\.html)"[^>]*>([\s\S]*?)<\/a>/g;

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

export class StcnCrawler extends BaseCrawler {
  constructor() {
    super({ name: "证券时报", timeout: 15000, retries: 2 });
  }

  /** GET 返回 HTML 文本（带重试 + 超时 + 中文 UA/Referer，绕过阿里云 WAF） */
  private async _getHtml(url: string): Promise<string | null> {
    const maxAttempts = this.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": STCN_UA,
            Referer: STCN_REF,
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

  /** 从列表页 HTML 解析文章链接 + 标题 */
  private _parseList(html: string): ParsedItem[] {
    const out: ParsedItem[] = [];
    DETAIL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DETAIL_RE.exec(html))) {
      const url = STCN_BASE + m[1];
      const title = stripTags(m[2]);
      if (!title) continue;
      out.push({ title, url });
    }
    return out;
  }

  async run(): Promise<CrawlerResult[]> {
    console.log(`[${this.name}] 开始抓取 (静态列表页)`);
    const seen = new Set<string>();

    for (const col of STCN_COLUMNS) {
      const html = await this._getHtml(col.listUrl);
      if (!html) continue;
      const items = this._parseList(html);
      let colCount = 0;
      for (const it of items) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        this.results.push({
          title: it.title,
          url: it.url,
          excerpt: "",
          publishedAt: "", // 占位：稍后进详情页提取真实时间
          sourceId: "stcn",
          source: "证券时报",
        });
        colCount++;
      }
      console.log(
        `[${this.name}] ${col.name} 解析 ${colCount} 条（累计 ${this.results.length}）`,
      );
    }

    // 时间真实性红线（2026-08-25 用户要求）：列表页无日期 → 并发进详情页提取
    // 真实发布时间（正文"来源：XXX 作者：XXX YYYY-MM-DD HH:MM"）；
    // 提取不到真实时间 → 该条废弃（不产出，避免旧闻被兜底成"今天新鲜"）。
    const pending = this.results.filter((it) => it.url && !it.publishedAt);
    if (pending.length) {
      console.log(`[${this.name}] 详情页补日期: ${pending.length} 条（并发5）…`);
      const CONCURRENCY = 5;
      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length) {
          const it = pending[cursor++];
          try {
            const detail = await this._getHtml(it.url!);
            if (!detail) continue;
            const pub = extractDetailPubtime(detail);
            if (pub) it.publishedAt = pub;
          } catch {
            // 单条失败静默（无时间 → 后续废弃）
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()),
      );
      const got = pending.filter((it) => it.publishedAt).length;
      const dropped = pending.length - got;
      console.log(`[${this.name}] 详情页补日期完成: ${got}/${pending.length} 条（无真实时间废弃 ${dropped} 条）`);
      if (dropped > 0) {
        const kept = this.results.filter((it) => it.publishedAt);
        this.results.length = 0;
        this.results.push(...kept);
      }
    }

    console.log(`[${this.name}] 完成，共 ${this.results.length} 条（去重后）`);
    return this.results;
  }
}

/** 从详情页提取真实发布时间：正文"YYYY-MM-DD HH:MM" 或 <meta name="publishdate"/PubDate> */
export function extractDetailPubtime(html: string): string | undefined {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  // 正文时间："2026-08-25 07:26" / "2026-08-25 07:26:00"
  const m = body.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?\s*(\d{1,2}:\d{2}(?::\d{2})?)?/);
  if (m) {
    const d = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    return m[4] ? `${d} ${m[4]}` : d;
  }
  const meta =
    html.match(/<meta[^>]+name=["'](?:publishdate|PubDate|pubdate|weibo:article:create_at)["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["'](?:publishdate|PubDate|pubdate|weibo:article:create_at)["']/i);
  if (meta) {
    const mm = meta[1].match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
    if (mm) return `${mm[1]}-${mm[2].padStart(2, "0")}-${mm[3].padStart(2, "0")}`;
  }
  return undefined;
}

export function createCrawler(): StcnCrawler {
  return new StcnCrawler();
}
