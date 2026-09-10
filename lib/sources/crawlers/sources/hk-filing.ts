import { BaseCrawler, CrawlerResult } from "../base-crawler";
import { windowFloor } from "./ipo-shared";
import { IPO_SOURCE_WINDOW_DAYS } from "../../../ipo-config";
import { warnIfStale } from "./staleness";

/**
 * 港交所（HKEX）新股递表爬虫 —— IPO 体系重设计 batch 5「港股递表」。
 *
 * 数据来源：披露易「新上市申请 — 处理中申请」JSON 接口（与官网「综合索引 xlsx」同源、
 * 结构化、零解析依赖）：
 *   - 主板（ACTIVE）：https://www1.hkexnews.hk/ncms/json/eds/appactive_app_sehk_c.json
 *   - GEM （ACTIVE）：https://www1.hkexnews.hk/ncms/json/eds/appactive_app_gem_c.json
 *
 * 设计文档原写「两 xlsx 索引（主板/GEM from hkexnews.hk）」——真实 xlsx 端点为
 * /app/documents/sehkconsolidatedindex.xlsx 等（已验证 200 可下），但本项目改用同源
 * JSON 接口（免 xlsx 解析依赖、字段更规整；两者数据一致，均为「主板/GEM 两索引」）。
 *
 * 采用繁体中文 _c 接口：港股申请人名本就繁体，展示即原貌；同一字符串直接用于
 * 「广东企业」识别（繁体 GD 城市正则），无需引入简繁映射表。
 *
 * 输出：
 *   - 广东企业 → sourceId=hk-filing-gd / region='gd' / registeredProvince='广东'
 *     → 经 SOURCE_ROUTE 归 「广东地区IPO」(gd-ipo)，作为跨境融资商机。
 *   - 其余 → sourceId=hk-filing / region='cn' → 归 「全国IPO/新股」(ipo/hkex)。
 *
 * 时间红线（2026-08-29 强化）：publishedAt = 官方递表日 d（DD/MM/YYYY），
 * 无日期废弃，绝不抓取日兜底。
 * 阶段（P4 结构化旁路）：在审递表 = stage-reviewing。
 *
 * 音量控制：仅取近 windowDays（默认 = IPO_SOURCE_WINDOW_DAYS = 7 天窗，与
 * szse/sse/bse/csrcfd 完全一致；2026-09-10 用户拍板「hk-filing 收到 7 天，保持一致」）
 * 内新递表 + 总条数上限 MAX_OUTPUT（优先广东、其次日期倒序），
 * 避免全量历史积压塞爆管线与历史库（旧默认 365 天 → 每天抓 40+ 条港股条目全在
 * 展示窗外，纯烧 PASS1/PASS2 AI 成本）。
 */
const HK_BASE = "https://www1.hkexnews.hk/ncms/json/eds/";
const MAIN_URL = HK_BASE + "appactive_app_sehk_c.json";
const GEM_URL = HK_BASE + "appactive_app_gem_c.json";

/** 繁体 GD 城市/省正则（识别「广东企业赴港递表」）。 */
const GD_CITIES_TRAD =
  /廣東|廣州|深圳|珠海|汕頭|佛山|韶關|湛江|肇慶|江門|茂名|惠州|梅州|汕尾|河源|陽江|清遠|東莞|中山|潮州|揭陽|雲浮|粵/;
/** 英文兜底（少数广东企业英文名含地名）。 */
const GD_EN =
  /guangdong|guangzhou|shenzhen|zhuhai|dongguan|foshan|zhongshan|huizhou|jiangmen|zhaoqing|shantou|shaoguan|zhanjiang|maoming|shanwei|heyuan|yangjiang|qingyuan|yunfu|chaozhou|jieyang/i;

export interface HkApp {
  id: number;
  d: string; // DD/MM/YYYY
  a: string; // 申请人（繁体中文）
  w?: string; // 警示函/承诺书 相对路径（warn...pdf，**非公告**，严禁作主链接）
  ls?: Array<{
    d: string; // DD/MM/YYYY
    nF?: string; // 文档族（申請版本 / 聆訊後資料集 / …）
    nS1?: string; // 子类型（全文檔案 / 整體協調人公告－委任 / …）
    nS2?: string;
    u1?: string; // PDF 相对路径
    u2?: string; // HTM 相对路径
  }>;
  postingDate?: string;
}

/**
 * 选取每条递表记录的「正式公告」入口作为主链接。
 *
 * HKEX 数据结构要点（已逐一核对 360 条主板记录）：
 *   - `w`        → `warn...pdf`，为「警示函 / 承诺书」，**不是公告**，绝不能作主链接。
 *   - `ls[]`     → 多份披露文件，每份含：
 *       · `nF` 含「申請版本」= 正式申请版本（招股书），这才是市场关注的公告；
 *       · `u1` = 该公告的 PDF 全文（几百页，很重）；
 *       · `u2` = 该公告的 **HTM 简讯页/索引页**（约 13KB），列出公告类型与全部章节导航
 *                （警告 / 概要 / 風險因素 / 業務 / 財務資料 …），**轻量且最能代表"这是什么公告"**；
 *       · `nS1` 多为「整體協調人公告－委任」（保荐人委任公告），非招股书；
 *       · 上市后会出现「聆訊後資料集」(PHIP)，为更新版公告。
 *
 * 取数口径（用户 2026-09-10 反馈：只要简讯链接、不要几百页招股书）：
 *   优先公告的 **u2 简讯页（htm）** → 退而取 u1 PDF → 最后才用 w（如实标注为警示函）。
 *   即优先「申請版本（含修訂版）/ 聆訊後資料集」的可见入口，绝不用承诺书冒充公告。
 *
 * 返回的 `date` 为**所选文档自带的日期（DD/MM/YYYY）**——这是"该公告发布日"，
 * 也就是真正的**递表日**（申請版本第一次呈交那天），与用户点开的文档一致。
 * ⚠️ 顶层 `rec.d` 是「最近更新日」（= 各文档里最晚的日期，360/360 恒等），
 * 用它会让"8/21 递表、9/4 修订保荐人公告"的公司显示成 9/4，与所链文档不符（用户 09-10 实锤）。
 *
 * @param opts.preferPdf 为 true 时直接取 PDF（u1）而非简讯页（u2）；默认 false（取简讯页）。
 */
export function pickHkDocUrl(
  rec: HkApp,
  opts: { preferPdf?: boolean } = {},
): { url: string; label: string; date?: string } | null {
  const DOC_ROOT = "https://www1.hkexnews.hk/app/";
  const ls = rec.ls || [];
  const phip = ls.find((d) => (d.nF || "").includes("聆訊後資料集"));
  const appVer = ls.find((d) => (d.nF || "").includes("申請版本"));
  const chosen = phip || appVer || ls[0];
  if (chosen) {
    const label = chosen.nF || chosen.nS1 || "港交所披露文件";
    const date = chosen.d || "";
    if (!opts.preferPdf && chosen.u2) {
      // 首选：简讯页（HTM 索引页，轻量、直接体现公告性质）
      return { url: `${DOC_ROOT}${chosen.u2}`, label, date };
    }
    if (chosen.u1) {
      return { url: `${DOC_ROOT}${chosen.u1}`, label, date };
    }
    if (chosen.u2) {
      return { url: `${DOC_ROOT}${chosen.u2}`, label, date };
    }
  }
  // 兜底：仅 w 可用（警示函/承诺书），仍给链接但如实标注
  if (rec.w) {
    return { url: `${DOC_ROOT}${rec.w}`, label: "港交所警示函" };
  }
  return null;
}

/** DD/MM/YYYY → YYYY-MM-DD；失败返回空（时间红线）。 */
export function parseHkDate(d: string): string {
  const m = String(d || "").trim().match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

/** 广东企业识别（繁体优先 + 英文兜底）。 */
export function isGdHk(name: string): boolean {
  if (GD_CITIES_TRAD.test(name)) return true;
  if (GD_EN.test(name)) return true;
  return false;
}

export class HkFilingCrawler extends BaseCrawler {
  /** 递表窗口（天）：仅取近窗口内新递表。默认与 A 股 IPO 源统一为 7 天（日差 ≤ 7）。 */
  windowDays = IPO_SOURCE_WINDOW_DAYS;
  /** 广东企业上限（跨境融资商机优先）。 */
  maxGd = 25;
  /**
   * 全国参考上限。
   *
   * ⚠️ 2026-09-10 由 15 下调到 6（回检 P1-1）：底部 tab 已拍板**只展示广东**
   * （`render.ts` 的 `topGdIpo` 按「粤」标/内容判定过滤），全国条目因此 **100% 不展示**，
   * 却要穿过 PASS1/PASS2 与相关性 LLM 评估，属纯成本通道。保留少量样本（而非清零）
   * 是为将来「全国 IPO 参考」视图留口，同时把每日无效条数压到 1/2 以下。
   * `exec-pool.buildIpoPool` 另有广东预过滤，确保外省信息不会写进「广东IPO」口播。
   */
  maxNational = 6;

  /** 产出 sourceId（P1-6 注册一致性测试遍历本字段；广东 → hk-filing-gd，其余 → hk-filing）。 */
  override sourceIds = ["hk-filing-gd", "hk-filing"];

  constructor() {
    super({ name: "港交所新股递表", timeout: 20000, retries: 3 });
  }

  /** 抓取 + 解析单个 JSON 端点（protected 便于测试 mock）。 */
  protected async fetchApps(url: string): Promise<HkApp[]> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": this.userAgent },
          signal: AbortSignal.timeout(this.timeout),
        });
        if (!resp.ok) {
          console.warn(`[${this.name}] ${url} 返回 ${resp.status}`);
          if (attempt < this.retries + 1) {
            await this._backoff(attempt);
            continue;
          }
          break;
        }
        const j = (await resp.json()) as { app?: unknown };
        return Array.isArray(j?.app) ? (j.app as HkApp[]) : [];
      } catch (err) {
        lastErr = err;
        console.warn(
          `[${this.name}] ${url} 抓取失败（尝试 ${attempt}/${this.retries + 1}）: ${(err as Error).message}`,
        );
        if (attempt < this.retries + 1) await this._backoff(attempt);
      }
    }
    return [];
  }

  private hkWindowFloor(): string {
    // 复用 szse-audit.windowFloor（本地日期格式化，避免 toISOString 的 UTC 偏移少算一天），
    // 与 A 股各 IPO 源共用同一「近 N 天 = 日差 ≤ N」口径。
    return windowFloor(new Date(), this.windowDays);
  }

  /** override run()：主板 + GEM 两索引，窗口过滤 + 广东识别 + 音量上限。 */
  override async run(): Promise<CrawlerResult[]> {
    const floor = this.hkWindowFloor();
    const boards: Array<[string, string]> = [
      ["主板", MAIN_URL],
      ["GEM", GEM_URL],
    ];

    const collected: CrawlerResult[] = [];
    const allDates: string[] = []; // 新鲜度哨兵输入（含窗口外日期）
    for (const [label, url] of boards) {
      const apps = await this.fetchApps(url);
      console.log(`[${this.name}] ${label} 在审 ${apps.length} 条`);
      for (const rec of apps) {
        const name = String(rec.a || "").trim();
        if (!name) continue;
        const latestDate = parseHkDate(rec.d); // 顶层 d = 最近更新日（非首次递表日）
        if (!latestDate) continue; // 时间红线：无真实日期废弃
        allDates.push(latestDate);
        const gd = isGdHk(name);
        // 主链接取「申請版本（招股书）」正式公告的简讯页；绝不用 w（警示函/承诺书）。
        // 文档根实为 https://www1.hkexnews.hk/app/ （相对路径需补 /app/ 前缀，否则 404）。
        const doc = pickHkDocUrl(rec);
        const docUrl = doc?.url || "";
        const docLabel = doc?.label;
        // 卡片日期 = 所选公告文档自带日期 = 真正的**递表日**（如申請版本第一次呈交那天），
        // 与用户点开的文档一致；顶层 d 是"最近更新日"（含保荐人修订公告等），会显示偏晚。
        const eventDate = (doc?.date ? parseHkDate(doc.date) : "") || latestDate;
        if (eventDate < floor) continue; // 窗口外（历史积压）丢弃
        const title = gd ? `${name}（${label}递表·广东企业）` : `${name}（${label}递表）`;
        const excerpt = [
          `市场：${label}`,
          `递表日：${eventDate}`,
          eventDate !== latestDate ? `最近更新：${latestDate}` : "",
          gd ? "广东企业赴港上市，可跟进跨境融资商机" : "港股在审（全国参考）",
        ]
          .filter(Boolean)
          .join("｜");
        collected.push({
          title,
          url: docUrl || url,
          excerpt,
          publishedAt: eventDate,
          sourceId: gd ? "hk-filing-gd" : "hk-filing",
          region: gd ? "gd" : "cn",
          ...(gd ? { registeredProvince: "广东" } : {}),
          ipoStage: "stage-reviewing",
          ...(docUrl ? { officialUrl: docUrl, officialLabel: docLabel } : {}),
        });
      }
    }

    // 音量控制：广东 / 全国各自独立上限（避免广东优先排序把全国参考挤占为 0），
    // 各自内部按递表日倒序（最新在前）。
    const byGd = collected.filter((r) => r.region === "gd");
    const byCn = collected.filter((r) => r.region !== "gd");
    const dateDesc = (a: CrawlerResult, b: CrawlerResult) =>
      (b.publishedAt || "") < (a.publishedAt || "") ? -1 : 1;
    const out = [
      ...byGd.sort(dateDesc).slice(0, this.maxGd),
      ...byCn.sort(dateDesc).slice(0, this.maxNational),
    ];
    this.results.push(...out);

    const gdCount = out.filter((r) => r.region === "gd").length;
    warnIfStale(this, allDates);
    console.log(
      `[${this.name}] 完成，共 ${out.length} 条（广东 ${gdCount} / 全国 ${out.length - gdCount}）`,
    );
    return this.results;
  }
}

export function createCrawler(): HkFilingCrawler {
  return new HkFilingCrawler();
}
