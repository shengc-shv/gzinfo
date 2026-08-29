import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 新华财经（Xinhua Finance / cnfin.com）财经新闻爬虫
 *
 * 为什么不用 type:scrape 直接抓首页：www.cnfin.com 首页是 196KB 服务端渲染导航壳，
 * 真实文章分散在各栏目静态列表页；本站虽有 AJAX 接口（roll/query/getNewsList.htm），
 * 但静态首屏 HTML 已含完整文章列表，解析更稳健，故走 HTML 列表解析（与 PBC 同模式）。
 *
 * 经实测（2026-08-20）选定结构干净、对零售决策最有价值的四个栏目（每栏首屏约 16-20 条）：
 *   要闻  /news/index.html     —— 综合财经要闻（核心）
 *   宏观  /macro/index.html    —— 宏观经济政策/数据
 *   区域  /local/index.html    —— 地方经济（含广东/广州动态）
 *   产业  /industry/index.html —— 产业动态
 * 文章链接规律：//www.cnfin.com/<前缀>-lb/detail/<YYYYMMDD>/<数字>_1.html，
 * 日期由路径前 8 位推导（YYYYMMDD → YYYY-MM-DD）；标题在 <a href=...>标题</a> 中。
 *
 * 未纳入（v1 排除，偏实时行情、对零售商机价值低且量大）：
 *   股市 /stock、债市 /bond、汇市 /forex、货币 /currency、大宗 /commodity、快讯 /flash
 *   —— 如需覆盖，后续可单独扩展（快讯为短讯、噪声偏高）。
 *
 * 产物：sourceId=cnfin，category=finance（经 SOURCE_ROUTE），subcategory=cn-finance（国内财经新闻标签）。
 */
const CNFIN_BASE = "https://www.cnfin.com";
const CNFIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const CNFIN_REF = "https://www.cnfin.com/";

interface CnfinColumn {
  name: string;
  path: string;
}

/** 目标栏目（均为 static 列表页，首屏即最新文章） */
const CNFIN_COLUMNS: CnfinColumn[] = [
  { name: "要闻", path: "news" },
  { name: "宏观", path: "macro" },
  { name: "区域", path: "local" },
  { name: "产业", path: "industry" },
];

/**
 * 匹配文章链接并捕获标题：
 *   //www.cnfin.com/<前缀>-lb/detail/<YYYYMMDD>/<id>_1.html" ...>标题</a>
 * 标题允许跨换行（[\s\S]*?），并容忍 <a> 内嵌套标签（stripTags 清理）。
 */
const DETAIL_RE =
  /href="\/\/www\.cnfin\.com\/([a-z]+)-lb\/detail\/(\d{8})\/(\d+)_1\.html"[^>]*>([\s\S]*?)<\/a>/g;

/** 去 HTML 标签 + 折叠空白 */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 把 YYYYMMDD 归一成 YYYY-MM-DD（非法返回 ""） */
function normalizeDate(raw: string): string {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return "";
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

interface ParsedItem {
  title: string;
  url: string;
  date: string;
}

export class CnfinCrawler extends BaseCrawler {
  constructor() {
    super({ name: "新华财经", timeout: 15000, retries: 2 });
  }

  /** GET 返回 HTML 文本（带重试 + 超时 + 中文 UA/Referer，绕过反爬） */
  private async _getHtml(url: string): Promise<string | null> {
    const maxAttempts = this.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": CNFIN_UA,
            Referer: CNFIN_REF,
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

  /** 从列表页 HTML 解析本站文章链接 + 标题 + 日期（按 URL 去重在 run 层做） */
  private _parseList(html: string): ParsedItem[] {
    const out: ParsedItem[] = [];
    DETAIL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DETAIL_RE.exec(html))) {
      const prefix = m[1];
      const date8 = m[2];
      const id = m[3];
      const title = stripTags(m[4]);
      if (!title) continue;
      const url = `${CNFIN_BASE}/${prefix}-lb/detail/${date8}/${id}_1.html`;
      // 时间真实性红线（2026-08-25 用户要求，2026-08-29 强化）：URL 路径日期
      // 解析失败（非法日期）→ 该条废弃，不产出，绝不回退用抓取日（new Date()）兜底。
      const date = normalizeDate(date8);
      if (!date) continue;
      out.push({ title, url, date });
    }
    return out;
  }

  async run(): Promise<CrawlerResult[]> {
    console.log(`[${this.name}] 开始抓取 (静态列表页)`);
    const seen = new Set<string>();

    for (const col of CNFIN_COLUMNS) {
      const html = await this._getHtml(`${CNFIN_BASE}/${col.path}/index.html`);
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
          publishedAt: it.date,
          sourceId: "cnfin",
          source: "新华财经",
        });
        colCount++;
      }
      console.log(
        `[${this.name}] ${col.name} 解析 ${colCount} 条（累计 ${this.results.length}）`,
      );
    }

    console.log(`[${this.name}] 完成，共 ${this.results.length} 条（去重后）`);
    return this.results;
  }
}

export function createCrawler(): CnfinCrawler {
  return new CnfinCrawler();
}
