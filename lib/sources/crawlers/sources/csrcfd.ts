import { BaseCrawler, CrawlerResult } from "../base-crawler";

/**
 * 证监会资本市场电子化信息披露平台 —— 辅导企业（csrcfd）爬虫
 *
 * 数据价值：唯一权威辅导数据源，覆盖「拟上市企业 earliest 信号」（辅导备案/进展报告）。
 * 参考文件《IPO数据源规格说明_每日监测.md》源 1（2026-09-09 实测）：
 *   - 服务端渲染 HTML，分页 `index.html` / `index_2.html` …，每页约 211 条，共 63 页（全量 ~13,300）。
 *   - 列表按**披露时间倒序**，同一企业多行，首次出现 = 最新状态。
 *   - 8 列表格：序号 / 辅导对象 / 辅导机构 / 备案时间 / 辅导状态 / 派出机构 / 报告类型 / 报告标题。
 *   - 报告披露日期需从行内 `downloadPdf1('.../pre_ipo/YYYY/M/D/xxx.pdf')` 路径提取。
 *
 * 增量策略（2026-09-09 用户设计 + 修正）：**倒序早停**——
 *   逐页抓（整页 HTML 为最小粒度，非单条），看页内最早一条的披露日期：
 *     早于「昨天」→ 越过今昨窗口，停止抓取；
 *     等于「昨天」→ 再抓下一页（后面可能还有今/昨披露）；
 *   取到的全国数据再过滤广东（派出机构广东/深圳证监局 + 企业名/备案时间含广东城市）。
 *
 * ⚠️ 与全量 diff 的取舍：本策略只能捕获「今昨新披露」事件，捕获不了「老企业近期状态变更」
 * （如某企 3 天前改聘保荐人，披露日期老会被早停跳过）。如需状态变更，需全量快照 diff（另建）。
 *
 * 红线：本文件非红线 7 文件；接入点 `lib/sources/crawlers/index.ts`（非红线）已注册本爬虫。
 */

const SOURCE_BASE = "http://eid.csrc.gov.cn/csrcfd";
const MAX_PAGES = 10; // 兜底：最多抓 10 页（约 2000 条），防死循环
const CONSECUTIVE_STALE_LIMIT = 2; // 兜底：连续 2 页无有效披露日期即停

// 广东口径（参考文件第五节）：派出机构单列深圳证监局，必须合并统计
const GD_DISPATCH_ORGS = ["广东证监局", "深圳证监局"];
const GD_CITIES = [
  "广州", "深圳", "东莞", "佛山", "珠海", "中山", "惠州", "江门", "汕头",
  "湛江", "肇庆", "梅州", "汕尾", "河源", "阳江", "清远", "潮州", "揭阳", "云浮", "顺德",
];

export interface CoachRow {
  company: string; // 列1 辅导对象
  tutorOrg: string; // 列2 辅导机构
  recordDate: string; // 列3 备案时间
  status: string; // 列4 辅导状态
  dispatchOrg: string; // 列5 派出机构
  reportType: string; // 列6 报告类型
  reportTitle: string; // 列7 报告标题
  pdfPath: string; // downloadPdf1 路径（提取披露日期用）
}

/** 解析单页 8 列表格（服务端渲染，正则即可，无需 JS）。 */
export function parseCoachRows(html: string): CoachRow[] {
  const table = html.match(/<table class="m-table2[^"]*">([\s\S]*?)<\/table>/);
  if (!table) return [];
  const trs = table[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const rows: CoachRow[] = [];
  for (const tr of trs) {
    const tds = tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (tds.length < 8) continue;
    const clean = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const cols = tds.map(clean);
    const pdf = tr.match(/downloadPdf1\('([^']+)'/);
    rows.push({
      company: cols[1] || "",
      tutorOrg: cols[2] || "",
      recordDate: cols[3] || "",
      status: cols[4] || "",
      dispatchOrg: cols[5] || "",
      reportType: cols[6] || "",
      reportTitle: cols[7] || "",
      pdfPath: pdf ? pdf[1] : "",
    });
  }
  return rows;
}

/** 从行内 PDF 路径提取报告披露日期：`/pre_ipo/2026/8/28/xxx.pdf` → `2026-08-28`。 */
export function extractDisclosureDate(row: CoachRow): string | null {
  const m = row.pdfPath.match(/\/pre_ipo\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  if (!m) return null;
  return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
}

/** 广东判定：派出机构 ∈ {广东/深圳证监局}，或 企业名/备案时间 含广东城市。 */
export function isGuangdong(row: CoachRow): boolean {
  if (GD_DISPATCH_ORGS.includes(row.dispatchOrg)) return true;
  const text = `${row.company} ${row.recordDate}`;
  return GD_CITIES.some((c) => text.includes(c));
}

/**
 * 单页早停决策（纯函数，便于测试）：
 *   - 取页内**最后一个有效披露日期**作为该页最早边界（倒序，最后一行最早；容忍末几行无 PDF 路径）。
 *   - 早于 yesterday → 停止；无有效日期 → 记一次 stale（交由连续 stale 计数兜底）；否则继续。
 */
export function decidePage(
  rows: CoachRow[],
  yesterday: string,
): { stop: boolean; staleHit: boolean } {
  const pageEarliest = [...rows].reverse().find((r) => extractDisclosureDate(r) !== null);
  const d = pageEarliest ? extractDisclosureDate(pageEarliest) : null;
  if (d === null) return { stop: false, staleHit: true };
  if (d < yesterday) return { stop: true, staleHit: false };
  return { stop: false, staleHit: false };
}

/** 计算「昨天」（Asia/Shanghai），作为早停窗口下界。 */
function yesterdayStr(): string {
  const parts = new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }).split(", ");
  const [mdy] = parts;
  const [m, d, y] = mdy.split("/").map(Number);
  const dt = new Date(y, m - 1, d - 1);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export class CsrcCoachCrawler extends BaseCrawler {
  constructor() {
    super({ name: "证监会辅导企业(csrcfd)", timeout: 20000, retries: 3 });
  }

  /** 单页抓取（含重试 + 退避，复用基类 userAgent/_backoff）。protected 便于测试 mock。 */
  protected async fetchPage(page: number): Promise<string> {
    const url = page === 1 ? `${SOURCE_BASE}/index.html` : `${SOURCE_BASE}/index_${page}.html`;
    const headers = {
      "User-Agent": this.userAgent,
      Referer: `${SOURCE_BASE}/index.html`,
    };
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      try {
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeout) });
        if (!resp.ok) {
          const retriable = resp.status >= 500 || resp.status === 429 || resp.status === 403;
          console.warn(
            `[${this.name}] ${url} 返回 ${resp.status}（尝试 ${attempt}/${this.retries + 1}）${retriable ? "，将重试" : "，放弃"}`,
          );
          if (retriable && attempt < this.retries + 1) {
            await this._backoff(attempt);
            continue;
          }
          break;
        }
        return await resp.text();
      } catch (err) {
        lastErr = err;
        console.warn(`[${this.name}] ${url} 抓取失败（尝试 ${attempt}/${this.retries + 1}）: ${(err as Error).message}`);
        if (attempt < this.retries + 1) await this._backoff(attempt);
      }
    }
    throw new Error(`fetch csrcfd page ${page} failed: ${String(lastErr)}`);
  }

  /** override 基类 run：倒序早停多页抓取 + 广东过滤，结果写入 this.results。 */
  override async run(): Promise<CrawlerResult[]> {
    const yesterday = yesterdayStr();
    let page = 1;
    let consecutiveStale = 0;

    while (page <= MAX_PAGES) {
      let html = "";
      try {
        html = await this.fetchPage(page);
      } catch (err) {
        console.warn(`[${this.name}] 第 ${page} 页抓取失败，停止翻页: ${(err as Error).message}`);
        break;
      }

      const rows = parseCoachRows(html);
      if (rows.length === 0) break;

      // 先收集当前页广东企业（整页粒度抓取：早于窗口的条目由下游 7 天展示窗口控制，
      // 不在此处硬性丢弃，避免漏掉"页内前段今/昨 + 末段前天"混合页的有效企业）。
      for (const r of rows) {
        if (!isGuangdong(r)) continue;
        // 时间真实性红线：优先披露日期，次选备案时间（源真实字段，非伪造）；皆无则废弃。
        const disclosure = extractDisclosureDate(r) || r.recordDate;
        if (!disclosure) continue;
        this.results.push({
          title: `${r.company}${r.status ? ` (${r.status})` : ""}${r.dispatchOrg ? ` [${r.dispatchOrg}]` : ""}`,
          url: r.pdfPath ? `${SOURCE_BASE}${r.pdfPath}` : "",
          excerpt: [
            "IPO辅导备案",
            r.tutorOrg ? `辅导机构: ${r.tutorOrg}` : "",
            `备案时间: ${r.recordDate}`,
            `状态: ${r.status}`,
            `报告: ${r.reportType}`,
            `披露: ${disclosure}`,
          ].filter(Boolean).join(" | "),
          publishedAt: disclosure,
          sourceId: "em-ipo", // 复用辅导栏路由（constants.ts: em-ipo → ipo-tutoring）
          region: "gd",
          registeredProvince: "广东",
        });
      }

      // 再判是否继续翻页（倒序早停：页内最早一条越过今昨窗口则不再抓下一页；当前页已收）。
      const dec = decidePage(rows, yesterday);
      if (dec.stop) {
        console.log(`[${this.name}] 第 ${page} 页最早披露已越过今昨窗口，早停（不再翻页）`);
        break;
      }
      if (dec.staleHit) {
        if (++consecutiveStale >= CONSECUTIVE_STALE_LIMIT) {
          console.log(`[${this.name}] 连续 ${CONSECUTIVE_STALE_LIMIT} 页无有效披露日期，兜底停止`);
          break;
        }
      } else {
        consecutiveStale = 0;
      }
      page++;
    }

    console.log(`[${this.name}] 完成，抓取 ${page - 1} 页，广东企业 ${this.results.length} 条`);
    return this.results;
  }
}

export function createCrawler(): CsrcCoachCrawler {
  return new CsrcCoachCrawler();
}
