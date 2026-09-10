import { BaseCrawler, CrawlerResult } from "../base-crawler";
import { warnIfStale } from "./staleness";
// P2-3 收敛（2026-09-10）：共享工具（windowFloor/shortName/GD_CITIES）
// → ./ipo-shared（此前定义在本文件，被 sse/bse/hk-filing 跨源 import，
// 本文件事实上成了共享工具模块）；窗口常量 → lib/ipo-config.ts。
import { GD_CITIES, shortName, windowFloor } from "./ipo-shared";

/**
 * 深交所 —— IPO 审核项目动态爬虫（官方权威源，A2）
 *
 * 数据价值：官方「在审企业全量 + 审核状态 + 更新日期」即时源，替代东财在审代理
 * （东财 RPT_IPO_DECORGNEWEST 广东近 7 天仅 1 条 → 旧体系「一周一条」根因之一）。
 * 参考《广东上市商机监测_实施方案.md》源 A2（2026-09-09 实测）：
 *   - GET `https://www.szse.cn/api/ras/projectrends/query`（POST 报 9240000 系统异常）
 *   - 参数 bizType=1&pageIndex=N&pageSize=50&random=…；响应 JSON { totalSize, data[] }
 *   - 全量约 1461 家，**按 updtdt 严格倒序**（实测 09-09→07-18）→ 倒序早停成立
 *   - 关键字段：cmpnm 全称 / cmpsnm 简称 / prjst 中文状态 / prjstatus 代码 /
 *     regloc 注册地（仅到省） / sprinst·sprinsts 保荐全称·简称 / acptdt 受理日 /
 *     updtdt 更新日 / boardName 板块 / prjid 唯一主键
 *
 * 增量策略（2026-09-09 用户约束：先取一页看最早时间判定是否继续取，同 csrcfd）：
 *   ⚠️ 与 csrcfd 的差异：辅导库整页几乎都是近几天披露；SZSE 是「全量在审按更新排序」，
 *      一页 50 条跨约 2 个月（每日仅个位数企业更新）。因此必须：
 *       1) **窗口内过滤**：只收 updtdt >= windowFloor 的广东企业（否则 07 月旧企业
 *          会被当增量灌入日报 —— 污染展示窗口）
 *       2) 页内最早 updtdt < windowFloor → 早停（发 1~2 个请求即止）
 *   windowFloor = 今天 - IPO_SOURCE_WINDOW_DAYS 天（=近 7 天，日差 ≤ 7），落在周末则回退到周五。
 *
 * ⚠️ 窗口修正（2026-09-10 用户实锤 + 口径拍板）：原为「昨天」1 天窗，导致底部
 *    「广东IPO动态」列表只有昨日的 1 天量，而同页其他广东在审企业（如傲雷科技
 *    09-07 更新、博迈医疗 09-09 更新）不展现。用户拍板：**口播/今日必读 = 2 天窗、
 *    底部列表 = 7 天窗** → 源层按 7 天喂数（下游 pre-window 阶段对 IPO 类亦是 7 天窗）。
 *
 * ⚠️ 二次修正（2026-09-10 用户实锤「上交所 广东龙行天下 没看到」）：窗口口径由
 *    「含今天共 N 个日历日（今天-N+1 起）」改为 **「日差 ≤ N」（今天-N 起）**。
 *    原口径今日下界 09-04，而龙行天下（沪市主板，updateDate 09-03）恰是日差 7 的
 *    边界值 → 被卡在窗外。改后「近 7 天」= 09-03~09-10，与用户直觉一致。
 *
 * 时间红线（2026-08-29 用户强化）：publishedAt = updtdt（官方真实更新日期），
 * 无 updtdt 条目废弃，绝不回退抓取时间兜底。
 *
 * 输出：sourceId=gd-szse-audit / region='gd' / registeredProvince='广东' →
 * routeRegion 归「广东地区IPO」（gd-ipo），渲染侧三道闸按状态分栏（title 含官方状态词）。
 * 红线：本文件非红线 7 文件。
 */

const SZSE_API = "https://www.szse.cn/api/ras/projectrends/query";
const SZSE_LIST = "https://www.szse.cn/listing/projectdynamic/ipo/index.html";
const PAGE_SIZE = 50;
const MAX_PAGES = 5; // 兜底：最多抓 5 页（250 条），防死循环

/** 审核状态 → 卡片展示文案（prjst 中文官方值实测；与 inferStage 词表对齐）。 */
const STATE_LABELS: Record<string, string> = {
  已受理: "IPO已受理",
  已问询: "IPO问询中",
  上市委会议通过: "IPO过会",
  提交注册: "IPO提交注册",
  已收到注册申请材料: "注册申请材料已受理",
  注册生效: "IPO注册生效",
};

/** 负面状态：不进日报（宁缺毋滥，商机视角无价值）。 */
const DROP_STATES = new Set(["终止", "中止", "不予注册", "撤回", "终止注册"]);

/**
 * 官方审核状态 → IPO 阶段（P4 结构化旁路；2026-09-10 回检补齐——此前本源**完全没给**
 * ipoStage，与「爬虫按官方状态直接给出阶段」的重设计原则相悖，只能靠标题关键词反推）。
 *
 * 口径与 gdIpo.inferStage、SSE_STATUS、BSE_STATUS 三处**完全对齐**：
 * 受理/问询 → 在审；过会/提交注册/注册申请材料受理/注册生效 → 注册发行（待发行，非已上市）。
 */
export const STATE_STAGE: Record<string, string> = {
  已受理: "stage-reviewing",
  已问询: "stage-reviewing",
  上市委会议通过: "stage-registered",
  提交注册: "stage-registered",
  已收到注册申请材料: "stage-registered",
  注册生效: "stage-registered",
};

export interface SzseRow {
  prjid: number;
  cmpnm: string; // 全称
  cmpsnm: string; // 简称
  prjst: string; // 审核状态（中文）
  regloc: string; // 注册地（省级）
  sprinsts: string; // 保荐简称
  acptdt: string; // 受理日 YYYY-MM-DD
  updtdt: string; // 更新日 YYYY-MM-DD
  boardName: string; // 板块
}

/** 解析接口响应 JSON → 行数组（字段缺失容错）。 */
export function parseSzseJson(text: string): SzseRow[] {
  let data: { totalSize?: number; data?: unknown[] };
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = data?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      const updtdt = String(r.updtdt || "").match(/(\d{4}-\d{2}-\d{2})/)?.[1] || "";
      const acptdt = String(r.acptdt || "").match(/(\d{4}-\d{2}-\d{2})/)?.[1] || "";
      return {
        prjid: Number(r.prjid) || 0,
        cmpnm: String(r.cmpnm || "").trim(),
        cmpsnm: String(r.cmpsnm || "").trim(),
        prjst: String(r.prjst || "").trim(),
        regloc: String(r.regloc || "").trim(),
        sprinsts: String(r.sprinsts || "").trim(),
        acptdt,
        updtdt,
        boardName: String(r.boardName || "").trim(),
      };
    })
    .filter((x) => x.cmpnm && x.updtdt); // 时间红线：无真实更新日期废弃
}

/** 广东判定：官方 regloc 字段（去「省/市」后缀）== 广东；兜底企业名含广东城市。 */
export function isGdRow(row: SzseRow): boolean {
  const prov = row.regloc.replace(/省|市$/, "");
  if (prov === "广东") return true;
  return GD_CITIES.some((c) => row.cmpnm.includes(c));
}

/**
 * 窗口下界 `windowFloor` / `shortName` / `GD_CITIES` / `IPO_SOURCE_WINDOW_DAYS`
 * 已于 2026-09-10（P2-3）迁出本文件：常量 → `lib/ipo-config.ts`，
 * 工具 → `./ipo-shared`（此前被 sse/bse/hk-filing 跨源 import）。
 */

export class SzseAuditCrawler extends BaseCrawler {
  /** 产出 sourceId（P1-6 注册一致性测试遍历本字段）。 */
  override sourceIds = ["gd-szse-audit"];

  constructor() {
    super({ name: "深交所IPO审核动态", timeout: 20000, retries: 3 });
  }

  /** 单页抓取（GET + JSON；protected 便于测试 mock）。 */
  protected async fetchPage(pageIndex: number): Promise<string> {
    const params = new URLSearchParams({
      bizType: "1",
      pageIndex: String(pageIndex),
      pageSize: String(PAGE_SIZE),
      random: String(Math.random()),
    });
    const url = `${SZSE_API}?${params.toString()}`;
    const headers = {
      "User-Agent": this.userAgent,
      Referer: SZSE_LIST,
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
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
    throw new Error(`fetch SZSE page ${pageIndex} failed: ${String(lastErr)}`);
  }

  /** override run()：窗口内过滤 + 倒序早停多页抓取。 */
  override async run(): Promise<CrawlerResult[]> {
    const floor = windowFloor();
    console.log(`[${this.name}] 更新窗口下界=${floor}（回退周末后）`);
    let page = 0;
    let consecutiveStale = 0;
    const allDates: string[] = []; // 新鲜度哨兵输入（含窗口外日期）

    while (page < MAX_PAGES) {
      let text = "";
      try {
        text = await this.fetchPage(page);
      } catch (err) {
        console.warn(`[${this.name}] 第 ${page} 页抓取失败，停止翻页: ${(err as Error).message}`);
        break;
      }

      const rows = parseSzseJson(text);
      if (rows.length === 0) {
        if (++consecutiveStale >= 2) break; // 连续 2 页空 → 兜底停
        page++;
        continue;
      }

      // ① 先收集当前页「窗口内更新的广东企业」（SZSE 一页跨约 2 个月，必须窗口过滤）
      for (const r of rows) {
        allDates.push(r.updtdt);
        if (r.updtdt < floor) continue; // 早于窗口下界的更新不是当日增量
        if (!isGdRow(r)) continue;
        if ([...DROP_STATES].some((s) => r.prjst.includes(s))) continue; // 终止/中止类不进日报
        this.results.push(this.toResult(r));
      }

      // ② 再判是否继续翻页：页内最早 updtdt < floor → 早停（当前页已收）
      const pageEarliest = rows.reduce((min, x) => (x.updtdt < min ? x.updtdt : min), rows[0].updtdt);
      if (pageEarliest < floor) {
        console.log(`[${this.name}] 第 ${page + 1} 页最早更新 ${pageEarliest} < ${floor}，早停`);
        break;
      }
      page++;
      // 温和节流，避免触发反爬
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 800));
    }

    warnIfStale(this, allDates);
    console.log(`[${this.name}] 完成，共 ${this.results.length} 条（窗口内广东动态）`);
    return this.results;
  }

  /** 行 → CrawlerResult（title 含官方状态词，供 inferStage 分栏）。 */
  private toResult(r: SzseRow): CrawlerResult {
    const short = shortName(r.cmpsnm || r.cmpnm);
    const label = STATE_LABELS[r.prjst] || r.prjst || "IPO动态";
    const market = r.boardName ? `拟${r.boardName}` : "";
    const title = `${short}：${label}${market ? `（${market}）` : ""}`;
    const excerpt = [
      `注册地：${r.regloc || "广东"}`,
      r.sprinsts ? `保荐：${r.sprinsts}` : "",
      r.acptdt ? `受理：${r.acptdt}` : "",
      `状态：${r.prjst}`,
      `更新：${r.updtdt}`,
    ]
      .filter(Boolean)
      .join("｜");

    // 唯一 URL：官方列表页 + #prjid 锚点（官方无公司级详情页主键；保证 URL 唯一不被去重合并，
    // 且可点击跳官方审核项目动态栏目核查 —— 2026-09-07 用户「东财列表和交易所源都展现」的先例延续）
    return {
      title,
      url: `${SZSE_LIST}#prj${r.prjid}`,
      excerpt,
      publishedAt: r.updtdt,
      sourceId: "gd-szse-audit",
      region: "gd",
      registeredProvince: "广东",
      // P4 结构化旁路：官方状态直接给出的阶段（未收录的状态留空，由 gdIpoStageOf 回退关键词推断）
      ...(STATE_STAGE[r.prjst] ? { ipoStage: STATE_STAGE[r.prjst] } : {}),
    };
  }
}

export function createCrawler(): SzseAuditCrawler {
  return new SzseAuditCrawler();
}
