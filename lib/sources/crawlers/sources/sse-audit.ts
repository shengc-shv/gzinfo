import { BaseCrawler, CrawlerResult } from "../base-crawler";
import { windowFloor, shortName, GD_CITIES } from "./ipo-shared";
import { warnIfStale } from "./staleness";

/**
 * 上交所 —— IPO 审核项目动态爬虫（官方权威源，A1）
 *
 * 数据价值：沪主板 + 科创板在审企业全量 + 审核状态 + 更新日期（结构化、权威、高频），
 * 替代东财在审代理（源稀疏根因）。实测（2026-09-09 / 2026-09-10）：
 *   - GET `https://query.sse.com.cn/commonSoaQuery.do?jsonCallBack=cb&sqlId=SH_XM_LB&...`
 *     （JSONP 包裹 `cb(...)`；Referer=`https://www.sse.com.cn/listing/renewal/ipo/`）
 *   - **必须 currStatus 1~9 分批**（直接全量翻页会漂移丢主板；状态 3/6 偶发空需重试）
 *   - ⚠️ **必须显式传 issueMarketType**（2026-09-10 用户实锤「上交所广东龙行天下没看到」）：
 *       不传 → 接口默认只回**科创板**（1048 条全部 issueMarketType=1），沪市主板整体缺失；
 *       `issueMarketType=2` → 沪市主板（235 条）。故 **1（科创板）+ 2（主板）双板都要抓**。
 *   - 响应 `d.pageHelp.data[]`，按 updateDate 倒序（实测 st=2/5 首页最新=当日）
 *   - 关键字段：stockAuditName 全称 / stockIssuer[0].s_province(省)·s_areaNameDesc(市)·
 *     s_issueCompanyAbbrName(简称)·s_csrcCodeDesc(行业) / updateDate(紧凑 YYYYMMDDHHMMSS) /
 *     auditApplyDate(受理) / currStatus(状态码) / issueMarketType(1=科创板) /
 *     intermediary[]（i_intermediaryType==1 保荐机构）
 *
 * 增量策略（用户约束：先取一页看最早时间判定是否继续，同 csrcfd/szse）：
 *   各状态内按 updateDate 倒序 → 窗口内过滤 + 早停（发 1~3 请求即止）。
 *   windowFloor = 今天-(IPO_SOURCE_WINDOW_DAYS-1) 天（=7 天窗，2026-09-10 用户拍板：口播 2 天/列表 7 天）；
 *   周末回退到最近工作日（复用 szse-audit.windowFloor）。
 *
 * 时间红线（2026-08-29 强化）：publishedAt = 官方 updateDate（紧凑格式解析），
 * 无日期条目废弃，绝不抓取日兜底。
 *
 * 阶段（P4 结构化旁路）：按官方 currStatus 直接给出 ipoStage，不靠标题关键词反推。
 * 输出：sourceId=gd-sse-audit / region='gd' / registeredProvince='广东' → 路由 gd-ipo。
 */

const SSE_API = "https://query.sse.com.cn/commonSoaQuery.do";
const SSE_REF = "https://www.sse.com.cn/listing/renewal/ipo/";
const SSE_LIST = "https://www.sse.com.cn/listing/renewal/ipo/";
const PAGE_SIZE = 50;
const MAX_PAGES = 3; // 每状态最多翻 3 页（含早停，通常 1 页即止）

/**
 * 板块枚举（`issueMarketType`）：**必须双板都抓**，否则沪市主板整体缺失。
 * 实测（2026-09-10）：不传该参数时接口只回科创板（1048 条全为 1）；
 * `=2` → 沪市主板 235 条（含「广东龙行天下科技股份有限公司」等）。
 */
export const SSE_MARKETS: Array<{ id: number; label: string }> = [
  { id: 1, label: "科创板" },
  { id: 2, label: "主板" },
];

// currStatus 1~9 → 展示文案 + 阶段（SSE 官方状态字典，对齐《IPO数据源规格说明_每日监测.md》源2 2026-09-09 实测）。
// ⚠️ 2026-09-10 用户拍板阶段口径：**「注册生效」归 stage-registered（注册发行）**（未必已挂牌，
// 真实挂牌日由 listed-check 的 listedDate 给出）；此前判 stage-listed 与关键词表冲突（回检 P0-1）。
export const SSE_STATUS: Record<number, { label: string; stage: string; drop?: boolean }> = {
  1: { label: "IPO已受理", stage: "stage-reviewing" },
  2: { label: "IPO问询中", stage: "stage-reviewing" },
  3: { label: "IPO过会", stage: "stage-registered" }, // 上市委会议通过
  4: { label: "IPO提交注册", stage: "stage-registered" },
  5: { label: "IPO注册生效", stage: "stage-registered" }, // 待发行
  6: { label: "IPO不予注册", stage: "stage-reviewing", drop: true },
  7: { label: "IPO中止", stage: "stage-reviewing", drop: true },
  8: { label: "IPO终止", stage: "stage-reviewing", drop: true },
  9: { label: "IPO已发行", stage: "stage-listed", drop: true }, // 终态=已发行；listed-check 已覆盖真实上市日，日报动态不重复展示
};

export interface SseRow {
  stockAuditName: string;
  stockAuditNum?: string;
  updateDate: string; // 紧凑 YYYYMMDDHHMMSS
  auditApplyDate: string;
  currStatus: string; // "1".."9"
  issueMarketType?: string | number; // 1=科创板
  stockIssuer?: Array<{
    s_province?: string;
    s_areaNameDesc?: string;
    s_issueCompanyAbbrName?: string;
    s_issueCompanyFullName?: string;
    s_csrcCodeDesc?: string;
  }>;
  intermediary?: Array<{ i_intermediaryType?: number; i_intermediaryName?: string }>;
}

/** 剥离 JSONP 包裹 cb(...) → 内层 JSON 字符串。 */
function stripJsonp(text: string): string {
  const s = text.trim();
  const a = s.indexOf("(");
  const b = s.lastIndexOf(")");
  if (a >= 0 && b > a) return s.slice(a + 1, b);
  return s;
}

/** 紧凑日期 YYYYMMDDHHMMSS → YYYY-MM-DD；无日期返回空（时间红线）。 */
export function parseSseDate(v: unknown): string {
  const s = String(v || "").trim();
  const m = s.match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** 解析接口响应 → 行数组（字段缺失容错；无全称废弃）。 */
export function parseSseJson(text: string): SseRow[] {
  const j = stripJsonp(text);
  if (!j) return [];
  let data: { pageHelp?: { data?: unknown[] } };
  try {
    data = JSON.parse(j);
  } catch {
    return [];
  }
  const rows = data?.pageHelp?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      const issuer = (r.stockIssuer as unknown[]) || [];
      return {
        stockAuditName: String(r.stockAuditName || "").trim(),
        stockAuditNum: String(r.stockAuditNum || "").trim(),
        updateDate: String(r.updateDate || "").trim(),
        auditApplyDate: String(r.auditApplyDate || "").trim(),
        currStatus: String(r.currStatus || "").trim(),
        issueMarketType: r.issueMarketType as string | number | undefined,
        stockIssuer: issuer as SseRow["stockIssuer"],
        intermediary: Array.isArray(r.intermediary) ? (r.intermediary as SseRow["intermediary"]) : undefined,
      } as SseRow;
    })
    .filter((x) => x.stockAuditName);
}

/** 广东判定：官方 s_province==广东；或 area=深圳（属广东）；或企业名含广东城市兜底。 */
export function isGdRow(row: SseRow): boolean {
  const iss = row.stockIssuer?.[0] || {};
  const prov = String(iss.s_province || "").replace(/省|市$/, "");
  if (prov === "广东") return true;
  const area = String(iss.s_areaNameDesc || "").replace(/省|市$/, "");
  if (area === "广东" || area === "深圳") return true;
  return GD_CITIES.some((c) => (row.stockAuditName || "").includes(c));
}

export class SseAuditCrawler extends BaseCrawler {
  /** 产出 sourceId（P1-6 注册一致性测试遍历本字段）。 */
  override sourceIds = ["gd-sse-audit"];

  constructor() {
    super({ name: "上交所IPO审核动态", timeout: 20000, retries: 3 });
  }

  /** 单页抓取（JSONP；protected 便于测试 mock）。market = issueMarketType（1 科创板 / 2 主板）。 */
  protected async fetchPage(st: number, page: number, market = 1): Promise<string> {
    const params = new URLSearchParams({
      jsonCallBack: "cb",
      sqlId: "SH_XM_LB",
      isPagination: "true",
      issueMarketType: String(market),
      currStatus: String(st),
      "pageHelp.pageSize": String(PAGE_SIZE),
      "pageHelp.pageNo": String(page),
      "pageHelp.beginPage": String(page),
      "pageHelp.cacheSize": "1",
      "pageHelp.endPage": String(page),
      _: Date.now().toString(),
    });
    const url = `${SSE_API}?${params.toString()}`;
    const headers = {
      "User-Agent": this.userAgent,
      Referer: SSE_REF,
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
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
        console.warn(
          `[${this.name}] ${url} 抓取失败（尝试 ${attempt}/${this.retries + 1}）: ${(err as Error).message}`,
        );
        if (attempt < this.retries + 1) await this._backoff(attempt);
      }
    }
    throw new Error(`fetch SSE market=${market} st=${st} p=${page} failed: ${String(lastErr)}`);
  }

  /** override run()：科创板+主板 双板 × currStatus 1~9 分批 + 窗口内过滤 + 倒序早停。 */
  override async run(): Promise<CrawlerResult[]> {
    const floor = windowFloor();
    console.log(`[${this.name}] 更新窗口下界=${floor}（回退周末后，近 7 天=日差≤7）`);
    const allDates: string[] = []; // 新鲜度哨兵输入（含窗口外日期，只看源是否变旧）

    for (const market of SSE_MARKETS) {
      for (let st = 1; st <= 9; st++) {
        const meta = SSE_STATUS[st];
        if (meta?.drop) continue; // 负面状态不抓，省请求
        let page = 1;
        let emptyRetried = false;
        while (page <= MAX_PAGES) {
          let text = "";
          try {
            text = await this.fetchPage(st, page, market.id);
          } catch (err) {
            console.warn(
              `[${this.name}] ${market.label} st=${st} p${page} 抓取失败，停止该状态: ${(err as Error).message}`,
            );
            break;
          }
          const rows = parseSseJson(text);
          if (rows.length === 0) {
            // 状态 3/6 偶发空 → 重试一次
            if (!emptyRetried) {
              emptyRetried = true;
              continue;
            }
            break;
          }
          emptyRetried = false;

          for (const r of rows) {
            const upd = parseSseDate(r.updateDate);
            if (!upd) continue; // 时间红线：无真实更新日期废弃
            allDates.push(upd);
            if (upd < floor) continue; // 早于窗口下界非窗口内增量
            if (!isGdRow(r)) continue;
            const m = SSE_STATUS[Number(r.currStatus)] || meta;
            if (m.drop) continue;
            this.results.push(this.toResult(r));
          }

          const dates = rows.map((x) => parseSseDate(x.updateDate)).filter(Boolean);
          const pageEarliest = dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : floor;
          if (pageEarliest < floor) {
            console.log(
              `[${this.name}] ${market.label} st=${st} p${page} 最早更新 ${pageEarliest} < ${floor}，早停`,
            );
            break;
          }
          page++;
          await new Promise((r) => setTimeout(r, 800 + Math.random() * 800));
        }
      }
    }

    // 同一企业可能因板块切换/接口重叠重复返回 → 按 url（含 @status 锚点）去重
    const seen = new Set<string>();
    this.results = this.results.filter((r) => {
      const key = r.url || r.title || "";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 新鲜度哨兵（P0-3）：抓成功但数据变旧（接口行为变化/分桶/被反爬）时显式告警
    warnIfStale(this, allDates);

    console.log(`[${this.name}] 完成，共 ${this.results.length} 条（窗口内广东动态，含主板+科创板）`);
    return this.results;
  }

  /** 行 → CrawlerResult（title 含官方状态词 + ipoStage 结构化旁路）。 */
  private toResult(r: SseRow): CrawlerResult {
    const iss = r.stockIssuer?.[0] || {};
    const fullName = iss.s_issueCompanyAbbrName || iss.s_issueCompanyFullName || r.stockAuditName;
    const short = shortName(fullName);
    const st = Number(r.currStatus);
    const meta = SSE_STATUS[st] || { label: "IPO动态", stage: "stage-reviewing" };
    const market = r.issueMarketType === "1" || r.issueMarketType === 1 ? "科创板" : "主板";
    const title = `${short}：${meta.label}（拟${market}）`;

    // 保荐机构（intermediary 中 i_intermediaryType==1）
    let sponsor = "";
    const sp = Array.isArray(r.intermediary)
      ? r.intermediary.find((m) => m.i_intermediaryType === 1)
      : undefined;
    if (sp) sponsor = sp.i_intermediaryName || "";

    const upd = parseSseDate(r.updateDate);
    const apply = parseSseDate(r.auditApplyDate);
    const excerpt = [
      `注册地：${iss.s_province || "广东"}${iss.s_areaNameDesc ? iss.s_areaNameDesc : ""}`,
      sponsor ? `保荐：${sponsor}` : "",
      apply ? `受理：${apply}` : "",
      `状态：${meta.label}`,
      `更新：${upd}`,
      iss.s_csrcCodeDesc ? `行业：${iss.s_csrcCodeDesc}` : "",
    ]
      .filter(Boolean)
      .join("｜");

    return {
      title,
      // P4-③ 状态变更锚点：url 含 @状态，使同一企业不同审核阶段不被 URL 去重吞掉状态升级
      url: `${SSE_LIST}#${r.stockAuditNum || r.stockAuditName}@${r.currStatus}`,
      excerpt,
      publishedAt: upd,
      sourceId: "gd-sse-audit",
      region: "gd",
      registeredProvince: "广东",
      ipoStage: meta.stage,
    };
  }
}

export function createCrawler(): SseAuditCrawler {
  return new SseAuditCrawler();
}
