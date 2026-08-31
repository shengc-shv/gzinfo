/**
 * 广东地区IPO 板块（side-output，绕过相关性 LLM）。
 *
 * 背景（2026-08-30 实跑结论，CI run 33315502473 日志 line 828-829 证实）：
 *   gd-ipo 文章穿过 9 道过滤后，会被 runAiPipeline（相关性 LLM）整体丢弃——
 *   LLM 不把「ipo」当作有效 section 输出，导致线上 sections['ipo'] 恒为 0、
 *   口播「广东IPO=无」、页面 IPO 动态 tab 空。
 *
 * 修复：IPO 是「参考/结构板块」，应仿 buildStockRecap 直接从 filteredArticles
 * （gd-ipo / ipo 类目，已在 filter 阶段豁免跨天去重）构建 report.sections['ipo']，
 * 完全绕过相关性 LLM。与渲染侧 isGdIpoCandidate / 三道闸内容判定口径一致。
 *
 * 同时导出 buildGdIpoSpoken：确定性拼出口播稿（免 LLM，AI/SKIP_AI 双模式可用）。
 */

import type { ArticleInput, DailyReport, ReportItem } from "../../types";
import type { DailyContext } from "../context";
// 复用渲染侧广东IPO 内容判定（单一口径，避免两套正则漂移）
import { isGdIpoCandidate } from "../../output/render/cards";

/** IPO 类目（结构化爬虫产物：东财在审表 → gd-ipo；辅导备案/交易所权威源 → ipo）。 */
const IPO_CAT = new Set(["gd-ipo", "ipo"]);

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** ArticleInput（gd-ipo/ipo）→ ReportItem（字段对齐板块卡渲染）。 */
function toReportItem(a: ArticleInput): ReportItem {
  const pub = a.publishedAt ? new Date(a.publishedAt) : undefined;
  const mmdd = pub ? `${pad(pub.getMonth() + 1)}/${pad(pub.getDate())}` : "";
  const title = a.title_cn || a.title || "无标题";
  // IPO 是事实参考：summary 取爬虫 excerpt（已带「注册地/保荐/更新」）或标题占位
  const summary = (a.summary || a.excerpt || title).slice(0, 90).trim() || title;
  const tier = a.tier;
  return {
    url: a.url || "",
    title_cn: title,
    title_orig: a.title_cn ? a.title : undefined,
    source: a.source || "",
    source_type: tier === "T1" || tier === "T1.5" ? "official" : "media",
    tier,
    date: mmdd,
    summary,
    importance: 2,
    rank: 0,
    // 广东 IPO 打「粤」标（渲染徽章；口播识别用），全国 ipo 不打
    tags: a.category === "gd-ipo" ? ["粤"] : [],
    locale: "national",
  };
}

/** MM/DD → 可比数值（越新越大），用于板块内按时间倒序。 */
function dateValue(it: ReportItem): number {
  const m = it.date.match(/^(\d{2})\/(\d{2})$/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

/**
 * 把今日 filteredArticles 中的 gd-ipo / ipo 文章直接构建进 report.sections['ipo']，
 * 与 mergeRollingIntoReport 已并入的滚动历史 IPO 条目按 url 去重合并且今日优先。
 * 返回新 report（不 mutate）。无当日 IPO 命中 → 原样返回（保留滚动并入的）。
 */
export function buildGdIpo(
  report: DailyReport,
  filteredArticles: ArticleInput[],
  ctx: DailyContext,
): DailyReport {
  const today = filteredArticles.filter((a) => IPO_CAT.has(a.category ?? ""));
  if (today.length === 0) {
    ctx.log.info("gd-ipo", "ℹ️ 今日 filteredArticles 无 gd-ipo/ipo 命中，保留滚动并入的 IPO 板块");
    return report;
  }
  const newItems = today.map(toReportItem).sort((x, y) => dateValue(y) - dateValue(x));
  const existing = report.sections?.ipo ?? [];
  const seen = new Set(existing.map((i) => i.url));
  const merged: ReportItem[] = [...existing];
  for (const it of newItems) {
    if (!it.url || !seen.has(it.url)) {
      merged.push(it);
      if (it.url) seen.add(it.url);
    }
  }
  merged.sort((x, y) => dateValue(y) - dateValue(x));
  merged.forEach((it, i) => (it.rank = i + 1));
  ctx.log.info(
    "gd-ipo",
    `🏦 广东IPO板块构建：${newItems.length} 条今日 + ${existing.length} 条滚动 = ${merged.length} 条（绕过相关性 LLM）`,
  );
  return { ...report, sections: { ...report.sections, ipo: merged } };
}

/**
 * 口播稿需要的广东 IPO 企业属性提取（全部确定性、免 LLM）：
 *  - 注册地：从 summary「注册地：XX」抽取（东财在审表 excerpt 已带，如「注册地：广东」）
 *  - 上市地：从 title「（拟XX板块）」抽板块名 → 映射为 深交所/北交所/上交所/境外
 *  - 行业：公司名关键词推断（东财接口无行业字段，且本环境被 WAF 拦截无法补采；
 *          关键词推断确定性、永不缺，契合 side-output 免 LLM 设计）
 *  - 进展：title「：」后 / summary「状态：」后（IPO已受理 / 问询中 / 注册生效 …）
 */

/** 公司名（去掉「（拟XX）」「[派出机构]」等修饰）。 */
function companyNameOf(title: string): string {
  const head = title.split("：")[0] || title;
  return head
    .replace(/[（(][^）)]*[)）]/g, "")
    .replace(/[【\[][^】\]]*[\]】]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 注册地：summary「注册地：广东」→ "广东"。 */
function parseRegisteredProvince(summary: string): string {
  const m = summary.match(/注册地[:：]\s*([^｜|]+)/);
  return m ? m[1].trim() : "";
}

/** 拟上市板块：title「（拟创业板）」→ "创业板"。 */
function parseBoard(title: string): string {
  const m = title.match(/拟\s*([^）)]+?)\s*[）)]/);
  return m ? m[1].trim() : "";
}

/** 板块 → 交易所（用户口径：深交/北交/上交/境外）。 */
function mapBoardToExchange(board: string): string {
  if (/北交|新三板/.test(board)) return "北交所";
  if (/创业|深主|深市|中小/.test(board)) return "深交所";
  if (/科创|沪主|沪市/.test(board)) return "上交所";
  if (/港|H股|红筹|HK/i.test(board)) return "境外（港股）";
  if (/美|NASDAQ|NYSE/i.test(board)) return "境外（美股）";
  if (/A股|主板/.test(board)) return "A股";
  return "";
}

/** 行业：公司名关键词推断（优先级从高到低）。 */
const INDUSTRY_RULES: Array<[RegExp, string]> = [
  [/半导体|芯片|集成电路|IC/i, "半导体"],
  [/生物|医药|制药|医疗|基因|疫苗|器械/i, "医药生物"],
  [/新材料|化工|化学|高分子/i, "化工新材料"],
  [/新能|锂电|光伏|储能|电池|电气|充电|电力/i, "新能源"],
  [/智能|机器人|自动化|人工|软件|数据|云|信息|网络|科技|电子|光电|通信|计算/i, "科技"],
  [/汽车|轮胎|零部件/i, "汽车"],
  [/装备|机械|重工|机床/i, "装备制造"],
  [/食品|饮料|农|牧|渔|酒|乳|糖/i, "食品饮料"],
  [/金融|证券|银行|保险|基金|资本|投资/i, "金融"],
  [/传媒|文化|影|视|游戏|出版|教育/i, "文化传媒"],
  [/地产|置业|建|筑|装饰|物业|园林/i, "房地产建筑"],
  [/物流|运|航|港|铁路|交通/i, "物流运输"],
  [/纺|服|鞋|皮革/i, "纺织服装"],
  [/钢铁|金属|矿|有色/i, "金属冶炼"],
];

function inferIndustry(company: string): string {
  for (const [re, name] of INDUSTRY_RULES) {
    if (re.test(company)) return name;
  }
  return "";
}

/** 进展：title「：」后（至括号前）/ summary「状态：」后。 */
function progressOf(title: string, summary: string): string {
  const t = title.match(/：\s*([^（(]+)/);
  if (t) return t[1].trim();
  const s = summary.match(/状态[:：]\s*([^｜|]+)/);
  return s ? s[1].trim() : "";
}

/**
 * 确定性口播稿（免 LLM）：从 IPO 板块条目中挑广东企业（「粤」标或 isGdIpoCandidate），
 * 取前 2 条，每条带出 注册地 / 行业 / 上市地 / 最新进展，拼成口播。
 * 口播字数上限交由 audio.ts 的 AUDIO_SPEAK_LIMITS.ipo 统一截断（含属性后放宽到 ~100 字）。
 * audio.ts 在 exec.guangdong_ipo.spoken 缺失时调用，保证 AI / SKIP_AI 两种模式口播都能覆盖。
 */
export function buildGdIpoSpoken(items: ReportItem[]): string {
  const cand = items.filter(
    (it) => it.tags?.includes("粤") || isGdIpoCandidate(it.title_cn || "", it.summary || ""),
  );
  if (cand.length === 0) return "";
  const head = cand.slice(0, 2);
  const clauses = head.map((it) => {
    const title = it.title_cn || "";
    const summary = it.summary || "";
    const company = companyNameOf(title);
    const prov = parseRegisteredProvince(summary);
    const exchange = mapBoardToExchange(parseBoard(title));
    const industry = inferIndustry(company);
    const progress = progressOf(title, summary);
    const parts = [company];
    if (prov) parts.push(`注册地${prov}`);
    if (industry) parts.push(`${industry}行业`);
    if (exchange) parts.push(`拟在${exchange}IPO`);
    if (progress) parts.push(`目前${progress}`);
    return parts.join("，");
  });
  let s = clauses.join("；");
  // 多于 2 家时收尾「等N家」，避免口播听起来像只有这两家
  if (cand.length > 2) s += `；等${cand.length}家`;
  return s;
}
