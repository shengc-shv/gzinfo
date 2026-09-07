/**
 * 交易所官方源映射（2026-09-07 用户要求）。
 *
 * 背景：东财在审企业（A25xxx 申请代码，尚未分配股票代码）在东方财富**没有精准详情页**
 * （实测 `data.eastmoney.com/xg/{xg,ipo}/detail|fd/*.html` 全部 404），卡片只能用
 * 「列表页 + #锚点」保证 URL 唯一，点开落在列表首页 —— 客户无法核查到具体企业。
 *
 * 因此每条 IPO 条目除东财链接外，再挂一条**交易所官方源**（人工核查用）。用户明确：
 * 「东财列表和交易所源地址都展现吧，不用去看具体的公司」—— 即只到交易所级栏目，
 * 不做公司级反查（需交易所主键，东财数据里没有）。
 *
 * 红线：本模块只产出「附加的核查链接」，不参与任何分类/过滤/打分判定；
 * 最终渲染归属仍由漏斗 + 内容判定决定。
 */

export interface ExchangeSource {
  /** 展示名，如「深交所 · 审核项目动态」。 */
  label: string;
  url: string;
}

/** 深交所：发行上市 → 审核项目动态 → IPO（带注册地/审核状态/保荐机构字段，可关键词直搜）。 */
const SZSE: ExchangeSource = {
  label: "深交所 · 审核项目动态",
  url: "https://www.szse.cn/listing/projectdynamic/ipo",
};

/** 上交所：发行上市 → 审核项目动态（详情页 auditId 可点）。 */
const SSE: ExchangeSource = {
  label: "上交所 · 发行上市审核",
  url: "https://www.sse.com.cn/listing/renewal/ipo",
};

/** 北交所：信息披露 → 发行上市审核 → 审核项目动态（详情页 project_news_detail.html?id=）。 */
const BSE: ExchangeSource = {
  label: "北交所 · 审核项目动态",
  url: "https://www.bse.cn/audit/project_news.html",
};

/** 港交所披露易：NEW LISTINGS → 申请版本及整体协调人公告（处理中/已上市/失效/撤回等状态）。 */
const HKEX: ExchangeSource = {
  label: "港交所披露易 · 新上市申请",
  url: "https://www2.hkexnews.hk/New-Listings/Application-Proof-and-PHIP",
};

/** 美国 SEC EDGAR 全文检索（Form S-1 美本土 / F-1 外国发行人）。 */
const SEC: ExchangeSource = {
  label: "SEC EDGAR · 招股书检索",
  url: "https://www.sec.gov/edgar/search/",
};

/**
 * 按「拟上市板块」文本（东财 PREDICT_LISTING_MARKET 等）匹配交易所官方源。
 * 匹配不到返回 undefined（调用方不加链，宁缺毋滥，不给客户不可达的链接）。
 */
export function exchangeSourceFor(market?: string): ExchangeSource | undefined {
  const m = (market ?? "").trim();
  if (!m) return undefined;
  if (/北交所|北证|BSE/.test(m)) return BSE;
  if (/创业板|深主板|深市|深证|中小板|SZSE/.test(m)) return SZSE;
  if (/科创板|沪主板|沪市|上证|SSE|STAR/.test(m)) return SSE;
  if (/香港|港股|港交所|HKEX|HK/.test(m)) return HKEX;
  if (/美国|美股|纳斯达克|纽交所|NASDAQ|NYSE|SEC|US/.test(m)) return SEC;
  return undefined;
}
