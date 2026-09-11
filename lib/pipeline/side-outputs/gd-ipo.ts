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
import { isGdIpoCandidate, IPO_CAPITAL_ACT_RE, IPO_FLOW_RE } from "../../output/render/cards";
import { inferStage, isGdStage, type GdStage } from "../../classify/gdIpo";
import { todayKey } from "../../utils";
// P2-3 收敛（2026-09-10）：窗口常量统一来自 lib/ipo-config.ts（此前本文件与
// memory/event-memory.ts 各定义一份 IPO_VOICE_WINDOW_DAYS，改一处不生效）。
import { IPO_VOICE_WINDOW_DAYS, IPO_LIST_WINDOW_DAYS } from "../../ipo-config";

/** IPO 类目（结构化爬虫产物：东财在审表 → gd-ipo；辅导备案/交易所权威源 → ipo）。 */
const IPO_CAT = new Set(["gd-ipo", "ipo"]);

/**
 * 是否属于「广东 IPO 事件」——本板块的**内容判定**入口（无状态源红线）：
 *  ① 结构化类目命中（官方爬虫产物）；或
 *  ② 内容判定命中（媒体源即时报道的「证监会同意粤芯半导体IPO注册」等，官方源漏抓时补位）。
 * 两种来源都必须排除「已上市公司资本运作公告」（定增/解禁/回购…），否则会污染 IPO 板块。
 */
function isIpoArticle(a: ArticleInput): boolean {
  const title = a.title_cn || a.title || "";
  const text = `${title} ${a.excerpt || ""}`;
  if (IPO_CAPITAL_ACT_RE.test(text) && !IPO_FLOW_RE.test(text)) return false;
  if (IPO_CAT.has(a.category ?? "")) return true;
  return isGdIpoCandidate(title, a.excerpt || "");
}

/** 本条是否应打「粤」标（广东商机身份；口播识别与横滑候选依赖它）。 */
function isGdIpoArticle(a: ArticleInput): boolean {
  if (a.category === "gd-ipo") return true; // 官方广东源（region=gd 路由产物）
  return isGdIpoCandidate(a.title_cn || a.title || "", a.excerpt || "");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 展示/口播窗口（日差，含今天）——2026-09-10 用户拍板口径：
 *   - **口播 + 今日必读横滑 = 2 天**（`IPO_VOICE_WINDOW_DAYS`）：只播最新动向；
 *   - **底部「广东IPO动态」列表 = 7 天**（`IPO_LIST_WINDOW_DAYS`）：与源层 7 天窗对齐
 *     （szse-audit.IPO_SOURCE_WINDOW_DAYS / csrcfd.CSRC_WINDOW_DAYS / sse-audit）。
 *
 * 口径 = **日差 ≤ N**（今天往前 N 天，即今天-N ~ 今天）。用户实锤：上交所主板
 * 「广东龙行天下」（updateDate 09-03，相对 09-10 日差恰为 7）必须在列表内 —— 旧的
 * 「含今天共 N 个日历日」（今天-N+1 起）会把它卡在窗外。
 */
// 常量定义已迁至 lib/ipo-config.ts（P2-3 收敛）；此处 re-export 保持既有 import 路径可用。
export { IPO_VOICE_WINDOW_DAYS, IPO_LIST_WINDOW_DAYS };

/**
 * 近 N 天（日差 ≤ N，含今天，按报告时区 REPORT_TZ）的 MM/DD 集合 → N+1 个日历日。
 * ReportItem.date 只有 MM/DD（无年份），故按 MM/DD 判定；跨元旦的边界日可能多算 1 天，
 * 属可接受近似（与既有 dateValue 排序同源口径）。
 */
function recentMmddSet(days: number): Set<string> {
  const out = new Set<string>();
  const base = new Date(`${todayKey()}T00:00:00Z`);
  for (let i = 0; i <= days; i++) {
    const d = new Date(base.getTime() - i * 86_400_000);
    out.add(`${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`);
  }
  return out;
}

/**
 * IPO 卡结构化副信息（P2-5）：保荐 / 拟上市板块 / 受理日。
 *
 * 动机：`summary` 走板块卡通用 90 字截断（渲染再截到 50 字），而爬虫 excerpt 是
 * 「注册地｜保荐｜受理｜状态｜更新｜行业」的长串 → **更新日与后段字段必被吞掉**
 * （实测：钶锐锶卡片看不到「更新：2026-09-07」）。故把需要展示的字段单独拎出来，
 * 不依赖截断；`summary` 保持原样（口播的 `parseRegisteredProvince`/`progressOf` 依赖它）。
 */
export function buildIpoMeta(title: string, excerpt: string): string {
  const parts: string[] = [];
  const sponsor = excerpt.match(/保荐[:：]\s*([^｜|]+)/)?.[1]?.trim();
  if (sponsor) parts.push(`保荐 ${sponsor}`);
  const board = parseBoard(title);
  if (board) parts.push(`拟上市${board}`);
  const accept = excerpt.match(/受理[:：]\s*([^｜|]+)/)?.[1]?.trim();
  if (accept) parts.push(`受理 ${accept}`);
  return parts.join(" ｜ ");
}

/** ArticleInput（gd-ipo/ipo）→ ReportItem（字段对齐板块卡渲染）。 */
function toReportItem(a: ArticleInput): ReportItem {
  const pub = a.publishedAt ? new Date(a.publishedAt) : undefined;
  const mmdd = pub ? `${pad(pub.getMonth() + 1)}/${pad(pub.getDate())}` : "";
  const title = a.title_cn || a.title || "无标题";
  // IPO 是事实参考：summary 取爬虫 excerpt（已带「注册地/保荐/更新」）或标题占位
  const source = a.summary || a.excerpt || title;
  const summary = source.slice(0, 90).trim() || title;
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
    // P0-1 结构透传（此前在 side-output 边界丢失 → 渲染退回标题正则，同卡自相矛盾）
    ...(isGdStage(a.ipoStage) ? { ipoStage: a.ipoStage } : {}),
    ...(a.listedDate ? { listedDate: a.listedDate } : {}),
    ...(a.officialUrl ? { officialUrl: a.officialUrl } : {}),
    ...(a.officialLabel ? { officialLabel: a.officialLabel } : {}),
    ...(a.gdBasis ? { gdBasis: a.gdBasis } : {}),
    ...(a.excerpt ? { ipoMeta: buildIpoMeta(title, a.excerpt) } : {}),
    // IPO 卡片地域标记：注册城市（替代「粤」展示，不影响 tags）
    ...(isGdIpoArticle(a) ? { ipoCity: ipoCityOf(a) } : {}),
    importance: 2,
    rank: 0,
    // 广东 IPO 打「粤」标（渲染徽章；口播识别用），全国 ipo 不打
    tags: isGdIpoArticle(a) ? ["粤"] : [],
    locale: "national",
  };
}

/** MM/DD → 可比数值（越新越大），用于板块内按时间倒序。 */
function dateValue(it: ReportItem): number {
  const m = it.date.match(/^(\d{2})\/(\d{2})$/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

/**
 * IPO 阶段**进度**排序权重（P4-④）：越接近上市越靠前（与 BIZ_VALUE_RANK 的商机优先序相反）。
 * 阶段值一律经 `gdIpoStageOf` / `inferStage` 单一判定取得，本表只做权重映射。
 */
const STAGE_RANK: Record<string, number> = {
  "stage-listed": 4,
  "stage-registered": 3,
  "stage-reviewing": 2,
  "stage-tutoring": 1,
};

/** ArticleInput 的阶段进度权重（结构化字段优先，回退 inferStage 单一词表）。 */
function stageRankOfArticle(a: ArticleInput): number {
  const stage = isGdStage(a.ipoStage)
    ? a.ipoStage
    : inferStage(a.title_cn || a.title || "", a.excerpt || "");
  return STAGE_RANK[stage] ?? 0;
}

/** ReportItem 的阶段进度权重（经 gdIpoStageOf，与分栏/徽章同一判定）。 */
function stageRankOfItem(it: ReportItem): number {
  return STAGE_RANK[gdIpoStageOf(it)] ?? 0;
}

/**
 * 把今日 filteredArticles 中的广东 IPO 文章直接构建进 report.sections['ipo']，
 * 与 mergeRollingIntoReport 已并入的滚动历史 IPO 条目按 url 去重合并且今日优先。
 * 返回新 report（不 mutate）。无当日 IPO 命中 → 原样返回（保留滚动并入的）。
 *
 * 入池口径（P1-3 修复，2026-09-10 回检）：**不再只看 category**——媒体源即时报道的
 * 「证监会同意粤芯半导体IPO注册」这类事件走 `isGdIpoCandidate` 内容判定补位
 * （东财/交易所状态滞后时的官方漏抓兜底）。已上市公司资本运作公告仍被排除。
 *
 * P4-④ 企业级去重：今日多源（如 SSE 审核 + 辅导备案）可能报同一家企业，按「归一化企业名」
 * 归并，保留阶段最靠前（最该跟进）或最新的一条，避免一家企业重复占卡。
 * P4-① 结构化阶段：排序优先按阶段进度（gdIpoStageOf 单一判定），其次按日期。
 */
export function buildGdIpo(
  report: DailyReport,
  filteredArticles: ArticleInput[],
  ctx: DailyContext,
): DailyReport {
  const today = filteredArticles.filter(isIpoArticle);
  if (today.length === 0) {
    ctx.log.info("gd-ipo", "ℹ️ 今日 filteredArticles 无 gd-ipo/ipo 命中，保留滚动并入的 IPO 板块");
    return report;
  }

  // 企业级去重：归一化企业名 → 保留阶段最前 / 最新的一条
  const byCompany = new Map<string, ArticleInput>();
  for (const a of today) {
    const key = companyNameOf(a.title_cn || a.title || "") || a.url || "";
    const prev = byCompany.get(key);
    if (
      !prev ||
      stageRankOfArticle(a) > stageRankOfArticle(prev) ||
      (stageRankOfArticle(a) === stageRankOfArticle(prev) &&
        dateValue(toReportItem(a)) > dateValue(toReportItem(prev)))
    ) {
      byCompany.set(key, a);
    }
  }

  const newItems = [...byCompany.values()]
    .map(toReportItem)
    .sort((x, y) => dateValue(y) - dateValue(x));

  const existing = report.sections?.ipo ?? [];
  const seen = new Set(existing.map((i) => i.url));
  const merged: ReportItem[] = [...existing];
  for (const it of newItems) {
    if (!it.url || !seen.has(it.url)) {
      merged.push(it);
      if (it.url) seen.add(it.url);
    }
  }
  // P4-① 阶段进度优先 + 日期倒序：同一企业不同阶段（url 含 @状态）均保留且最前阶段置顶
  merged.sort((x, y) => {
    const rx = stageRankOfItem(x) - stageRankOfItem(y);
    return rx !== 0 ? rx : dateValue(y) - dateValue(x);
  });
  merged.forEach((it, i) => (it.rank = i + 1));
  ctx.log.info(
    "gd-ipo",
    `🏦 广东IPO板块构建：${newItems.length} 条今日(去重前${today.length}) + ${existing.length} 条滚动 = ${merged.length} 条（绕过相关性 LLM）`,
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

/** 公司名（去掉「（拟XX）」「[派出机构]」等修饰）。导出供口播去重按企业归并。 */
export function companyNameOf(title: string): string {
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

/**
 * 注册城市：从 excerpt/summary 的「注册地：XX」提取城市（如 深圳市 / 广州市），
 * 供 IPO 卡片地域标记替代「粤」展示（2026-09-11）。
 *  - 全地址「注册地：广东深圳市」→ 深圳市；「注册地：广东省广州市番禺区」→ 广州市；
 *  - 仅省名（无城市）或缺失 → 回退「广东」。
 * 注意：只取展示用城市文案，不动 `tags:["粤"]`（音频识别 / 过滤 / exec-pool 仍依赖它）。
 */
function ipoCityOf(a: ArticleInput): string {
  const registered = parseRegisteredProvince(a.excerpt || a.summary || "");
  if (registered) {
    // 先去掉省前缀（「广东深圳市」→「深圳市」），避免贪心把「广东深圳」一并吞入
    const cleaned = registered.replace(/^广东省?/, "");
    const city = cleaned.match(/([\u4e00-\u9fa5]{2,4}市)/);
    if (city) return city[1];
    if (registered.includes("广东")) return "广东";
  }
  return "广东";
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
 * 取前 3 条（商机价值优先，与展示横滑卡同序同量），每条带出 注册地 / 行业 / 上市地 / 最新进展，拼成口播。
 * 口播字数上限交由 audio.ts 的 AUDIO_SPEAK_LIMITS.ipo 统一截断（含属性后放宽到 ~100 字）。
 * audio.ts 在 exec.guangdong_ipo.spoken 缺失时调用，保证 AI / SKIP_AI 两种模式口播都能覆盖。
 *
 * @param opts.skipCompanies 同一企业口播去重（2026-09-09）：命中者跳过，
 *   由 audio.ts 从事件记忆库（ipoVoicing）按「2 天窗口」算出。展示卡面不受影响。
 * @param opts.withinDays 口播候选窗口（日历日，含今天），默认 `IPO_VOICE_WINDOW_DAYS`=2
 *   （用户 2026-09-10：进入口播只播 2 天内）。
 */
export function buildGdIpoSpoken(
  items: ReportItem[],
  opts?: { skipCompanies?: Set<string>; withinDays?: number },
): string {
  const cand = gdIpoCandidates(
    items,
    opts?.skipCompanies,
    opts?.withinDays ?? IPO_VOICE_WINDOW_DAYS,
    { uniqueCompany: true }, // 口播不把同一家企业念两遍（P1-4）
  );
  if (cand.length === 0) return "";
  const head = cand.slice(0, 3);
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
  // 多于 3 家时收尾「等N家」，避免口播听起来像只有这 3 家
  if (cand.length > 3) s += `；等${cand.length}家`;
  return s;
}

/**
 * IPO 阶段 → 商机价值权重（任务六·广东IPO商机优先排序）：
 * 辅导备案/Pre-IPO（最佳商机）> 注册生效/过会 > 在审/受理 > 已上市（已兑现，商机偏后）。
 * render 横滑卡与 audio 口播共用此序，确保「展示卡片」与「口播」完全一致。
 */
export const BIZ_VALUE_RANK: Record<string, number> = {
  "stage-tutoring": 4,
  "stage-registered": 3,
  "stage-reviewing": 2,
  "stage-listed": 1,
  "": 0,
};

/** 「是否存在阶段信号」的粗筛词表：只判有无，不判归属（归属唯一由 inferStage 决定）。 */
const STAGE_HINT_RE =
  /注册|过会|核准|受理|问询|上会|审核|上市委|辅导|备案|招股|发行|申购|中签|挂牌|上市|pre-?ipo/i;

/**
 * ReportItem → IPO 阶段（**全链路唯一判定入口**，P0-1 收敛）。
 *
 * 优先级：
 *   ① 官方结构化字段 `it.ipoStage`（爬虫按交易所审核状态直接给出，最权威）；
 *   ② 否则回退 `inferStage` 关键词词表（与官方源同一张表，不再各维护一份）。
 *
 * 返回 `""` 表示「无阶段信号的 IPO 条目」——刻意**不**让 inferStage 的兜底值
 * （stage-tutoring）参与排序，否则无阶段信息的条目会被当成「最佳商机」顶到横滑前 3。
 * 此时分栏里归入「阶段待定」组（有数据才渲染）。
 *
 * 导出供渲染层（分栏 / 徽章 / 排序 / 筛选条）与测试共用。
 */
export function gdIpoStageOf(it: ReportItem): GdStage | "" {
  if (isGdStage(it.ipoStage)) return it.ipoStage;
  const title = it.title_cn || "";
  const summary = it.summary || "";
  if (!STAGE_HINT_RE.test(`${title} ${summary}`)) return "";
  return inferStage(title, summary);
}

/**
 * 广东 IPO 候选（「粤」标或 isGdIpoCandidate），按 skipCompanies 过滤，
 * 可选按 withinDays 限定「近 N 天」（含今天）——口播/今日必读传 2，底部列表传 7。
 * 按 商机价值优先 + 日期倒序 排序（不截断，供口播「等N家」计数）。
 *
 * @param opts.uniqueCompany 同企业只保留**商机价值最高**的一条（P1-4）。用于顶部 3 个
 *   稀缺横滑位与口播（避免同一企业两个阶段占 2 张卡 / 被念两遍）；底部完整列表传 false
 *   以保留「同企业不同阶段」的进展视角（用户既有口径）。
 */
export function gdIpoCandidates(
  items: ReportItem[],
  skip?: Set<string>,
  withinDays?: number,
  opts?: { uniqueCompany?: boolean },
): ReportItem[] {
  const allowed = withinDays && withinDays > 0 ? recentMmddSet(withinDays) : null;
  const sorted = items
    .filter(
      (it) =>
        (it.tags?.includes("粤") || isGdIpoCandidate(it.title_cn || "", it.summary || "")) &&
        !(skip && skip.has(companyNameOf(it.title_cn || ""))) &&
        (!allowed || allowed.has(it.date)),
    )
    .sort((x, y) => {
      const bx = BIZ_VALUE_RANK[gdIpoStageOf(y)] - BIZ_VALUE_RANK[gdIpoStageOf(x)];
      return bx !== 0 ? bx : dateValue(y) - dateValue(x);
    });
  if (!opts?.uniqueCompany) return sorted;
  const seenCompany = new Set<string>();
  return sorted.filter((it) => {
    const key = companyNameOf(it.title_cn || "") || it.url || "";
    if (seenCompany.has(key)) return false;
    seenCompany.add(key);
    return true;
  });
}

/**
 * 广东 IPO 展示/口播选中的 top-N（商机价值优先）；render 与 audio 共用确保一致。
 * 默认窗口 = 2 天（用户 2026-09-10：「进入口播是 2 天」）；底部列表显式传 `IPO_LIST_WINDOW_DAYS`。
 * @param opts.uniqueCompany 默认 true（3 个横滑位不被同企业占满，P1-4）。
 */
export function topGdIpo(
  items: ReportItem[],
  skip?: Set<string>,
  n = 3,
  withinDays: number = IPO_VOICE_WINDOW_DAYS,
  opts?: { uniqueCompany?: boolean },
): ReportItem[] {
  return gdIpoCandidates(items, skip, withinDays, {
    uniqueCompany: opts?.uniqueCompany ?? true,
  }).slice(0, n);
}

/**
 * 口播实际选中的企业名（前 3 家广东企业，经 skipCompanies 过滤后）。
 * 供 audio.ts 把「今日已口播企业」写回事件记忆库（ipoVoicing），实现跨天去重。
 */
export function pickGdIpoCompanies(
  items: ReportItem[],
  opts?: { skipCompanies?: Set<string>; withinDays?: number },
): string[] {
  return topGdIpo(
    items,
    opts?.skipCompanies,
    3,
    opts?.withinDays ?? IPO_VOICE_WINDOW_DAYS,
  ).map((it) => companyNameOf(it.title_cn || ""));
}
