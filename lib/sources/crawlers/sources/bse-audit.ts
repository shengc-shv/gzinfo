import { BaseCrawler, CrawlerResult } from "../base-crawler";
import { windowFloor, shortName, GD_CITIES } from "./ipo-shared";
import { localDay, dayGap, STALE_LAG_DAYS } from "./staleness";

/** 哨兵时区工具改由共享模块提供（2026-09-10 P0-3），此处再导出保持既有导入路径可用。 */
export { localDay, dayGap, STALE_LAG_DAYS } from "./staleness";

/**
 * 北交所 —— IPO 审核项目动态爬虫（官方权威源，A3）
 *
 * 数据价值：北交所（含新三板转板）在审企业全量 + 审核状态 + 更新日期（结构化、权威、高频），
 * 替代东财在审代理（源稀疏根因）。实测（2026-09-09 / 2026-09-10）：
 *   - 先访 `https://www.bse.cn/audit/project_news_select.html` 预热 cookie（C3VK），
 *     再 GET `https://www.bse.cn/projectNewsController/infoSelectResult.do?callback=cb1&page=1&pageSize=1&type=1&text=&sortfield=updateDate&sorttype=desc`
 *     （JSONP 包裹 `cb1(...)`；Respond `d[0].listInfo.content[]`；**pageSize=1 必传**，见下方常量区）
 *   - 按 updateDate 倒序（实测确认）
 *   - 关键字段：companyName/stockName 全称·简称 / stockCode / registerAddress("广东省 东莞市") /
 *     status(P01~P10) / updateDate({time:毫秒}) / receiveDate({time}) / sponsorOrg(保荐机构)
 *
 * 增量策略：窗口内过滤 + 倒序早停（同 csrcfd/szse/sse），逐页翻页上限 MAX_PAGES。
 * windowFloor = 今天-N 天（"日差 ≤ N" 口径，与 szse/sse/csrcfd 统一；N=IPO_SOURCE_WINDOW_DAYS=7）；
 * 周末回退到最近工作日（复用 szse-audit.windowFloor）。
 * 注：7 天窗为**展示**口径；`pageSize=1` ⇒ **1 页 = 1 条**，单次最多翻 MAX_PAGES 页，
 * 实际页数由「窗口内条目数」经早停决定，历史靠 article-history 逐日累积。
 *
 * 时间红线：publishedAt = 官方 updateDate（{time} 毫秒戳解析），无日期废弃。
 * 阶段（P4 结构化旁路）：按官方 P 状态代码直接给出 ipoStage。
 */

const BSE_HTML = "https://www.bse.cn/audit/project_news_select.html";
const BSE_API = "https://www.bse.cn/projectNewsController/infoSelectResult.do";
const BSE_LIST = "https://www.bse.cn/audit/project_news_select.html";

/**
 * ⚠️ 必须显式传 pageSize=1 —— 这是本源的"数据新鲜度开关"（2026-09-10 实锤）。
 *
 * 北交所该接口按 `(page, pageSize)` 做**服务端分桶缓存**，不同 pageSize 命中不同新鲜度的桶。
 * 同一时刻（2026-09-10 17:xx）`page=1` 实测：
 *   | pageSize | 最新 updateDate | 滞后 |
 *   | 不传(默认20) | 2026-08-28 | 13 天 |
 *   | 20 / 21 / 25 / 30 / 100 | 2026-08-28 | 13 天（>20 被服务端钳制回 20）|
 *   | 15 | 2026-09-01 | 9 天 |
 *   | 10 / 8 | 2026-09-03 | 7 天 |
 *   | 4 | 2026-09-08 | 2 天 |
 *   | 3 / 2 | 2026-09-09 | 1 天 |
 *   | **1** | **2026-09-10** | **0 天（实时）** |
 * 实测无效的绕缓存手段：`_=时间戳`、`&rand=`、`Cache-Control: no-cache`、`Pragma`、`If-None-Match`、
 * POST 提交、镜像域 `www.bseinfo.net`（同一后端）—— 均返回同一陈旧桶，证明确为应用层分桶而非 CDN 缓存。
 *
 * 结论：固定 `pageSize=1`（唯一实时桶），靠逐页翻页补齐窗口内条目。
 * 该分桶行为属官方未文档化实现，随时可能变化 → `run()` 末尾带**新鲜度哨兵**，静默变旧会告警。
 */
const PAGE_SIZE = 1;

/**
 * 翻页上限 —— 作用同「安全阀」，不是「节流阀」。
 *
 * ⚠️ 因 `PAGE_SIZE=1`，**每页只有 1 条 → 页数 == 条数**（4 页 = 最新 4 条，**不是 4×20=80 条**）。
 * 2026-09-10 实测：7 天窗内共 11 条，前 4 条全为外省，**唯一广东条目（东莞四维材料，P02 问询中）
 * 排在第 8 页** → 4 页时被截断，当日已交付报告里「四维」「东莞」均出现 0 次。
 * 用户据此拍板 4 → **20**。
 *
 * `run()` 本身已有早停（`pageEarliest < floor` → break），实际请求数由窗口内条目数决定
 * （当日 12 次、约 20 秒），与 MAX_PAGES 取值基本无关；此处仅防官方分桶行为异常时翻页失控。
 *
 * 导出便于测试**锁住下限**：本值若被调回小数字，接口不会报错，只会在窗口内条目较多时静默漏广东。
 */
export const MAX_PAGES = 20;

// 状态码字典对齐《IPO数据源规格说明_每日监测.md》源4（2026-09-09 实测）。
// 注：规格实测字典中 P04 无对应项（北交所审核流程跳过该码），顺序为 P05=暂缓审议 / P06=提交注册 / P07=注册（生效）。
// ⚠️ 2026-09-10 用户拍板阶段口径：**「注册生效」归 stage-registered（注册发行）**，
// 不归 stage-listed —— 注册生效只是「核准发行」，未必已挂牌（真实挂牌日由 listed-check
// 的 listedDate 给出）。此前 SSE/BSE 判 stage-listed 而关键词表判 registered，导致同一张卡
// 的分栏与徽章互相矛盾（回检 P0-1），现全链路统一为 registered。
export const BSE_STATUS: Record<string, { label: string; stage: string; drop?: boolean }> = {
  P01: { label: "IPO已受理", stage: "stage-reviewing" },
  P02: { label: "IPO问询中", stage: "stage-reviewing" },
  P03: { label: "IPO过会", stage: "stage-registered" }, // 上市委会议通过
  P05: { label: "IPO暂缓审议", stage: "stage-reviewing" }, // 上市委会议后可能暂缓，仍在进行，不丢弃
  P06: { label: "IPO提交注册", stage: "stage-registered" },
  P07: { label: "IPO注册生效", stage: "stage-registered" }, // 注册（生效）→ 待发行
  P08: { label: "IPO不予注册", stage: "stage-reviewing", drop: true },
  P09: { label: "IPO中止", stage: "stage-reviewing", drop: true },
  P10: { label: "IPO终止", stage: "stage-reviewing", drop: true },
};

export interface BseRow {
  companyName: string;
  stockName?: string;
  stockCode?: string;
  id?: string;
  registerAddress: string;
  status: string; // P01~P10
  updateDate?: { time?: number } | string | number;
  receiveDate?: { time?: number } | string | number;
  sponsorOrg?: string;
}

/**
 * 构造接口 URL。
 * 导出便于测试**锁住 `pageSize=1`**：它是本源唯一能命中实时桶的参数（见常量区实测表），
 * 一旦被误删/改动，接口不会报错、只会静默返回陈旧数据（滞后最长 13 天），属高危回归。
 */
export function bseApiUrl(page: number): string {
  const params = new URLSearchParams({
    callback: "cb1",
    page: String(page),
    pageSize: String(PAGE_SIZE), // ⚠️ 必传，决定命中哪个新鲜度分桶
    type: "1",
    text: "",
    sortfield: "updateDate",
    sorttype: "desc",
  });
  return `${BSE_API}?${params.toString()}`;
}

/** 剥离 JSONP 包裹 cb1(...) → 内层 JSON 字符串。 */
function stripJsonp(text: string): string {
  const s = text.trim();
  const a = s.indexOf("(");
  const b = s.lastIndexOf(")");
  if (a >= 0 && b > a) return s.slice(a + 1, b);
  return s;
}

/** BSE 日期：{time:毫秒} / 数字毫秒 / 字符串 YYYYMMDD → YYYY-MM-DD；无日期返回空。 */
export function parseBseDate(v: unknown): string {
  if (!v) return "";
  if (typeof v === "object" && "time" in (v as Record<string, unknown>)) {
    const t = (v as { time?: number }).time;
    if (typeof t === "number") return new Date(t).toISOString().slice(0, 10);
  }
  if (typeof v === "number") return new Date(v).toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** 最近端时刻的本地日期串 / 日差由共享模块提供（见顶部 re-export）。 */

/** 解析接口响应 → 行数组（字段缺失容错；无公司名废弃）。 */
export function parseBseJson(text: string): BseRow[] {
  const j = stripJsonp(text);
  if (!j) return [];
  let data: { 0?: { listInfo?: { content?: unknown[] } } } | unknown[];
  try {
    data = JSON.parse(j);
  } catch {
    return [];
  }
  const arr = Array.isArray(data) ? data : [];
  const content = (arr[0] as { listInfo?: { content?: unknown[] } } | undefined)?.listInfo?.content;
  if (!Array.isArray(content)) return [];
  return content
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        companyName: String(r.companyName || "").trim(),
        stockName: r.stockName ? String(r.stockName).trim() : undefined,
        stockCode: r.stockCode ? String(r.stockCode).trim() : undefined,
        id: r.id ? String(r.id).trim() : undefined,
        registerAddress: String(r.registerAddress || "").trim(),
        status: String(r.status || "").trim(),
        updateDate: r.updateDate as BseRow["updateDate"],
        receiveDate: r.receiveDate as BseRow["receiveDate"],
        sponsorOrg: r.sponsorOrg ? String(r.sponsorOrg).trim() : undefined,
      } as BseRow;
    })
    .filter((x) => x.companyName);
}

/** 广东判定：registerAddress 前缀"广东省"（实测"广东省 东莞市"）。 */
export function isGdRow(row: BseRow): boolean {
  if ((row.registerAddress || "").startsWith("广东省")) return true;
  return GD_CITIES.some((c) => (row.companyName || "").includes(c));
}

export class BseAuditCrawler extends BaseCrawler {
  /** 产出 sourceId（P1-6 注册一致性测试遍历本字段）。 */
  override sourceIds = ["gd-bse-audit"];

  constructor() {
    super({ name: "北交所IPO审核动态", timeout: 20000, retries: 3 });
  }

  /** cookie 预热（C3VK）；失败不致命。protected 便于测试 mock 跳过网络。 */
  protected async warmCookie(): Promise<void> {
    try {
      await fetch(BSE_HTML, {
        headers: { "User-Agent": this.userAgent, Referer: "https://www.bse.cn/", Accept: "text/html" },
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch {
      /* 预热失败不影响后续请求（实测不依赖） */
    }
  }

  /** 单页抓取（JSONP；protected 便于测试 mock）。 */
  protected async fetchPage(page: number): Promise<string> {
    const url = bseApiUrl(page);
    const headers = {
      "User-Agent": this.userAgent,
      Referer: BSE_HTML,
      Accept: "*/*",
      "X-Requested-With": "XMLHttpRequest",
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
    throw new Error(`fetch BSE p=${page} failed: ${String(lastErr)}`);
  }

  /** override run()：cookie 预热 → 窗口内过滤 + 倒序早停 + 去重 + 新鲜度哨兵。 */
  override async run(): Promise<CrawlerResult[]> {
    await this.warmCookie();
    const floor = windowFloor();
    console.log(`[${this.name}] 更新窗口下界=${floor}（回退周末后），pageSize=${PAGE_SIZE}`);

    const seenUrls = new Set<string>();
    const allDates: string[] = [];
    let page = 1;
    while (page <= MAX_PAGES) {
      let text = "";
      try {
        text = await this.fetchPage(page);
      } catch (err) {
        console.warn(`[${this.name}] 第 ${page} 页抓取失败，停止翻页: ${(err as Error).message}`);
        break;
      }
      const rows = parseBseJson(text);
      if (rows.length === 0) break;

      for (const r of rows) {
        const upd = parseBseDate(r.updateDate);
        if (!upd) continue; // 时间红线：无真实更新日期废弃
        allDates.push(upd);
        if (upd < floor) continue; // 早于窗口下界非当日增量
        if (!isGdRow(r)) continue;
        const meta = BSE_STATUS[r.status] || { label: "IPO审核中", stage: "stage-reviewing" };
        if (meta.drop) continue;
        const item = this.toResult(r);
        // 分桶策略若变化致跨页重叠时去重（url 由 toResult 恒定产出，缺省时回落业务键）
        const key = item.url || `${r.stockCode || r.id || r.companyName}@${r.status}`;
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        this.results.push(item);
      }

      const dates = rows.map((x) => parseBseDate(x.updateDate)).filter(Boolean);
      const pageEarliest = dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : floor;
      if (pageEarliest < floor) {
        console.log(`[${this.name}] 第 ${page} 页最早更新 ${pageEarliest} < ${floor}，早停`);
        break;
      }
      page++;
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 800));
    }

    this.warnIfStale(allDates);
    console.log(`[${this.name}] 完成，共 ${this.results.length} 条（窗口内广东动态）`);
    return this.results;
  }

  /**
   * 新鲜度哨兵（2026-09-10 教训）。
   *
   * 本源新鲜度完全取决于 `pageSize` 命中的服务端分桶，属官方未文档化行为：
   * 一旦官方调整策略，接口会**静默**退回陈旧桶（本次就是这样埋了 13 天无人察觉），
   * 表现为「抓取成功但数据老旧」。故此处显式告警，便于 CI 日志一眼定位。
   * 抽出为公开方法便于单测直接断言。
   */
  warnIfStale(allDates: string[]): void {
    if (allDates.length === 0) {
      console.warn(`[${this.name}] ⚠️ 新鲜度告警：本次 0 条日期，接口或分桶可能异常`);
      return;
    }
    const newest = allDates.reduce((a, b) => (b > a ? b : a));
    const lag = dayGap(newest, localDay());
    if (lag > STALE_LAG_DAYS) {
      console.warn(
        `[${this.name}] ⚠️ 新鲜度告警：最新更新日 ${newest} 滞后 ${lag} 天（阈值 ${STALE_LAG_DAYS}），` +
          `大概率 pageSize 分桶缓存策略已变化，请核查接口`,
      );
    }
  }

  /** 行 → CrawlerResult（title 含官方状态词 + ipoStage 结构化旁路）。 */
  private toResult(r: BseRow): CrawlerResult {
    const short = shortName(r.stockName || r.companyName);
    const meta = BSE_STATUS[r.status] || { label: "IPO审核中", stage: "stage-reviewing" };
    const title = `${short}：${meta.label}（拟北交所）`;
    const upd = parseBseDate(r.updateDate);
    const regLoc = (r.registerAddress || "").replace(/\s+/g, "");
    const excerpt = [
      `注册地：${regLoc}`,
      r.sponsorOrg ? `保荐：${r.sponsorOrg}` : "",
      r.stockCode ? `代码：${r.stockCode}` : "",
      `状态：${meta.label}`,
      `更新：${upd}`,
    ]
      .filter(Boolean)
      .join("｜");

    return {
      title,
      // P4-③ 状态变更锚点：url 含 @状态，使同一企业不同审核阶段不被 URL 去重吞掉状态升级
      url: `${BSE_LIST}#${r.stockCode || r.id || r.companyName}@${r.status}`,
      excerpt,
      publishedAt: upd,
      sourceId: "gd-bse-audit",
      region: "gd",
      registeredProvince: "广东",
      ipoStage: meta.stage,
    };
  }
}

export function createCrawler(): BseAuditCrawler {
  return new BseAuditCrawler();
}
