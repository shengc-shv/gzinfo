/**
 * 行情 API（新浪 hq.sinajs.cn / money.finance.sina.com.cn）抓取
 * （2026-08-25 用户拍板：股市解读三卡补「上一交易日收盘」精确指数）
 *
 * 取值语义（天然等于「昨日收盘」，与抓取时刻无关）：
 *  - CI 每日 09:10 跑时 A股/港股未开盘 → 行情接口 prev close = 上一交易日收盘；
 *  - 美股刚收盘（北京时间约 04:xx）→ last = 上一美股交易日收盘；
 *  - 取 prev close 字段（恒为上一交易日收盘），故即使本地补数（盘中抓取）数值也稳定正确。
 *
 * 涨跌幅来源：
 *  - 美股：行情接口直接给出 change%（last vs prev close，北京时间白天稳定）；
 *  - A股：用日 K 线接口按「上一交易日」日期匹配取昨收与前收计算（新浪港股指数无日 K，故港股只给点位不给涨跌幅）；
 *  - 任何一步失败均优雅降级（该市场/该卡缺涨跌幅，不阻断整页）。
 *
 * 卡脚备注「数据来源：新浪行情 · 取值于 <上一交易日> 收盘」即用户要的「精准发布时间 + 渠道」。
 */

const A_SHARE_DEFS = [
  { code: "sh000001", name: "上证指数", kline: "sh000001" },
  { code: "sz399001", name: "深证成指", kline: "sz399001" },
  { code: "sz399006", name: "创业板指", kline: "sz399006" },
];
const HK_DEFS = [
  { code: "hkHSI", name: "恒生指数" },
  { code: "hkHSTECH", name: "恒生科技" },
];
const US_DEFS = [
  { code: "gb_dji", name: "道琼斯" },
  { code: "gb_ixic", name: "纳斯达克" },
  { code: "gb_inx", name: "标普500" },
];

export interface IndexQuote {
  /** 指数中文名（硬编码，避免 GBK 解码） */
  name: string;
  /** 收盘点位（A股/港股=昨收；美股=最新收盘），保留 2 位小数 */
  value: string;
  /** 涨跌幅，带符号，如 "+0.26%" / "-0.76%"；港股指数无日 K 故可能缺失 */
  changePct?: string;
}

export interface MarketQuotes {
  aShare: IndexQuote[];
  hk: IndexQuote[];
  us: IndexQuote[];
}

export interface QuoteResult {
  quotes: MarketQuotes;
  /** 数据渠道（固定「新浪行情」） */
  channel: string;
  /** 取值日（上一交易日，YYYY-MM-DD） */
  date: string;
}

const QUOTE_API = "http://hq.sinajs.cn/list=";
const KLINE_API =
  "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData";

/** 本地格式化年月日（避免 toISOString 的 UTC 偏移导致跨时区少算一天）。 */
function fmtLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 上一交易日（跳过周末；不含法定节假日，足够日常使用）。
 *  用本地构造 + 本地格式化，规避 toISOString() 在 GMT+8 下少算一天（曾导致取值日错成周日、A股涨跌幅缺失）。 */
export function prevTradingDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(y, m - 1, d);
  do {
    dt.setDate(dt.getDate() - 1);
  } while (dt.getDay() === 0 || dt.getDay() === 6);
  return fmtLocal(dt);
}

function fmtNum(v: string): string {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return v;
  return n.toFixed(2);
}
function fmtPct(v: string): string {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return "";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

async function fetchText(url: string, referer = "https://finance.sina.com.cn/"): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { Referer: referer } });
    if (!res.ok) {
      console.warn(`[quote] HTTP ${res.status} ${url}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(`[quote] 抓取失败 ${url}: ${(e as Error).message}`);
    return null;
  }
}

/** 取 A股单指数「上一交易日」涨跌幅（昨收 vs 前收）。 */
async function aShareChangePct(klineSymbol: string, targetDay: string): Promise<string | undefined> {
  const text = await fetchText(`${KLINE_API}?symbol=${klineSymbol}&scale=240&ma=no&datalen=8`);
  if (!text) return undefined;
  try {
    const arr = JSON.parse(text) as Array<{ day: string; close: string }>;
    const idx = arr.findIndex((k) => k.day === targetDay);
    if (idx <= 0) return undefined;
    const yest = parseFloat(arr[idx].close);
    const prev = parseFloat(arr[idx - 1].close);
    if (!yest || !prev) return undefined;
    return fmtPct((((yest - prev) / prev) * 100).toFixed(2));
  } catch {
    return undefined;
  }
}

export async function fetchMarketQuotes(quoteDate: string): Promise<QuoteResult | null> {
  const allCodes = [...A_SHARE_DEFS, ...HK_DEFS, ...US_DEFS].map((d) => d.code).join(",");
  const text = await fetchText(QUOTE_API + allCodes);
  if (!text) return null;

  const parseOne = (code: string): string[] | null => {
    const m = text.match(new RegExp(`hq_str_${code}="([^"]*)"`));
    return m ? m[1].split(",") : null;
  };

  const aShare: IndexQuote[] = [];
  for (const d of A_SHARE_DEFS) {
    const f = parseOne(d.code);
    // A股：f[2] = 昨收（上一交易日收盘，恒定正确）
    if (f && f[2]) {
      const changePct = await aShareChangePct(d.kline, quoteDate);
      aShare.push({ name: d.name, value: fmtNum(f[2]), changePct });
    }
  }
  const hk: IndexQuote[] = [];
  for (const d of HK_DEFS) {
    const f = parseOne(d.code);
    // 港股：f[3] = 昨收；新浪无港股指数日 K，故不给涨跌幅（避免臆造）
    if (f && f[3]) hk.push({ name: d.name, value: fmtNum(f[3]) });
  }
  const us: IndexQuote[] = [];
  for (const d of US_DEFS) {
    const f = parseOne(d.code);
    // 美股：f[1] = 最新收盘；f[2] = 涨跌幅（北京时间白天稳定 = 上一美股交易日）
    if (f && f[1]) us.push({ name: d.name, value: fmtNum(f[1]), changePct: f[2] ? fmtPct(f[2]) : undefined });
  }

  if (!aShare.length && !hk.length && !us.length) {
    console.warn(`[quote] 行情 API 未解析到任何指数`);
    return null;
  }
  console.log(
    `[quote] 行情 API 抓取成功：A股 ${aShare.length} / 港股 ${hk.length} / 美股 ${us.length}（取值日 ${quoteDate}）`,
  );
  return { quotes: { aShare, hk, us }, channel: "新浪行情", date: quoteDate };
}
