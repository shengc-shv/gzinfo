import { CrawledArticle } from "../../../ingest/merge";

/**
 * 上市复核（候选复核，不拉全量）—— P3（2026-09-10 用户决策②：本期做、不拉全量、批量复核）。
 *
 * 背景：三所「已上市」列表（B1 上交所 / B2 深交所 / B3 北交所）按代码排序非日期倒序，
 * 全量 2358/2900/331 条逐日拉取是浪费。改为「候选复核」：
 *   1) 有界拉取（每源最多 MAX_PAGES 页，仅近 WINDOW_DAYS 天上市）构建 广东 上市字典；
 *   2) 发现：广东近期上市企业 → 产出 stage-listed 卡片（带真实 LIST_DATE）；
 *   3) 复核：把今日爬虫产出的广东候选（注册生效/过会/提交注册）按股票代码匹配上市字典，
 *      命中则升级为 stage-listed 并补 listedDate（审核 updateDate ≠ 挂牌上市日）。
 *
 * 端点（源自《广东上市商机监测_实施方案.md》B1~B3，2026-09-10 复核 + 实测）：
 *   B1 上交所：`query.sse.com.cn/sseQuery/commonQuery.do` sqlId=COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L，
 *       STOCK_TYPE 必须留空（否则漏科创板）；返回【纯 JSON】（非 JSONP）字段
 *       FULL_NAME/COMPANY_ABBR/A_STOCK_CODE/LIST_DATE(AREA_NAME_DESC 可判广东；LIST_DATE=YYYYMMDD)
 *   B2 深交所：`szse.cn/api/report/ShowReport/data` CATALOGID=1110；返回 JSON 数组；
 *       字段 agdm/agjc(含HTML需清洗)/agssrq(YYYY-MM-DD)/bk/sshymc；无地区字段 → 仅用于代码匹配候选
 *   B3 北交所：`bse.cn/newShareController/infoResult.do`；返回 JSONP `cb([{listInfo:{content}}])`；
 *       上市日期字段是 issueResultDate（非 listDate）；registerAddress("广东省 东莞市") 可判广东
 *
 * 时间红线：listedDate 必须来自官方 LIST_DATE，无日期不产出。
 */

const SSE_LIST_API = "https://query.sse.com.cn/sseQuery/commonQuery.do";
const SZSE_LIST_API = "https://www.szse.cn/api/report/ShowReport/data";
const BSE_LIST_API = "https://www.bse.cn/newShareController/infoResult.do";

const SSE_REF = "https://www.sse.com.cn/market/stockdata/overview/stocklist/index.html";
const SZSE_REF = "https://www.szse.cn/market/stock/list/index.html";
const BSE_HTML = "https://www.bse.cn/audit/project_news_select.html";
const BSE_REF = BSE_HTML;

const MAX_PAGES = 4; // 每源最多翻 4 页（有界，不拉全量）。SSE 1000/页；SZSE/BSE 只取最新几页
/**
 * 复核窗口（天）：**与底部「广东IPO动态」7 天展示窗对齐**（2026-09-10 回检 P1-2 收敛，
 * 原为 120 天）。理由：超过展示窗的上市记录既不展示、也不会被复核命中（候选的审核
 * updateDate 必在 7 天窗内），120 天只会把大量「4 个月前上市」的广东企业灌进 pool。
 */
const WINDOW_DAYS = 7;

/** 广东地区词（AREA_NAME_DESC / registerAddress 命中）。 */
export const GD_AREA =
  /(广东|广州|深圳|东莞|佛山|珠海|中山|惠州|江门|汕头|湛江|肇庆|梅州|汕尾|河源|阳江|清远|潮州|揭阳|云浮|顺德)/;

interface Listing {
  code: string;
  name: string;
  listedDate: string; // YYYY-MM-DD
  exchange: "SSE" | "SZSE" | "BSE";
  area?: string;
}

interface ParseResult {
  listings: Listing[];
  rawCount: number; // 原始行数（不含过滤），用于判断「本页为空」以早停
  pageCount?: number; // SZSE 元数据中的总页数（用于倒序抓取末页）
  firstKey?: string; // 本页首行标识（代码），用于检测分页是否未推进（如上交所忽略 pageNo 重复返回全量）
}

/**
 * 剥离 JSONP 包裹 cb(...) / cb1(...) → 内层 JSON 字符串。
 * 仅当整串为 `token(content)` 形式才剥离；纯 JSON（{...} / [...]）原样返回，
 * 避免把 JSON 内部的 '(' 误判为包裹起点（B1 上交所返回纯 JSON，曾因此被截断）。
 */
function stripJsonp(text: string): string {
  const s = text.trim();
  const m = s.match(/^([A-Za-z_$][\w.$]*)\(([\s\S]*)\)$/);
  if (m) return m[2];
  return s;
}

/** "2019-07-22" / "2019-07-22 00:00:00" / "20020409"(8位) / 数字毫秒 → YYYY-MM-DD；无日期返回空。 */
export function parseListedDate(v: unknown): string {
  if (!v) return "";
  if (typeof v === "number") return new Date(v).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/); // 8 位 YYYYMMDD（上交所 LIST_DATE）
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

/** 清洗 SZSE agjc 自带 HTML 标签。 */
function cleanHtml(s: string): string {
  return String(s || "").replace(/<[^>]+>/g, "").trim();
}

/** 解析上交所列表（纯 JSON；含 AREA_NAME_DESC 可判广东）。 */
export function parseSseListings(text: string, cutoff: string): ParseResult {
  const j = stripJsonp(text);
  if (!j) return { listings: [], rawCount: 0 };
  let data: { pageHelp?: { data?: Record<string, unknown>[] } };
  try {
    data = JSON.parse(j);
  } catch {
    return { listings: [], rawCount: 0 };
  }
  const rows = data?.pageHelp?.data || [];
  const out: Listing[] = [];
  for (const r of rows) {
    const code = String(r.A_STOCK_CODE || "").trim();
    const name = String(r.FULL_NAME || r.COMPANY_ABBR || "").trim();
    const listedDate = parseListedDate(r.LIST_DATE);
    const area = String(r.AREA_NAME_DESC || "").trim();
    if (!code || !name || !listedDate) continue;
    if (listedDate < cutoff) continue; // 仅近窗口
    if (!GD_AREA.test(area)) continue; // 仅广东
    out.push({ code, name, listedDate, exchange: "SSE", area });
  }
  return { listings: out, rawCount: rows.length, firstKey: String(rows[0]?.A_STOCK_CODE || "") };
}

/** 解析北交所新股发行（JSONP；registerAddress 可判广东；上市日为 issueResultDate）。 */
export function parseBseListings(text: string, cutoff: string): ParseResult {
  const j = stripJsonp(text);
  if (!j) return { listings: [], rawCount: 0 };
  let parsed: { 0?: { listInfo?: { content?: unknown[] } } } | unknown[];
  try {
    parsed = JSON.parse(j);
  } catch {
    return { listings: [], rawCount: 0 };
  }
  const arr = Array.isArray(parsed) ? parsed : [];
  const content = (arr[0] as { listInfo?: { content?: unknown[] } } | undefined)?.listInfo?.content || [];
  const out: Listing[] = [];
  for (const r of content) {
    const rr = r as Record<string, unknown>;
    const code = String(rr.stockCode || "").trim();
    const name = String(rr.companyName || rr.stockName || "").trim();
    const listedDate = parseListedDate(rr.issueResultDate ?? rr.listDate ?? rr.LIST_DATE);
    const area = String(rr.registerAddress || "").trim();
    if (!code || !name || !listedDate) continue;
    if (listedDate < cutoff) continue;
    if (!GD_AREA.test(area)) continue;
    out.push({ code, name, listedDate, exchange: "BSE", area });
  }
  return { listings: out, rawCount: content.length, firstKey: String(content[0] ? (content[0] as Record<string, unknown>).stockCode || "" : "") };
}

/** 解析深交所列表（JSON：[{metadata:{pagecount}, data:[...]}]；无地区字段，仅用于代码匹配候选）。 */
export function parseSzseListings(text: string, cutoff: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { listings: [], rawCount: 0 };
  }
  const arr = Array.isArray(parsed) ? parsed : [];
  // 真实结构：[{ metadata:{pagecount}, data:[行...] }]；测试 mock 为裸数组 [行...]
  const wrapper = (arr[0] as { metadata?: { pagecount?: number }; data?: unknown[] }) || {};
  const rows: Record<string, unknown>[] = Array.isArray(wrapper.data)
    ? (wrapper.data as Record<string, unknown>[])
    : (arr as Record<string, unknown>[]);
  const pageCount = wrapper.metadata?.pagecount;
  const out: Listing[] = [];
  for (const r of rows) {
    const code = String(r.agdm || "").trim();
    const name = cleanHtml(String(r.agjc || ""));
    const listedDate = parseListedDate(r.agssrq);
    if (!code || !name || !listedDate) continue;
    if (listedDate < cutoff) continue;
    out.push({ code, name, listedDate, exchange: "SZSE" });
  }
  return { listings: out, rawCount: rows.length, pageCount, firstKey: String(rows[0]?.agdm || "") };
}

function shortName(full: string): string {
  return String(full || "")
    .replace(/股份有限公司$/, "")
    .replace(/有限责任公司$/, "")
    .replace(/有限公司$/, "");
}

const EXCHANGE_LABEL: Record<Listing["exchange"], string> = {
  SSE: "沪市主板/科创板",
  SZSE: "深市主板/创业板",
  BSE: "北交所",
};
// 读者点开的「已上市」落地页。与上方 *REF（接口抓取所需 Referer）解耦：
// SSE/SZSE 原 stocklist/list 旧页已 404，改为当前可访问的上市/项目页；BSE 沿用项目页。
const EXCHANGE_URL: Record<Listing["exchange"], string> = {
  SSE: "https://www.sse.com.cn/ipo/listing/",
  SZSE: "https://www.szse.cn/listing/projectdynamic/ipo/index.html",
  BSE: BSE_REF,
};

function toArticle(l: Listing): CrawledArticle {
  const title = `${shortName(l.name)}：已于${l.listedDate}上市（${EXCHANGE_LABEL[l.exchange]}）`;
  const excerpt = [
    `代码：${l.code}`,
    `上市日期：${l.listedDate}`,
    l.area ? `注册地：${l.area.replace(/\s+/g, "")}` : "",
  ]
    .filter(Boolean)
    .join("｜");
  return {
    title,
    // P4-③ 状态变更锚点：已上市为终态，@listed 区分于审核态 url，避免与在审卡去重重名
    url: `${EXCHANGE_URL[l.exchange]}#${l.code}@listed`,
    excerpt,
    publishedAt: l.listedDate,
    sourceId: "gd-listed-check",
    region: "gd",
    registeredProvince: "广东",
    ipoStage: "stage-listed",
    listedDate: l.listedDate,
    summary: `广东企业${l.name}于${l.listedDate}在${EXCHANGE_LABEL[l.exchange]}上市，代码${l.code}。`,
  };
}

export class ListedChecker {
  /** 产出 sourceId（P1-6 注册一致性测试遍历；本类非 BaseCrawler 子类，单独声明）。 */
  readonly sourceIds = ["gd-listed-check"];

  private cookie = ""; // BSE 预热后捕获的 cookie

  /** 有界拉取三所近期上市 → 广东上市字典（code → Listing）。 */
  async buildListingMap(cutoff: string): Promise<Map<string, Listing>> {
    const map = new Map<string, Listing>();
    const merge = (ls: Listing[]) => {
      for (const l of ls) if (!map.has(l.code)) map.set(l.code, l);
    };
    // B1 上交所（广东）—— 实测 pageNo 被忽略、单次即返回全量(2517 条)；故检测「分页未推进」即早停，避免重复拉全量
    try {
      let prevKey: string | undefined;
      for (let p = 1; p <= MAX_PAGES; p++) {
        const text = await this.fetchSse(p);
        const res = parseSseListings(text, cutoff);
        merge(res.listings);
        if (res.rawCount === 0) break; // 真·空页 → 早停
        if (prevKey !== undefined && res.firstKey === prevKey) break; // 分页未推进（如 pageNo 被忽略）→ 早停
        prevKey = res.firstKey;
      }
    } catch (err) {
      console.warn(`[listed-check] B1 上交所拉取失败: ${(err as Error).message}`);
    }
    // B3 北交所（广东）—— 预热 cookie 后抓取；不稳定时降级
    try {
      await this.warmCookie();
      let prevKey: string | undefined;
      for (let p = 1; p <= MAX_PAGES; p++) {
        const text = await this.fetchBse(p);
        const res = parseBseListings(text, cutoff);
        merge(res.listings);
        if (res.rawCount === 0) break;
        if (prevKey !== undefined && res.firstKey === prevKey) break;
        prevKey = res.firstKey;
      }
    } catch (err) {
      console.warn(`[listed-check] B3 北交所拉取失败: ${(err as Error).message}`);
    }
    // B2 深交所（无地区字段，仅代码匹配候选）：深交所按代码升序、末页=最新上市。
    // 故先取总页数，再倒序抓取最后 MAX_PAGES 页（最新上市），不拉全 145 页。
    try {
      const first = await this.fetchSzse(1);
      const firstRes = parseSzseListings(first, cutoff);
      merge(firstRes.listings);
      const totalPages = firstRes.pageCount ?? 1;
      const startPage = Math.max(2, totalPages - MAX_PAGES + 1);
      for (let p = startPage; p <= totalPages; p++) {
        const res = parseSzseListings(await this.fetchSzse(p), cutoff);
        merge(res.listings);
        if (res.rawCount === 0) break;
      }
    } catch (err) {
      console.warn(`[listed-check] B2 深交所拉取失败: ${(err as Error).message}`);
    }
    return map;
  }

  /**
   * 候选复核主入口。
   * @param ipo 今日爬虫产出的广东 IPO 候选（region='gd'）
   * @returns 新发现的广东已上市企业（stage-listed 卡片，带 listedDate）
   *          同时**就地**把 ipo 中命中上市字典的候选升级为 stage-listed + listedDate。
   */
  async run(ipo: CrawledArticle[]): Promise<CrawledArticle[]> {
    const cutoff = this.cutoffDate();
    const map = await this.buildListingMap(cutoff);

    // 复核：今日候选按代码命中 → 升级
    for (const a of ipo) {
      if (a.region !== "gd" || !a.stockCode) continue;
      const hit = map.get(a.stockCode);
      if (hit && hit.listedDate >= cutoff) {
        a.ipoStage = "stage-listed";
        a.listedDate = hit.listedDate;
        if (!a.summary) {
          a.summary = `广东企业${shortName(a.title || "")}已于${hit.listedDate}上市（代码${hit.code}）。`;
        }
      }
    }

    // 发现：上市字典中广东企业 → 产出卡片（与爬虫去重交由上层 dedupeByUrl）
    const discovered = new Map<string, CrawledArticle>();
    for (const l of map.values()) {
      if (l.exchange === "SZSE") continue; // 深交所无地区字段，仅作代码匹配，不单独发现
      if (!GD_AREA.test(l.area || "")) continue;
      if (!discovered.has(l.code)) discovered.set(l.code, toArticle(l));
    }
    console.log(`[listed-check] 上市字典 ${map.size} 条；新发现广东已上市 ${discovered.size} 条`);
    // 新鲜度哨兵（P0-3）：字典为空 = 三所接口全失败或字段改版 → 显式告警（否则静默无产出）
    if (map.size === 0) {
      console.warn(
        `::warning:: [listed-check] ⚠️ 上市字典为空（近 ${WINDOW_DAYS} 天窗口内 0 条），三所接口可能已改版或被拦`,
      );
    }
    return [...discovered.values()];
  }

  /** 近 WINDOW_DAYS 天的下界（YYYY-MM-DD）。 */
  cutoffDate(now: Date = new Date()): string {
    const d = new Date(now.getTime() - WINDOW_DAYS * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // —— 各源抓取（protected 便于测试 mock）——
  protected async fetchSse(page: number): Promise<string> {
    const params = new URLSearchParams({
      sqlId: "COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L",
      STOCK_TYPE: "", // 必须留空，否则漏科创板
      type: "inParams",
      isPagination: "true",
      "pageHelp.pageSize": "1000",
      "pageHelp.pageNo": String(page),
      _: Date.now().toString(),
    });
    return this.get(`${SSE_LIST_API}?${params.toString()}`, {
      Referer: SSE_REF,
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
    });
  }

  protected async fetchSzse(page: number): Promise<string> {
    const params = new URLSearchParams({
      SHOWTYPE: "JSON",
      CATALOGID: "1110",
      TABKEY: "tab1",
      PAGENO: String(page),
    });
    return this.get(`${SZSE_LIST_API}?${params.toString()}`, {
      Referer: SZSE_REF,
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    });
  }

  protected async fetchBse(page: number): Promise<string> {
    const params = new URLSearchParams({ callback: "cb", page: String(page) });
    const headers: Record<string, string> = {
      Referer: BSE_REF,
      Accept: "*/*",
      "X-Requested-With": "XMLHttpRequest",
      "Accept-Language": "zh-CN,zh;q=0.9",
    };
    if (this.cookie) headers["Cookie"] = this.cookie;
    return this.get(`${BSE_LIST_API}?${params.toString()}`, headers);
  }

  /** cookie 预热（C3VK）；捕获 set-cookie 供后续请求。失败不致命。 */
  protected async warmCookie(): Promise<void> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(BSE_HTML, {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bse.cn/", Accept: "text/html" },
        signal: ctrl.signal,
      });
      const sc = r.headers.get("set-cookie");
      if (sc) this.cookie = sc.split(";")[0];
      clearTimeout(t);
    } catch {
      /* 预热失败不影响后续请求（北交所多数情况下不依赖 cookie） */
    }
  }

  private async get(url: string, headers: Record<string, string>, timeout = 20000): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", ...headers }, signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } finally {
      clearTimeout(t);
    }
  }
}

export function createListedChecker(): ListedChecker {
  return new ListedChecker();
}
