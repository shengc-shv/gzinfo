import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 东方财富 - IPO 在审企业申报表爬虫（RPT_IPO_DECORGNEWEST）
 * ---------------------------------------------------------
 * 数据来源: https://datacenter-web.eastmoney.com/api/data/v1/get
 *
 * 为什么新增（2026-08-30 数据源检视结论）：
 *  - 旧 IPO 五源（szse/sse 巨潮搜「首次公开发行」/ bse / hkex / eastmoney-ipo 辅导）
 *    覆盖「已上市公告」与「辅导备案」，但【受理 → 问询 → 过会 → 提交注册 → 注册生效】
 *    整段在审企业生命周期没有源覆盖 —— 粤芯半导体（08-28 证监会批复注册生效）全部漏网。
 *  - 本接口：沪深北三所**在审企业全量**（实测 3904 家），含注册地/审核状态/保荐机构/
 *    拟上市板块/更新日期，`REG_ADDRESS="广东"` 过滤得 660 家。
 *    REG_ADDRESS 实测值为省名（"广东"），东财接口侧已按省份过滤 → 内容判定成立。
 *
 * 时间红线（2026-08-29 强化）：publishedAt 取 END_DATE（数据源状态更新日期，真实时间戳，
 * 非抓取时间兜底）；无 END_DATE 的条目废弃。
 *
 * 输出：region='gd' + registeredProvince='广东' → merge.routeRegion 归「广东地区IPO」板块
 * （gd-ipo），渲染侧三道闸（lib/classify/gdIpo.ts）按上市阶段分栏。
 */

/** 东财在审状态 → 卡片展示文案（STATE 枚举实测）。 */
const STATE_LABELS: Record<string, string> = {
  已受理: "IPO已受理",
  已问询: "IPO问询中",
  上市委会议通过: "IPO过会",
  提交注册: "IPO提交注册",
  已收到注册申请材料: "注册申请材料已受理",
  注册: "IPO注册生效",
  不予注册: "IPO未获注册",
};

/** 负面状态：不进日报（宁缺毋滥，商机视角无价值）。 */
const DROP_STATES = new Set(["终止", "中止", "不予注册"]);

/** 公司名简称：去掉企业组织形式后缀（"粤芯半导体技术股份有限公司" → "粤芯半导体"）。 */
export function shortCompanyName(full: string): string {
  return String(full || "")
    .replace(/股份有限公司$/, "")
    .replace(/有限责任公司$/, "")
    .replace(/有限公司$/, "");
}

export class EastMoneyDeclareCrawler extends BaseCrawler {
  constructor() {
    super({ name: "东财IPO在审(广东)", timeout: 20000, retries: 2 });
  }

  async getUrls(): Promise<Array<string | import("../base-crawler").CrawlUrl>> {
    const base = "https://datacenter-web.eastmoney.com/api/data/v1/get";
    // 广东在审企业当前 ~660 家：pageSize=200 × 5 页（上限 1000，余量充足）。
    // 接口侧已按 REG_ADDRESS="广东" 过滤（字段值即省名）。
    const pages: string[] = [];
    for (let p = 1; p <= 5; p++) {
      const params = new URLSearchParams({
        reportName: "RPT_IPO_DECORGNEWEST",
        columns: "ALL",
        sortColumns: "END_DATE,SECURITY_CODE",
        sortTypes: "-1,-1",
        pageSize: "200",
        pageNumber: String(p),
        filter: '(REG_ADDRESS="广东")',
        source: "WEB",
        client: "WEB",
      });
      pages.push(`${base}?${params.toString()}`);
    }
    return pages;
  }

  async parseArticle(responseText: string): Promise<CrawlerResult[]> {
    const out: CrawlerResult[] = [];
    let data: { result?: { data?: unknown[] } };
    try {
      data = JSON.parse(responseText);
    } catch {
      return out;
    }
    const rows = data?.result?.data;
    if (!Array.isArray(rows)) return out;

    const cutoff = Date.now() - 7 * 86_400_000; // 7 天更新窗口
    for (const raw of rows) {
      const r = raw as Record<string, unknown>;
      const org = String(r.DECLARE_ORG || "").trim();
      const state = String(r.STATE || "").trim();
      // END_DATE 形如 "2026-08-20 00:00:00"（状态更新日期）
      const endDate = String(r.END_DATE || "").match(/(\d{4}-\d{2}-\d{2})/)?.[1] || "";
      // 时间红线：无真实更新日期 → 废弃，绝不回退抓取时间
      if (!org || !endDate) continue;
      if (DROP_STATES.has(state)) continue;

      const ts = new Date(endDate).getTime();
      if (Number.isNaN(ts) || ts < cutoff) continue; // 只保留 7 天内更新的动态

      const short = shortCompanyName(org);
      const market = String(r.PREDICT_LISTING_MARKET || "A股").trim();
      const sponsor = String(r.RECOMMEND_ORG || "").trim();
      const code = String(r.SECURITY_CODE || "").trim();
      const label = STATE_LABELS[state] || state || "IPO动态";
      const title = `${short}：${label}（拟${market}）`;
      const excerpt = [
        `注册地：${String(r.REG_ADDRESS || "广东")}`,
        sponsor ? `保荐：${sponsor}` : "",
        `更新：${endDate}`,
      ]
        .filter(Boolean)
        .join("｜");

      // 唯一 URL（2026-08-30 修复 BUG A）：东财在审列表页是同一条列表 URL，若所有条目
      // 共用会被 fetchCrawledArticles 的 dedupeByUrl 合并成 1 条 → 多家广东企业被压成 1 家。
      // 用「列表页 + #企业简称/代码」锚点保证每条唯一且仍可点击跳转列表页。
      const anchor = encodeURIComponent(code || short);
      out.push({
        title,
        url: `https://data.eastmoney.com/xg/xg/#${anchor}`,
        excerpt,
        publishedAt: endDate,
        sourceId: "em-declare",
        region: "gd",
        registeredProvince: "广东",
      });
    }
    return out;
  }
}

export function createCrawler(): EastMoneyDeclareCrawler {
  return new EastMoneyDeclareCrawler();
}
