/**
 * 行情 API 抓取（2026-08-27 升级：A 股 K 线改回新浪 + 港股改读 f[6]）
 *
 * 数据源：
 *  - A股：新浪 K线接口（money.finance.sina.com.cn）按目标交易日精确匹配，
 *    点位+涨跌幅一律走日K线 → 与抓取时刻彻底解耦，绝不错日
 *    （原计划用东方财富 push2his，CI/GA 跑出 Empty reply，放弃）
 *  - 港股：新浪 hq.sinajs.cn f[6]=最新价、f[3]=昨收；涨跌幅 = (f[6]-f[3])/f[3]
 *    **须盘前跑（CI 09:10），否则 f[6] 为盘中实时价，涨跌幅反映盘中而非昨日收盘**
 *  - 美股：新浪 hq.sinajs.cn f[1]=最新收盘、f[2]=涨跌幅（北京时间白天稳定 = 上一美股交易日）
 *
 * 任何一步失败均优雅降级（该市场/该卡缺字段，不阻断整页）。
 * 卡脚备注「数据来源：新浪行情 · 取值于 <目标交易日>」即用户要的「精准日期 + 渠道」。
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
/** 新浪 K线接口（2026-08-27 改回：东财 push2his CI 不可达）：按 symbol + scale=240(日线) + datalen=N。 */
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

/**
 * A股：新浪 K线取点位 + 涨跌幅（v2 升级：两者都走日K线）
 * kline 格式："YYYY-MM-DD,open,close,high,low,volume"
 *   - index 0: date
 *   - index 2: close
 * 涨跌幅 = (close - prev_close) / prev_close
 */
async function aShareFromKline(
  klineSymbol: string,
  targetDay: string,
): Promise<{ value: string; changePct?: string } | null> {
  const text = await fetchText(`${KLINE_API}?symbol=${klineSymbol}&scale=240&ma=no&datalen=8`);
  if (!text) return null;
  try {
    const arr = JSON.parse(text) as Array<{ day: string; close: string }>;
    const idx = arr.findIndex((k) => k.day === targetDay);
    if (idx <= 0) return null;
    const yest = parseFloat(arr[idx].close);
    const prev = parseFloat(arr[idx - 1].close);
    if (!yest || !prev) return null;
    const changePct = (((yest - prev) / prev) * 100).toFixed(2);
    return { value: yest.toFixed(2), changePct: fmtPct(changePct) };
  } catch {
    return null;
  }
}

export async function fetchMarketQuotes(quoteDate: string): Promise<QuoteResult | null> {
  const allCodes = [...A_SHARE_DEFS, ...HK_DEFS, ...US_DEFS].map((d) => d.code).join(",");
  const text = await fetchText(QUOTE_API + allCodes);
  if (!text) {
    // 即使新浪 hq 接口失败，也尝试 K 线（仅 A股）：K 线接口有自己独立的请求，
    // 至少 A股数据还能 fallback；港股/美股没 K 线 fallback → 返回 null
    const aShareKlineOnly: IndexQuote[] = [];
    for (const d of A_SHARE_DEFS) {
      const k = await aShareFromKline(d.kline, quoteDate);
      if (k) aShareKlineOnly.push({ name: d.name, value: k.value, changePct: k.changePct });
    }
    if (aShareKlineOnly.length) {
      console.log(`[quote] 仅 A股 K线 fallback：${aShareKlineOnly.length} 条（港股/美股无 fallback）`);
      return { quotes: { aShare: aShareKlineOnly, hk: [], us: [] }, channel: "新浪K线", date: quoteDate };
    }
    return null;
  }

  const parseOne = (code: string): string[] | null => {
    const m = text.match(new RegExp(`hq_str_${code}="([^"]*)"`));
    return m ? m[1].split(",") : null;
  };

  const aShare: IndexQuote[] = [];
  for (const d of A_SHARE_DEFS) {
    // A股：点位 + 涨跌幅一律走新浪日 K 线（按 targetDay 精确匹配，绝不错日）
    const k = await aShareFromKline(d.kline, quoteDate);
    if (k) aShare.push({ name: d.name, value: k.value, changePct: k.changePct });
  }
  const hk: IndexQuote[] = [];
  for (const d of HK_DEFS) {
    const f = parseOne(d.code);
    // 港股 hq 字段顺序（2026-08-28 实测，港股与 A股字段顺序不同）：
    //   f[0]=symbol  f[1]=name  f[2]=current  f[3]=prev_close（昨收）
    //   f[8]=changePct%  f[17]=date  f[18]=time
    // 取「昨日收盘」标准：f[3]（昨收点位）+ f[8]（API 直接给的涨跌幅）。
    // 注意：f[2] 是 current（盘前 = 昨收，但盘中 = 实时价），所以绝不能用 f[2] 算昨收。
    if (f && f[3] && f[8] !== undefined) {
      const yest = parseFloat(f[3]);
      const changePct = parseFloat(f[8]);
      if (yest && !Number.isNaN(changePct)) {
        hk.push({
          name: d.name,
          value: yest.toFixed(2),
          changePct: fmtPct(changePct.toFixed(2)),
        });
      }
    }
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
