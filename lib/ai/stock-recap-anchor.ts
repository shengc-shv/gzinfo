/**
 * 收评锚定（2026-09-05 用户拍板）
 *
 * 背景：原实现把三市场各 12 条新闻标题一次性塞给 LLM，让它「解读」出复盘卡。
 * 实测问题：
 *  1. 标题池混了两天的条目（pub = 行情取值日 D-1 与 抓取日 D），LLM 分不清哪些是收盘数据；
 *  2. 三组市场同处一个 prompt，A股卡曾写出「特斯拉跌近6%」这类美股内容（跨市场串味）；
 *  3. LLM 实质是在复述收评标题（新浪「港股收评：恒指涨1.74% 科指涨2.27% 科网股普涨…」
 *     ↔ LLM overview「恒指收涨1.74%…科网股普涨联想涨超6%」几乎逐字对应），
 *     花一次调用只为把权威源已经写好的结论改写一遍。
 *
 * 方案：**收评锚定** —— A股/港股若能在条目中找到「发布日 == 行情取值日」的收评，
 * 就用确定性解析直接产出复盘卡（零 LLM、零幻觉、数字来自行情 API），
 * 找不到才回退 LLM。**收评与行情取值日强绑定**（用户明确要求二者是同一天，
 * 不得独立去捞），避免拿错日期的收评配今天的收盘数字。
 *
 * 设计红线：
 *  - 只在「收评发布日 === quotes.date」时锚定，日期对不上宁可回退 LLM；
 *  - 解析出有效要点 < 2 条视为信息不足，回退 LLM（宁缺毋滥，与既有兜底口径一致）；
 *  - 术语映射只做**展开**（科指→恒生科技指数），不改变事实、不补数字；
 *  - overview 一律用行情 API 权威数字合成，与卡片指数块口径完全一致。
 */

import type { MarketCard } from "../types";
import type { IndexQuote } from "../sources/quote-api";
import type { StockItem } from "./stock-recap";

/** 收盘类标题（锚定候选）。 */
const RECAP_RE = /收评|收盘|收市|盘后|复盘|综述|收盘播报|收盘点评|市场总结|大势研判/;
/** 盘中类：午评/早盘/盘中/开盘是**盘中快照**，不是收盘数据，必须排除（曾误配午评）。 */
const INTRADAY_RE = /午评|早盘|盘中|开盘|半日/;

/** 营销号/无信息噪声：堆 6 位股票代码、多感叹号、诱导词。
 *  注意：单个「！」不杀（如「北水净买入港股近41亿港元！」是有信息量的资金复盘）。 */
const NOISE_RE = /\d{6}|点击查看|突发利好|主力进场|涨停敢死|(?:\S!){2,}|(?:！\S*){2,}/;

/** 术语展开（只展开缩写，不改事实）：让客户听得懂「科指」是恒生科技指数。 */
const TERM_MAP: Array<[RegExp, string]> = [
  [/科创综指/g, "科创综指"],
  [/科指/g, "恒生科技指数"],
  [/恒指/g, "恒生指数"],
  [/沪指/g, "上证指数"],
  [/深成指/g, "深证成指"],
  [/创指/g, "创业板指"],
  [/两市/g, "沪深两市"],
  [/北水/g, "南向资金"],
  [/南水/g, "北向资金"],
];

function expandTerms(s: string): string {
  let out = s;
  for (const [re, to] of TERM_MAP) out = out.replace(re, to);
  return out;
}

/** 判断是否为「收盘类」标题（排除盘中类）。 */
export function isRecapTitle(title: string): boolean {
  if (!title) return false;
  if (INTRADAY_RE.test(title)) return false;
  return RECAP_RE.test(title);
}

/** 取条目发布日 YYYY-MM-DD（兼容 Date / ISO 字符串）。 */
function pubDay(it: StockItem): string {
  const p = it.publishedAt;
  if (!p) return "";
  const s = typeof p === "string" ? p : (p as unknown as Date).toISOString?.() ?? "";
  return s.slice(0, 10);
}

/**
 * 挑锚定收评：**发布日必须等于行情取值日**（用户：收评与收盘数据是绑定的）。
 * 同日多条时取信息量更高的（要点片段多者优先，其次标题长者）。
 * @param quoteDate 行情取值日（YYYY-MM-DD）；为空表示无行情 → 无法绑定，返回 undefined 回退 LLM。
 */
/**
 * 按优先级列出全部锚定候选（发布日 === 行情取值日）。
 * 排序：全市场收评（收评/盘后/复盘/综述）> 板块级播报 > 要点多者 > 标题长者。
 * @param quoteDate 行情取值日（YYYY-MM-DD）；为空表示无行情 → 无法绑定，返回空数组。
 */
export function rankRecapAnchors(items: StockItem[], quoteDate?: string): StockItem[] {
  if (!quoteDate) return [];
  const cands = items.filter((it) => isRecapTitle(it.title) && pubDay(it) === quoteDate);
  const clauseCount = (t: string) => splitClauses(t).length;
  /** 全市场收评优先于板块级播报（「科创板收盘播报」只覆盖科创板） */
  const scope = (t: string) => (/收评|盘后|复盘|综述/.test(t) ? 2 : 1);
  return [...cands].sort(
    (a, b) =>
      scope(b.title) - scope(a.title) ||
      clauseCount(b.title) - clauseCount(a.title) ||
      b.title.length - a.title.length,
  );
}

/** 取首选锚定收评（同日多条时取信息量最高者）；无候选返回 undefined。 */
export function pickRecapAnchor(
  items: StockItem[],
  quoteDate?: string,
): StockItem | undefined {
  return rankRecapAnchors(items, quoteDate)[0];
}

/** 去掉「港股收评：」「资金复盘 | 」等前缀，再按中英文逗号/分号/句号/空白切成要点片段。
 *  注意：**顿号「、」不作分隔符** —— 它用于并列（「培育钻石、保险、贵金属板块表现活跃」），
 *  切开会产生「保险」这类无谓语的碎片。 */
export function splitClauses(title: string): string[] {
  const body = title.replace(/^[^：:|｜]{0,14}[：:|｜]\s*/, "");
  return body
    .split(/[，,；;。\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 收评 vs 行情一致性校验（2026-09-05 加）。
 *
 * 实测：正常日两者**精确一致**（09-05 收评「恒指涨1.74% 科指涨2.27%」↔ 行情 +1.74%/+2.27%）。
 * 但发现既有错位：09-03/09-04 两天的港股 indices 完全相同（25213.31 / -0.39%），
 * quoteDate 却分别是 09-02、09-03 —— 根因是 quote-api 的已知约束：「港股 f[6] 需盘前/盘后跑
 * 才是目标交易日收盘」，晚间重跑会拿到**当天新收盘**却仍标为上一交易日。
 * 若此时 overview 用行情、sectors 用收评，客户会看到同一张卡里两个矛盾数字。
 * 故：数字对不上时**以收评为真**（收评发布日期已与取值日绑定，可信度更高）。
 */
const INDEX_ALIASES = [
  "恒生科技指数",
  "恒生科技",
  "恒生指数",
  "上证指数",
  "深证成指",
  "创业板指",
  "科创50",
  "沪深300",
];
const UP_RE = /涨|走强|反弹|拉升|上扬|高走/;
const DOWN_RE = /跌|走弱|下挫|回落|下探|低走/;

/** 取片段中**最后一个**方向词（中文收评结论在句尾：「高开低走跌2.10%」→ 跌）。 */
function directionOf(s: string): 1 | -1 | 0 {
  const re = new RegExp(`(${UP_RE.source})|(${DOWN_RE.source})`, "g");
  let dir: 1 | -1 | 0 = 0;
  for (const m of s.matchAll(re)) dir = m[1] ? 1 : -1;
  return dir;
}

/** 从收评片段提取「指数名 + 涨跌幅」对。 */
export function extractIndexPcts(clauses: string[]): Array<{ name: string; pct: number }> {
  // 指数名与数字间可夹「指数高开低走跌」等描述（最长约 8 字），故放宽到 10
  const re = new RegExp(`(${INDEX_ALIASES.join("|")})[^%]{0,10}?(\\d+(?:\\.\\d+)?)\\s*%`, "g");
  const out: Array<{ name: string; pct: number }> = [];
  for (const c of clauses) {
    const dir = directionOf(c);
    if (!dir) continue;
    for (const m of c.matchAll(re)) out.push({ name: m[1], pct: dir * parseFloat(m[2]) });
  }
  return out;
}

/** 收评与行情指数涨跌幅是否冲突（差异 > 0.05 个百分点即认为行情取值日错位）。 */
export function hasIndexConflict(clauses: string[], quotes?: IndexQuote[]): boolean {
  if (!quotes || quotes.length === 0) return false;
  for (const rp of extractIndexPcts(clauses)) {
    const q = quotes.find((x) => x.name.includes(rp.name) || rp.name.includes(x.name));
    if (!q?.changePct) continue;
    const qp = parseFloat(q.changePct);
    if (Number.isFinite(qp) && Math.abs(qp - rp.pct) > 0.05) return true;
  }
  return false;
}

/** 用行情指数合成 overview（与 synthesizeFallbackCard 完全同口径，保证卡片/口播一致）。 */
function overviewFromQuotes(quotes?: IndexQuote[]): string {
  if (!quotes || quotes.length === 0) return "";
  return (
    quotes
      .map((q) => `${q.name}收报${q.value}点${q.changePct ? `（${q.changePct}）` : ""}`)
      .join("；") + "。"
  );
}

/**
 * 从收评标题确定性解析复盘卡。
 * @returns 解析成功返回卡；信息不足（有效要点 < 2）返回 null → 调用方回退 LLM。
 */
export function parseRecapCard(
  anchor: StockItem,
  quotes?: IndexQuote[],
): MarketCard | null {
  const clauses = splitClauses(anchor.title)
    // 过滤营销噪声 + 标题被爬虫截断的残片（「半导体股多」= 原文「多数下跌」被截断）
    .filter((c) => c.length >= 4 && !NOISE_RE.test(c) && !/(^|[^\d])(多|少)$/.test(c))
    .map(expandTerms);
  if (clauses.length < 2) return null;
  const sectors = clauses.slice(0, 5);
  // 行情取值日错位守护：数字自相矛盾时以收评为真（详见 hasIndexConflict 注释）
  if (hasIndexConflict(clauses, quotes)) {
    console.warn(
      `[recap] ⚠️ 收评与行情指数涨跌幅不一致（疑似行情取值日错位），overview 改用收评数字`,
    );
    // 用收评里所有「指数+涨跌幅」片段拼 overview，保住信息量（不只是首句）
    const idxClauses = clauses.filter((c) => extractIndexPcts([c]).length > 0);
    const overview = (idxClauses.length ? idxClauses.join("，") : clauses[0]) + "。";
    return { overview, sectors };
  }
  // overview：优先行情权威数字（与卡内指数块同源），无指数才退回收评首段
  const overview = overviewFromQuotes(quotes) || clauses[0];
  return { overview, sectors };
}

/** 便捷入口：按行情取值日锚定 + 解析；逐个尝试候选，全失败返回 null（调用方回退 LLM）。 */
export function anchorRecapCard(
  items: StockItem[],
  quotes?: { date?: string; list?: IndexQuote[] },
): MarketCard | null {
  for (const anchor of rankRecapAnchors(items, quotes?.date)) {
    const card = parseRecapCard(anchor, quotes?.list);
    if (card) return card;
  }
  return null;
}
