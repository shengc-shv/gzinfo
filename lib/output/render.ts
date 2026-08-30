import type {
  ArticleInput,
  DailyReport,
  MarketCard,
  ReportInsight,
  ReportItem,
  ReportMustRead,
  ReportSectionKey,
  TradingSection,
} from "../types";
import type { WatchlistPick } from "../ai/trading-commentary";
import { REPORT_LOCALE,loadAllSources  } from "../sources/registry";
import { STR, SUBCATEGORY_ORDER, SUBCATEGORY_LABELS } from "./render/i18n";
import { SECTIONS, BANNED_WORDS } from "../ai/validator";
import { rollUpTags } from "../classify/tag-rollup";
import { titleSimilarityDice } from "../ingest/dedup-similar";
import {
  renderRawCategoryPanel,
  countItemsRecent,
  CATEGORY_LABELS,
  CATEGORY_DIGEST_LABELS,
  TECH_MAIN_SUBS,
  sortByTierAndTime,
  isGzLocalCandidate,
  isPolicyMarketCandidate,
  renderCardList,
  escapeHtml,
  type SourceGroup,
  type SubGroup,
  type RawByCategory,
} from "./render/cards";
import {
  renderTradingPanel,
  renderExecutiveSummary,
  TREND_LABEL,
} from "./render/sections";
export type { SourceGroup, SubGroup, RawByCategory } from "./render/cards";
import { TIER_COLORS, THEME_CSS } from "./render/theme";
import type { AudioMeta } from "../audio/audio";
import { selectTopMustRead } from "../ai/select-top";
// 分行相关性评分器（纯函数、不调 LLM）：用于「未打标历史条目」的并入门槛（2026-08-29 方案③）
import { scoreBranchRelevance } from "../ai/relevance-score";
import { generateAudioHighlightScript, AUDIO_HIGHLIGHT_CSS } from "../feedback/inline-script";
import { getReportTz } from "../utils";
import type { Category, SourceDef } from "../sources/types";
import { SOURCE_TIER_LABELS, type SourceTier } from "../sources/tiers";
import { CATEGORY_ORDER } from "../sources/constants";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { V2EX_OFF_TOPIC_RE } from "../sources/v2ex";
import type { TickerAnalysis } from "../trading/signals";
import {
  getAssetGroupLabels,
  ASSET_GROUP_ORDER,
  type AssetGroup,
} from "../trading/watchlist";
import { classifyGdIpo, inferStage, type GdIssuerRegistry } from "../classify/gdIpo";


// ----- types -----


// ----- labels & ordering -----

/**
 * 广州商机杂讯兜底词表（与 scripts/analyze-gz.ts 的 HEURISTIC_RULES 无关词表一致，
 * 生产验证过）。南沙/政府列表页会长期挂旧政策文件库存（电费补贴/招聘/摆卖/殡葬/
 * 诊所备案等），LLM 相关性分类偶有漏网——此词表在渲染层兜底过滤。
 */
const GZ_NOISE_RE =
  /历史建筑|门前三包|禁燃|黑烟|柴油货车|限行|交通管制|禁停|环境保护|生态|绿化|消防|防汛|水务|河道|畜牧|兽医|文物|非遗|民政局|街道办|居委会|司法厅|决定书|注销|律师|执业|行政许可|招聘|竞投|摆卖|摊位|路灯|景观照明|电费补贴|排污|噪声|拆迁补偿|工伤|教师资格|招生|赛事|演出|博物馆|公园|厕所|殡葬|诊所备案|欠薪|养犬|渔港|见义勇为|储备土地|低保|入学|气瓶/;

/**
 * 上位法传导规则（「包含关系」，2026-08-19 用户要求）：finance（宏观政策）板块的
 * 全国/省级政策条目，若标题命中广州业务线关键词，渲染时镜像到 广州商机(gz) 板块的
 * 对应业务线子标签——国家/省级变动必然传导到广州分行辖区，广州板块必须能看到这条信号；
 * 宏观政策板块原样保留，广州商机板块额外传导一条（同一 URL 双板块展示）。
 *
 * 词表与 scripts/analyze-gz.ts 的 HEURISTIC_RULES 第 2-6 条（业务线）保持一致，
 * 避免「宏观里判信贷、商机里判无关」的口径分裂。
 */
const GZ_CONDUCTION_RULES: Array<{ sub: string; re: RegExp }> = [
  { sub: "gz-wealth", re: /理财|基金|保险|黄金|财富|资产配置|私人银行|代销|AUM|信托/ },
  { sub: "gz-credit", re: /信贷|贷款|房贷|消费贷|经营贷|按揭|公积金|利率|首付|融资担保/ },
  { sub: "gz-customer", re: /社零|消费|零售|居民|收入|人口|就业|物价|CPI|民生|储蓄|存款|支付|商圈|市场运行/ },
  { sub: "gz-private", re: /家族|股权|企业主|专精特新|半导体|集成电路|生物医药|高端制造|人工智能|芯片|知识产权|补贴|兑现|产业扶持|招商引资|独角兽/ },
];

/** 命中哪些广州业务线子标签（可多值：同一条上位政策可能影响多个业务线）。 */
export function conductToGzSubs(title: string): string[] {
  return Array.from(new Set(GZ_CONDUCTION_RULES.filter((r) => r.re.test(title)).map((r) => r.sub)));
}

/**
 * 全国业务线子标签（2026-08-21 用户：从宏观政策面板移入广州商机面板）：
 * finance 文章命中这些 subcategory 时改写 category=gz 进入广州商机面板的
 * 单一合并流（gz-all），由渲染层按权威等级拆「官方 / 媒体」tab。
 * 映射到业务线 id 仅为保留原业务线信息（渲染不再按业务线分桶）。
 */
const CN_BIZ_MAP: Record<string, string> = {
  "cn-wealth": "gz-wealth",
  "cn-credit": "gz-credit",
  "cn-private": "gz-private",
};

/**
 * 标签内主题去重词表（2026-08-19 用户要求）：同一子标签下「类似主题」最多展示
 * maxPerTheme 条，且若为 2 条，来源等级（tier）必须不同——避免同一政策/事件被
 * 多家媒体报道后堆满一个标签（如 gz-credit 出现 3+ 条公积金新政）。
 *
 * 主题键 = 标题命中的本词表词；两条目同主题 ⟺ 主题键交集非空。
 * 词表与 GZ_CONDUCTION_RULES（业务线传导）同源口径，仅粒度更细（具体业务词）。
 */
const GZ_THEME_TERMS: Record<string, string[]> = {
  "gz-wealth": ["理财", "基金", "保险", "黄金", "财富", "资产配置", "私人银行", "代销", "信托"],
  "gz-credit": ["公积金", "房贷", "消费贷", "经营贷", "按揭", "LPR", "利率", "首付", "融资担保", "信贷", "贷款"],
  "gz-customer": ["社零", "消费", "零售", "居民收入", "收入", "人口", "就业", "物价", "CPI", "民生", "储蓄", "存款", "支付", "商圈", "市场运行"],
  "gz-private": ["家族", "股权", "企业主", "专精特新", "半导体", "集成电路", "生物医药", "高端制造", "人工智能", "芯片", "知识产权", "产业扶持", "招商引资", "独角兽"],
};

/** 标题命中的主题词（按子标签词表；未命中返回空数组 = 不参与主题聚类）。 */
export function themeKeysOf(title: string, sub?: string): string[] {
  const words = sub ? GZ_THEME_TERMS[sub] : Object.values(GZ_THEME_TERMS).flat();
  if (!words || words.length === 0) return [];
  return Array.from(new Set(words.filter((w) => title.includes(w))));
}

/**
 * 标签内主题去重 + tier 去重：同主题簇（主题键交集非空）最多保留 maxPerTheme 条，
 * 且同一簇内同一 tier 只保留 1 条（用户规则：2 条必须是不同来源等级）。
 * 无主题词的条目不聚类（独立保留，不误删）。保持传入顺序（时间倒序 → 留最新）。
 */
export function capByThemeAndTier<T extends ArticleInput>(
  items: T[],
  maxPerTheme = 2,
  sub?: string,
): T[] {
  // 快路径仅对 1 条成立：2 条同主题也可能同 tier（不合规），必须走聚类检查。
  if (items.length <= 1) return items;
  const tierRank = (t?: SourceTier): number =>
    t === "T1" ? 3 : t === "T1.5" ? 2 : t === "T2" ? 1 : 0;
  const kept: T[] = [];
  for (const a of items) {
    const aKeys = themeKeysOf(a.title, sub);
    if (aKeys.length === 0) {
      kept.push(a);
      continue;
    }
    const cluster = kept.filter((k) =>
      themeKeysOf(k.title, sub).some((kw) => aKeys.includes(kw)),
    );
    if (cluster.length === 0) {
      kept.push(a);
      continue;
    }
    // 同簇：同一 tier 只留 1 条
    if (cluster.some((k) => k.tier === a.tier)) continue;
    // 簇未满 → 加入
    if (cluster.length < maxPerTheme) {
      kept.push(a);
      continue;
    }
    // 簇已满：tier 高的优先（T1 > T1.5 > T2），用更高 tier 的新条目替换簇内最低者
    // （避免时间优先把 T1 官方原文挤掉、只留 T2 媒体转载）。
    const lowest = cluster.reduce(
      (m, k) => (tierRank(k.tier) < tierRank(m.tier) ? k : m),
      cluster[0]!,
    );
    if (tierRank(a.tier) > tierRank(lowest.tier)) {
      kept.splice(kept.indexOf(lowest), 1, a);
    }
  }
  return kept;
}



/**
 * Per-source item caps in the raw display, keyed by "category:subcategory".
 * Each source inside the subcategory shows up to N items. Missing keys = no cap.
 *
 * Default 20 across all L3-tabbed subcategories keeps each tab a single
 * comfortable scroll instead of 25-30 items. Merged subgroups (blog-weekly,
 * finance:news, politics:world) ignore this — they use MERGED_SUBGROUP_LIMITS.
 */
export const SOURCE_DISPLAY_LIMITS: Record<string, number> = {
  "tech:github-trending": 10,
  "tech:cn-community": 10,
};

/**
 * Sources whose fetcher returns items already sorted by an engagement/heat
 * algorithm we want to preserve. groupRaw skips its default date-desc sort
 * for these so the final render reflects the source's own ranking.
 * （2026-08-20：attentionvc-ai / huggingface-papers 已随 X/论文类清理禁用）
 */
const PRESERVE_FETCH_ORDER_SOURCES = new Set<string>([]);

function displayLimitFor(
  category: Category,
  subId: string | undefined,
): number | undefined {
  if (!subId) return undefined;
  return SOURCE_DISPLAY_LIMITS[`${category}:${subId}`];
}

/**
 * Take the first `n` items of `list`, but always put today's freshly-fetched
 * items first (preserving relative order inside each group). The renderer
 * only shows `fetchedToday` items under "当天", so slicing a mixed rolling
 * list naively lets older history entries crowd out today's items — e.g.
 * trending papers whose history copy sorts before today's fetch, leaving
 * the sub-tab empty.
 */
function takeFirstToday(list: ArticleInput[], n: number): ArticleInput[] {
  if (list.length <= n) return list;
  const today: ArticleInput[] = [];
  const past: ArticleInput[] = [];
  for (const a of list) (a.fetchedToday === true ? today : past).push(a);
  return today.concat(past).slice(0, n);
}

/**
 * Cheap local heuristic for cross-source story dedup (no LLM cost):
 * normalize a title to lowercase alphanumeric tokens, then compare either
 * by exact normalized equality or by token Jaccard similarity.
 */
function normalizeTitleForDedup(t: string): string {
  return (t ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenJaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Collapse same-story items inside a merged subgroup. The kept item (first
 * in list order) records the other sources in `alsoFrom` so the renderer can
 * show "多家来源：…". Thresholds are conservative to avoid merging distinct
 * stories that merely share keywords.
 */
function mergeSimilarStories(items: ArticleInput[]): ArticleInput[] {
  const groups: { rep: ArticleInput }[] = [];
  for (const a of items) {
    const norm = normalizeTitleForDedup(a.title);
    const tokens = norm.split(" ").filter(Boolean);
    const target = groups.find((g) => {
      const gNorm = normalizeTitleForDedup(g.rep.title);
      if (gNorm === norm) return true;
      if (tokens.length < 3) return false; // too short to risk a merge
      return tokenJaccard(tokens, gNorm.split(" ").filter(Boolean)) >= 0.75;
    });
    if (!target) {
      groups.push({ rep: a });
      continue;
    }
    if (a.source && a.source !== target.rep.source) {
      target.rep.alsoFrom = target.rep.alsoFrom ?? [];
      if (!target.rep.alsoFrom.includes(a.source)) target.rep.alsoFrom.push(a.source);
    }
  }
  return groups.map((g) => g.rep);
}

/**
 * Subcategories that should collapse their sources into a single flat
 * time-sorted list (no L3 source tabs), keyed by "category:subcategory".
 * Value = number of items kept after merging. Each rendered article
 * will display its `source` label inline since the per-source tab row
 * is suppressed.
 *
 * Used when:
 *  - sources are heterogeneous but each publishes few items (blog-weekly)
 *  - the user explicitly wants a curated time-sorted feed rather than
 *    per-source browsing (finance:news, only authoritative sources)
 *
 * Exported so daily.ts can read the cap to keep enrichment in sync.
 */
export const MERGED_SUBGROUP_LIMITS: Record<string, number> = {
  // 技术动态 / 财经要点 合并流：每数据源≤5、子标签整体≤10
  // （省钱 + 避免单一源霸屏）。典型子标签：国外技术 / 国内技术 / 国际财经。
  "tech:overseas-tech": 10,
  "tech:cn-tech": 10,
  "finance:news": 10,
  // 国内财经：上限 20，按接入的信息源平摊（见 groupRaw 的 cn-finance 逻辑）
  "finance:cn-finance": 20,
  // 时政不在本次范围，保留原整体上限
  "politics:world": 15,
};

/**
 * 合并流中单源最多贡献的条数。避免某一源条目过多、按时间降序时把同子标签下
 * 其他源整屏挤出（例如国内财经若某源日期较新、10 条上限会被它独占）。
 * 技术动态 / 财经要点 合并子标签统一为 5（典型：AI媒体 / 国内技术 / 国际财经）。
 * 国内财经（cn-finance）不在此表——它按「子标签上限 / 接入源数量」平摊（20/源数）。
 * 缺省不限制（undefined）即沿用旧行为。
 */
export const MERGE_PER_SOURCE_CAP: Record<string, number> = {
  "tech:overseas-tech": 5,
  "tech:cn-tech": 5,
  "finance:news": 5,
};

/**
 * Politics sources (especially Al Jazeera / BBC / The Diplomat) regularly
 * mix in World Cup / Olympic / football coverage. Filter at the title level
 * so the merged "国际要闻" stream stays politics-only.
 *
 * Pattern is intentionally specific — avoid generic words like "team" or
 * "match" that overlap with diplomacy headlines.
 */
const POLITICS_SPORTS_RE =
  /\b(World\s*Cup|Olympics?|UEFA|FIFA|NBA|NFL|NHL|MLB|ATP|WTA|Premier\s*League|Bundesliga|La\s*Liga|Serie\s*A|Champions\s*League|Eurovision|Wimbledon|Grand\s*Slam|F1|Formula\s*1|Ronaldo|Messi|Mbappe|Beckham|Lukaku|Mitoma|sportsman|footballer|squad)\b|世界杯|奥运|残奥|冬奥|欧冠|英超|西甲|意甲|德甲|网球|足球|篮球|高尔夫|棒球|板球|橄榄球/i;

export function isSportsArticle(title: string): boolean {
  return POLITICS_SPORTS_RE.test(title);
}

// 广东发行人注册表（结构化地域信号，优先于关键词兜底）
let _gdIssuersCache: GdIssuerRegistry | undefined | null = null;
function loadGdIssuers(): GdIssuerRegistry | undefined {
  if (_gdIssuersCache !== null) return _gdIssuersCache ?? undefined;
  try {
    const raw = readFileSync(
      join(process.cwd(), "data", "gd-issuers.json"),
      "utf8",
    );
    _gdIssuersCache = JSON.parse(raw) as GdIssuerRegistry;
  } catch {
    _gdIssuersCache = undefined;
  }
  return _gdIssuersCache ?? undefined;
}

function mergedLimitFor(
  category: Category,
  subId: string,
): number | undefined {
  return MERGED_SUBGROUP_LIMITS[`${category}:${subId}`];
}

// ----- grouping -----

export function groupRaw(
  articles: ArticleInput[],
  registry: SourceDef[],
): RawByCategory {
   const subcatOf = new Map<string, string | undefined>();
  for (const s of registry) subcatOf.set(s.id, s.subcategory);
  // Keep articles from *every* registered source id — including disabled ones
  // like gd-local-scraper. When scripts/render.ts re-renders against a stale
  // sidecar, that file still holds the disabled source's fetched data; we must
  // not silently drop it. (We deliberately do NOT filter by `enabled !== false`.)
  const knownSourceIds = new Set(loadAllSources().map((s) => s.id));
  // 源等级 tier 补齐（2026-08-19）：历史库条目（buildRolling 历史侧）不带 tier →
  // 标签内主题去重 capByThemeAndTier 会把不同权威性的来源（国务院 T1 / 央视 T1.5 /
  // 媒体 T2）误判为同 tier，只留 1 条且挤掉 T1 原文。此处按 registry 统一补齐，
  // 覆盖 daily/dry-run/render 所有入口（daily.ts 抓取路径已补，重复补无害）。
  const tierBySource = new Map<string, SourceTier | undefined>();
  for (const s of registry) tierBySource.set(s.id, s.tier);

  // console.log('[groupRaw] enabledIds 包含的 sourceId 列表:', Array.from(enabledIds));
  // console.log('[groupRaw] gd-local-scraper 是否在 enabledIds 中:', enabledIds.has('gd-local-scraper'));

  type Bucket = { sourceName: string; items: ArticleInput[] };
  const buckets: Record<Category, Map<string, Bucket>> = {
    tech: new Map(),
    finance: new Map(),
    politics: new Map(),
    'gd-ipo': new Map(),
    ipo: new Map(),
    gz: new Map(),
    stocks: new Map(),
  };

  // 广东地区IPO：文章级三道闸分类后，按 classifier 决定的子标签归桶
  // （一个源如巨潮可能同时含深/沪/京，不能再靠 sourceId 定 sub）。
  const gdSubs = new Map<string, Bucket>();
  // 全国IPO/新股：crawler 已按 region 分流好（非广东沪深 + 媒体源），
  // 直接按 registry 的 subcategory 归桶（sse/szse/ipo-media），不再过三道闸。
  const ipoSubs = new Map<string, Bucket>();
  // 广东公司但非IPO类（财报/分红/解禁等）→ 转财经要点「news」合并流
  const financeExtra: ArticleInput[] = [];
  const gdIssuers = loadGdIssuers();

  // console.log('[groupRaw] buckets keys:', Object.keys(buckets));
  // console.log('[groupRaw] buckets[gd-ipo] size:', buckets['gd-ipo']?.size);
  // Pre-seed empty buckets for every enabled source so per-source-tabbed
  // subcategories (e.g. cn-community) still render a tab for sources that
  // returned 0 items today. Without this, a transient LinuxDo Cloudflare
  // block would silently collapse the L3 tab nav, making users wonder
  // whether the other forum even exists.
  for (const s of registry) {
    if (s.enabled === false) continue;
    if (!buckets[s.category].has(s.id)) {
      buckets[s.category].set(s.id, { sourceName: s.name, items: [] });
    }
  }

  for (const a of articles) {
    if (!knownSourceIds.has(a.sourceId)) continue;
    // 历史条目补 tier（见上注释）：就地补齐，供主题去重与角标展示
    if (a.tier === undefined && tierBySource.has(a.sourceId)) {
      a.tier = tierBySource.get(a.sourceId);
    }
    // 条目级相关性过滤（2026-08-21 重构 #23）：AI/启发式判断「与银行业务无关」的
    // 条目不进任何面板——全板块生效（含 tech/ipo/politics）。重构后页面是
    // 「业务启示/科技前沿」等对分行有价值的精选流，demo 要求科技前沿只留与分行
    // 有真实连接点的内容（算力金融化/数据治理），故不再豁免参考区。
    if (a.relevant === false) continue;
    // 杂讯兜底（不依赖 LLM，2026-08-29 无状态源架构红线：不再以 category==="gz" 为前提，
    // 判定本身就是内容词表——城市治理/民生杂讯词命中即过滤，对所有采集分类统一生效）：
    // AI 未明确判相关(relevant!==true) 且标题命中电费补贴/招聘/摆卖/殡葬/诊所备案等 → 过滤。
    // 南沙/政府列表页会长期挂旧政策文件库存，LLM 分类偶有漏网（ai_relevant=null），
    // 此兜底保证垃圾内容绝不进商机面板。
    if (a.relevant !== true && GZ_NOISE_RE.test(a.title)) continue;
    if (a.category === "politics" && isSportsArticle(a.title)) continue;
    if (
      (a.sourceId === "v2ex-hot" || a.sourceId === "linuxdo") &&
      V2EX_OFF_TOPIC_RE.test(a.title)
    )
      continue;
    // 广东地区IPO：先过三道闸分类器，再决定归哪个子标签 / 是否转财经 / 丢弃
    if (a.category === "gd-ipo") {
      const res = classifyGdIpo(
        {
          title: a.title,
          excerpt: a.excerpt,
          url: a.url,
          sourceId: a.sourceId,
          source: a.source,
          publishedAt: a.publishedAt,
          stockCode: (a as ArticleInput & { stockCode?: string }).stockCode,
          registeredProvince: (a as ArticleInput & { registeredProvince?: string })
            .registeredProvince,
        },
        { gdIssuers },
      );
      if (res.action === "drop") continue;
      if (res.action === "finance") {
        financeExtra.push(a);
        continue;
      }
      // 按上市阶段归栏（任务二：看已上市 / 准备IPO 两类），不再按交易所来源分栏
      const stage = inferStage(a.title, a.excerpt);
      let b = gdSubs.get(stage);
      if (!b) {
        b = { sourceName: SUBCATEGORY_LABELS[stage] ?? stage, items: [] };
        gdSubs.set(stage, b);
      }
      b.items.push(a);
      continue;
    }
    // 全国IPO/新股：按 sourceId → registry subcategory 归桶（sse/szse/bse 交易所权威源）
    if (a.category === "ipo") {
      // 2026-08-23：已上市公司资本运作公告（定增/审核问询/购买资产/解禁/回购等）
      // 不是「IPO 动态」，命中且非 IPO 流程词 → 转财经要点，避免污染 IPO 板块。
      const ipoText = `${a.title} ${a.excerpt || ""}`;
      if (IPO_CAPITAL_ACT_RE.test(ipoText) && !IPO_FLOW_RE.test(ipoText)) {
        financeExtra.push(a);
        continue;
      }
      const sub = subcatOf.get(a.sourceId) ?? "sse";
      let b = ipoSubs.get(sub);
      if (!b) {
        b = { sourceName: SUBCATEGORY_LABELS[sub] ?? sub, items: [] };
        ipoSubs.set(sub, b);
      }
      b.items.push(a);
      continue;
    }
    // —— 全国业务线子标签移入广州商机面板（2026-08-21 用户）——
    // 宏观政策(finance)不再承载 cn-wealth/cn-credit/cn-private：这类全国性业务线
    // 报道（理财/信贷/私行）并入广州商机(gz)面板的单一合并流（gz-all），
    // 由渲染层按权威等级拆「官方 / 媒体」tab。文章改写 category=gz 后继续。
    if (a.category === "finance") {
      const subsArr =
        a.subcategories && a.subcategories.length > 0
          ? a.subcategories
          : a.subcategory
            ? [a.subcategory]
            : [];
      const cnSub = subsArr.find((s) => CN_BIZ_MAP[s]);
      if (cnSub) {
        const gzMap = buckets["gz"];
        let gzb = gzMap.get(a.sourceId);
        if (!gzb) {
          gzb = { sourceName: a.source, items: [] };
          gzMap.set(a.sourceId, gzb);
        }
        gzb.items.push({
          ...a,
          category: "gz" as const,
          subcategory: CN_BIZ_MAP[cnSub],
          subcategories: [CN_BIZ_MAP[cnSub]],
        });
        continue;
      }
    }
    const map = buckets[a.category];
    let b = map.get(a.sourceId);
    if (!b) {
      b = { sourceName: a.source, items: [] };
      map.set(a.sourceId, b);
    }
    
    b.items.push(a);
    // console.log('[groupRaw] buckets[gd-ipo] size after filling:', buckets['gd-ipo']?.size);

    // —— 上位法传导（「包含关系」，2026-08-19）：finance（宏观政策）板块的全国/省级
    // 政策若影响广州业务线（标题命中传导词表），镜像到 广州商机(gz) 板块对应业务线
    // 子标签。宏观板块原样保留；a.relevant===false 的 finance 条目已在上面 continue
    // 过滤，此处仅剩相关/未判条目。镜像条目覆盖 category/subcategories 为 gz 维度。
    if (a.category === "finance") {
      const gzSubs = conductToGzSubs(a.title);
      if (gzSubs.length > 0) {
        const gzMap = buckets["gz"];
        let mb = gzMap.get(a.sourceId);
        if (!mb) {
          mb = { sourceName: a.source, items: [] };
          gzMap.set(a.sourceId, mb);
        }
        mb.items.push({
          ...a,
          category: "gz" as const,
          subcategory: gzSubs[0],
          subcategories: gzSubs,
        });
      }
    }
  }

  for (const cat of CATEGORY_ORDER) {
    for (const [id, b] of buckets[cat].entries()) {
      if (PRESERVE_FETCH_ORDER_SOURCES.has(id)) continue;
      b.items = sortByTierAndTime(b.items);
    }
  }

  // 广东公司但非IPO类（财报/分红/解禁等）→ 并入财经要点「国内财经」合并流
  if (financeExtra.length > 0) {
    const sid = "_gd_finance";
    subcatOf.set(sid, "cn-finance");
    const b =
      buckets["finance"].get(sid) ??
      ({ sourceName: "公司资本运作公告", items: [] } as Bucket);
    b.items.push(...financeExtra);
    buckets["finance"].set(sid, b);
  }

  // 按 SUBCATEGORY_ORDER 构建子标签，始终渲染全部二级标签（空则占位）。
  // gd-ipo 用三道闸分类结果 gdSubs；全国 ipo 用 subcatOf 归桶结果 ipoSubs。
  function buildOrderedSubs(subMap: Map<string, Bucket>, cat: Category): SubGroup[] {
    const order = SUBCATEGORY_ORDER[cat] ?? [];
    const subs: SubGroup[] = [];
    for (const subId of order) {
      const b = subMap.get(subId);
      if (!b || b.items.length === 0) {
        subs.push({
          id: subId,
          name: SUBCATEGORY_LABELS[subId] ?? subId,
          sources: [],
        });
        continue;
      }
      b.items = sortByTierAndTime(b.items);
      subs.push({
        id: subId,
        name: SUBCATEGORY_LABELS[subId] ?? subId,
        sources: [
          {
            sourceId: "_merged",
            sourceName: SUBCATEGORY_LABELS[subId] ?? subId,
            items: b.items,
            merged: true,
          },
        ],
      });
    }
    return subs;
  }

  function toSourceGroup(
    sourceId: string,
    b: Bucket,
    limit: number | undefined,
  ): SourceGroup {
    return {
      sourceId,
      sourceName: b.sourceName,
      items: limit ? takeFirstToday(b.items, limit) : b.items,
    };
  }

  function sortByRegistry(list: SourceGroup[]): SourceGroup[] {
    return [...list].sort((a, b) => {
      const ia = registry.findIndex((s) => s.id === a.sourceId);
      const ib = registry.findIndex((s) => s.id === b.sourceId);
      return ia - ib;
    });
  }

 const out: RawByCategory = {
  tech: [],
  finance: [],
  politics: [],
  'gd-ipo': [],
  ipo: [],
  gz: [],
  stocks: [],
  };
  
  for (const cat of CATEGORY_ORDER) {
    // 广东地区IPO / 全国IPO 已由各自分流逻辑（三道闸 / subcatOf）文章级分发，单独构建
    if (cat === "gd-ipo") {
      out["gd-ipo"] = buildOrderedSubs(gdSubs, "gd-ipo");
      continue;
    }
    if (cat === "ipo") {
      out["ipo"] = buildOrderedSubs(ipoSubs, "ipo");
      continue;
    }
    const order = SUBCATEGORY_ORDER[cat];
    if (!order) {
      // Flat: one synthetic subgroup with every source.
      const sources: SourceGroup[] = [];
      for (const [id, b] of buckets[cat].entries()) {
        sources.push(toSourceGroup(id, b, undefined));
      }
      out[cat] = sources.length
        ? [{ id: "all", name: CATEGORY_LABELS[cat], sources: sortByRegistry(sources) }]
        : [];
      continue;
    }
    // Subcategory split: bucket each source under its registered subcategory.
    const subs: SubGroup[] = [];
    for (const subId of order) {
      const mergeLimit = mergedLimitFor(cat, subId);
      if (mergeLimit !== undefined) {
        // Merge: flatten all sources under this subcategory into a single
        // time-sorted SourceGroup. Articles keep their `source` field so
        // the renderer can label them.
        const flat: ArticleInput[] = [];
        // Per-source cap: fixed for most merged subgroups; 国内财经 shares
        // its subcategory limit evenly across the enabled sources.
        let perCap = MERGE_PER_SOURCE_CAP[`${cat}:${subId}`];
        if (perCap === undefined && subId === "cn-finance") {
          const n = registry.filter(
            (s) =>
              s.category === cat &&
              s.subcategory === subId &&
              s.enabled !== false,
          ).length;
          if (n > 0) perCap = Math.ceil((mergeLimit ?? 20) / n);
        }
        for (const [id, b] of buckets[cat].entries()) {
          // 条目级 subcategory 优先（AI/启发式分类），注册表源级兜底
          const matched = b.items.filter(
            (a) => {
            const subs =
              a.subcategories && a.subcategories.length > 0
                ? a.subcategories
                : a.subcategory
                  ? [a.subcategory]
                  : [];
            // 广州商机面板为单一合并流（gz-all）：收该桶全部文章（含 cn-* 移入与上位法镜像）。
            // 其余子标签：条目级 subcategory 优先（AI/启发式分类），注册表源级兜底；
            // gz 板块标题词表补判（上位法传导，防御老数据）见非 merge 分支注释。
            if (cat === "gz" && subId === "gz-all") return true;
            return subs.length > 0
              ? subs.includes(subId) ||
                  (cat === "gz" && conductToGzSubs(a.title).includes(subId))
              : subcatOf.get(id) === subId;
          },
          );
          if (matched.length) {
            flat.push(...(perCap ? takeFirstToday(matched, perCap) : matched));
          }
        }
        if (flat.length === 0) {
          if (cat === "finance") {
            subs.push({
              id: subId,
              name: SUBCATEGORY_LABELS[subId] ?? subId,
              sources: [],
            });
          }
          continue;
        }
        const flatSorted = sortByTierAndTime(flat);
        const top = takeFirstToday(flatSorted, mergeLimit);
        if (top.length === 0) continue;
        // Cross-source story dedup: several sources may cover the same story.
        // Collapse near-identical titles into one item and record the other
        // sources on `alsoFrom` (cheap local heuristic — zero LLM calls).
        const deduped = mergeSimilarStories(top);
        subs.push({
          id: subId,
          name: SUBCATEGORY_LABELS[subId] ?? subId,
          sources: [
            {
              sourceId: "_merged",
              sourceName: SUBCATEGORY_LABELS[subId] ?? subId,
              items: deduped,
              merged: true,
            },
          ],
        });
        continue;
      }

      const limit = displayLimitFor(cat, subId);
      // 1) 子标签级聚合（跨源）：收集所有命中该子标签的条目（含 gz 板块传导补判）
      const perSourceMap = new Map<string, { sourceName: string; items: ArticleInput[] }>();
      for (const [id, b] of buckets[cat].entries()) {
        // 条目级 subcategory 优先（AI/启发式分类），注册表源级兜底
        const items = b.items.filter(
          (a) => {
            const subs =
              a.subcategories && a.subcategories.length > 0
                ? a.subcategories
                : a.subcategory
                  ? [a.subcategory]
                  : [];
            // 广州商机面板为单一合并流（gz-all）：收该桶全部文章。
            // 其余子标签：条目级 subcategory 优先，注册表源级兜底；gz 板块补判
            // （上位法传导，防御老数据）：条目带的是非 gz 标签（cn-*，全国性政策/财经，
            // 历史库老条目 category=gz 的错标）→ 按业务线词表补判归属，不因标签不匹配被吞掉。
            if (cat === "gz" && subId === "gz-all") return true;
            return subs.length > 0
              ? subs.includes(subId) ||
                  (cat === "gz" && conductToGzSubs(a.title).includes(subId))
              : subcatOf.get(id) === subId;
          },
        );
        if (items.length) perSourceMap.set(id, { sourceName: b.sourceName, items });
      }
      // 2) 标签内主题去重（跨源，2026-08-19 用户要求）：同主题 ≤2 条、2 条必须 tier 不同。
      //    在子标签层面对所有源的条目统一裁剪（央视/国务院/媒体同报一个政策只留 ≤2 条）。
      //    排序用 tier 权威等级 + 时间（2026-08-21 用户要求，只有日期的沉底）。
      const all = sortByTierAndTime(
        [...perSourceMap.values()].flatMap((g) => g.items),
      );
      const keepUrls = new Set(capByThemeAndTier(all, 2).map((a) => a.url));
      // 3) 合并输出（2026-08-21 用户要求：渲染只到子标签，去掉 L3 信息源 tabs）：
      //    保留被裁剪后的条目为单一时间流（merged），来源降级为卡片上的来源小字。
      const kept = all.filter((a) => keepUrls.has(a.url));
      // 财经要点 / 广州商机 的二级标签始终渲染，即使当天为空也保留
      // 标签 + “暂无内容”占位，保证结构稳定可见（不折叠成单子标签）。
      // （gd-ipo/ipo 已在循环开头 continue 单独构建，此处不可达，不重复判断）
      if (kept.length === 0) {
        if (cat === 'finance' || cat === 'gz') {
          subs.push({ id: subId, name: SUBCATEGORY_LABELS[subId] ?? subId, sources: [] });
          continue;
        }
        continue;
      }
      subs.push({
        id: subId,
        name: SUBCATEGORY_LABELS[subId] ?? subId,
        sources: [
          {
            sourceId: "_merged",
            sourceName: SUBCATEGORY_LABELS[subId] ?? subId,
            items: kept,
            merged: true,
          },
        ],
      });
    }
    out[cat] = subs;
  }
  // Safety net: if gd-ipo has data but the subcategory split above produced
  // an empty panel (e.g. a future source whose subcategory isn't in
  // SUBCATEGORY_ORDER), force a flat render so the data is never lost.
  if (buckets['gd-ipo'] && buckets['gd-ipo'].size > 0 && (out['gd-ipo'] || []).length === 0) {
    const flatSources: SourceGroup[] = [];
    for (const [id, b] of buckets['gd-ipo'].entries()) {
      flatSources.push(toSourceGroup(id, b, undefined));
    }
    if (flatSources.length > 0) {
      out['gd-ipo'] = [{
        id: 'all',
        name: CATEGORY_LABELS['gd-ipo'],
        sources: sortByRegistry(flatSources),
      }];
    }
  }
  return out;
}


// ----- report-item card renderer（新管线 schema: ReportItem）-----

/** 商机 tag 色系（与 sections.ts 保持一致） */
function tagClsOf(tag: string): string {
  if (/财富|私行/.test(tag)) return "t-wealth";
  if (/代发|客群/.test(tag)) return "t-mass";
  if (/政银|住房|监管|政策/.test(tag)) return "t-policy";
  if (tag === "粤") return "t-gd";
  return "";
}

/** 股市动态面板：卡片市场徽标（A股/港股/美股）。 */
const MARKET_BADGE: Record<string, { label: string; cls: string }> = {
  "a-share": { label: "A股", cls: "mkt-a" },
  hk: { label: "港股", cls: "mkt-hk" },
  us: { label: "美股", cls: "mkt-us" },
};


/** P2⑤ 板块卡「所以呢」摘要上限 50 字（首句即结论/落点，截断优先保留首句完整）。
 * 仅作用于板块卡（gz_local/biz/policy/tech/ipo），必读/商机/风险走其他渲染路径，不受影响。 */
function capSummary(s: string, max = 50): string {
  const t = (s || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastPunct = Math.max(
    cut.lastIndexOf("。"),
    cut.lastIndexOf("！"),
    cut.lastIndexOf("？"),
    cut.lastIndexOf("；"),
  );
  return (lastPunct > 4 ? cut.slice(0, lastPunct + 1) : cut) + "…";
}

export function renderReportItemHtml(
  item: ReportItem,
  showSource = true,
): string {
  const title = escapeHtml(item.title_cn || item.title_orig || "");
  const url = escapeHtml(item.url);
  const summary = item.summary ? escapeHtml(capSummary(item.summary)) : "";
  const time = item.date ? escapeHtml(item.date) : "";
  const official = item.source_type === "official";
  const badge = official ? { label: "官方", cls: "src-official" } : { label: "媒体", cls: "src-media" };
  const tags = (item.tags ?? [])
    .map((t) => `<span class="tag ${tagClsOf(t)}">${escapeHtml(t)}</span>`)
    .join("");
  const mkt = item.market ? MARKET_BADGE[item.market] : undefined;
  const mktBadge = mkt ? `<span class="mkt-badge ${mkt.cls}">${mkt.label}</span>` : "";
  return `<article class="brief${item.importance === 3 ? " must" : ""}" data-source="${item.source_type}" data-tags="${(item.tags ?? []).join(" ")}" data-market="${escapeHtml(item.market ?? "")}">
  <div class="bm">${mktBadge}<span class="src-badge ${badge.cls}">${badge.label}</span>${showSource && item.source ? `<span>${escapeHtml(item.source)}</span>` : ""}${time ? `<span>${time}</span>` : ""}${item.importance === 3 ? `<span class="imp-badge">必知</span>` : ""}</div>
  <h3><a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a></h3>
  ${summary ? `<p class="sum">${summary}</p>` : ""}
  ${tags ? `<div class="tags">${tags}</div>` : ""}
</article>`;
}

/** 4 大零售部门标签（2026-08-22 用户：无这 4 个标签的条目排最后，优先展示带标签的）。 */
const DEPT_TAGS = new Set(["财富", "私行", "客群", "信贷"]);

export function renderReportCardList(
  items: ReportItem[],
  showSource = true,
): string {
  if (items.length === 0) return `<p class="empty">${STR.emptySource}</p>`;
  // 稳定排序：带 4 部门零售标签的排前，无标签的沉底（同组内保持原顺序：今日 rank / 时间）。
  const hasTag = (it: ReportItem): number =>
    (it.tags ?? []).some((t) => DEPT_TAGS.has(t)) ? 0 : 1;
  const sorted = [...items].sort((a, b) => hasTag(a) - hasTag(b));
  const top = sorted.slice(0, 5);
  const more = sorted.slice(5);
  let html = top.map((a) => renderReportItemHtml(a, showSource)).join("\n");
  if (more.length > 0) {
    html +=
      more
        .map((a) => renderReportItemHtml(a, showSource).replace('<article class="brief', '<article class="brief more'))
        .join("\n") +
      `<button class="expand-btn" type="button">展开其余 ${more.length} 条</button>`;
  }
  return html;
}

/** 筛选维度定义：供「板块内筛选条」复用。 */
export interface FilterChipDef {
  /** 展示文案 */
  label: string;
  /** 与卡片 data-source / data-tags 对应的匹配值 */
  value: string;
  /** 维度分组键（同组 OR，不同组 AND） */
  group: string;
}
export interface FilterGroupDef {
  /** 维度标题（仅在 UI 展示，如「来源」「业务线」） */
  title: string;
  chips: FilterChipDef[];
}

/**
 * 默认筛选维度（业务资讯板块统一复用，2026-08-22 用户规则）：
 * - 第一维度「来源」：官方 / 媒体 —— 组内 OR；
 * - 第二维度「业务线」：客群 / 私行 / 财富 / 信贷 —— 组内 OR；
 * - 两维度之间取交集（AND）；无任何选中或全选 → 全部显示。
 */
export const DEFAULT_FILTER_GROUPS: FilterGroupDef[] = [
  {
    title: "来源",
    chips: [
      { label: "官方", value: "official", group: "src" },
      { label: "媒体", value: "media", group: "src" },
    ],
  },
  {
    title: "业务线",
    chips: [
      { label: "客群", value: "客群", group: "tag" },
      { label: "私行", value: "私行", group: "tag" },
      { label: "财富", value: "财富", group: "tag" },
      { label: "信贷", value: "信贷", group: "tag" },
      // 「其他」= 未命中 4 部门零售标签的条目（2026-08-22 用户：无标签信息放队列
      // 最后，想看才通过此选项查看）。
      { label: "其他", value: "__none__", group: "tag" },
    ],
  },
];

/**
 * 渲染板块内筛选条（可复用组件：传入自定义 groups 即可用于其它板块）。
 * 默认渲染 DEFAULT_FILTER_GROUPS；维度内 OR、维度间 AND；全空 / 全选 → 全部显示。
 */
export function renderFilterBar(groups: FilterGroupDef[] = DEFAULT_FILTER_GROUPS): string {
  const groupsHtml = groups
    .map((g) => {
      const chips = g.chips
        .map(
          (c) =>
            `<button type="button" class="filter-chip" data-group="${c.group}" data-filter="${escapeHtml(c.value)}">${escapeHtml(c.label)}</button>`,
        )
        .join("");
      return `<div class="filter-group">
        <span class="filter-gtitle">${escapeHtml(g.title)}</span>
        ${chips}
      </div>`;
    })
    .join("");
  return `<div class="filter-bar">
    <span class="filter-label">筛选</span>
    ${groupsHtml}
    <button type="button" class="filter-reset">重置</button>
  </div>`;
}

/**
 * 面板级筛选条（2026-08-23 用户）：来源维度（官方/媒体）固定保留；
 * 业务线维度**动态**——只渲染当前面板实际存在数据的部门标签
 * （客群/私行/财富/信贷 无数据则不出现），有非部门标签或无标签卡片才追加「其他」；
 * 全无业务线数据时整个业务线维度不渲染。
 */
export function renderFilterBarForPanel(items: ReportItem[]): string {
  const srcChips: FilterChipDef[] = [
    { label: "官方", value: "official", group: "src" },
    { label: "媒体", value: "media", group: "src" },
  ];
  const presentDepts = new Set<string>();
  let hasOther = false;
  for (const it of items) {
    const tags = it.tags ?? [];
    const deptHit = tags.find((t) => DEPT_TAGS.has(t));
    if (deptHit) presentDepts.add(deptHit);
    else hasOther = true;
  }
  const groups: FilterGroupDef[] = [{ title: "来源", chips: srcChips }];
  const tagChips: FilterChipDef[] = [];
  // 固定展示顺序：客群 / 私行 / 财富 / 信贷，仅保留有数据的
  for (const d of ["客群", "私行", "财富", "信贷"]) {
    if (presentDepts.has(d)) tagChips.push({ label: d, value: d, group: "tag" });
  }
  if (hasOther) tagChips.push({ label: "其他", value: "__none__", group: "tag" });
  if (tagChips.length > 0) groups.push({ title: "业务线", chips: tagChips });
  return renderFilterBar(groups);
}

/**
 * 股市动态面板筛选条（2026-08-25 用户）：单一「市场」维度，按 A股 / 港股 / 美股 过滤。
 * 维度内 OR（选中多个市场取并集）；全选或全不选 → 全部显示（复用 renderFilterBar 交互）。
 */
export function renderStockFilterBar(): string {
  const chips = [
    { label: "A股", value: "a-share" },
    { label: "港股", value: "hk" },
    { label: "美股", value: "us" },
  ]
    .map(
      (c) =>
        `<button type="button" class="filter-chip" data-group="market" data-filter="${c.value}">${c.label}</button>`,
    )
    .join("");
  return `<div class="filter-bar">
    <span class="filter-label">市场</span>
    ${chips}
    <button type="button" class="filter-reset">重置</button>
  </div>`;
}

/** 构造 url → 中文标题 映射（供 must_read 回写标题）。 */
function resolveTitleMap(report: DailyReport): Map<string, string> {
  const m = new Map<string, string>();
  const secs: ReportSectionKey[] = ["gz_local", "biz_insight", "policy_market", "tech", "ipo"];
  for (const s of secs) {
    for (const it of report.sections?.[s] ?? []) {
      if (it.url && it.title_cn) m.set(it.url, it.title_cn);
    }
  }
  return m;
}

/**
 * 顶部执行摘要：今日定调 + 今日必读 + 商机洞察（消费新 report 结构：
 * hero_line / must_read / insights）。must_read 仅含 url+why，按 url 回写标题。
 */
function renderReportExec(report: DailyReport): string {
  const titleMap = resolveTitleMap(report);
  // N 层：选 top 3（音频核心）+ 数据化"三件事"标识
  const sourceItems: ReportItem[] = SECTIONS.flatMap((s) => report.sections[s] ?? []);
  const { top: topMust, rationale: topRationale } = selectTopMustRead(
    report.must_read,
    sourceItems,
  );
  const topMustUrls = new Set(topMust.map((m) => m.url));
  const must = report.must_read
    .map((m, i) => {
      const title = m.title || titleMap.get(m.url) || m.url;
      const body = `<strong>${escapeHtml(title)}</strong><span class="must-why">${escapeHtml(m.why)}</span>`;
      const inner = m.url
        ? `<a class="must-body must-link" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${body}</a>`
        : `<div class="must-body">${body}</div>`;
      const isTop = m.url && topMustUrls.has(m.url);
      const topBadge = isTop ? `<span class="must-top-badge" title="今日三件事：行长音频重点">三件事</span>` : "";
      const cls = isTop ? "must-card must-top" : "must-card";
      return `<li class="${cls}" data-audio-section="must" ${isTop ? 'data-top-must="true"' : ""}><span class="must-index">${i + 1}</span>${inner}${topBadge}</li>`;
    })
    .join("");
  const insights = report.insights
    .map((it) => {
      const srcMarks = (it.sources && it.sources.length > 0)
        ? ` <span class="insight-srcs">${it.sources.slice(0, 3).map((s, i) =>
            `<a class="insight-src" href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(s.title || "来源" + (i + 1))}" aria-label="来源${i + 1}">${["①","②","③","④","⑤"][i]}</a>`
          ).join("")}</span>`
        : "";
      // 用 topic 作为 feedback key（insights 没有 url 字段；topic 在 insight 列表内唯一性靠 .sources[0].url 兜底）
      const fbKey = (it.sources && it.sources[0]?.url) || `insight:${it.topic}`;
      return `<article class="insight" data-audio-section="insight">
        ${(it.tags ?? []).length > 0
          ? `<div class="insight-tags">${(it.tags ?? [])
              .map((t) => `<span class="tag ${tagClsOf(t)}">${escapeHtml(t)}</span>`)
              .join("")}</div>`
          : ""}
        <h3>${escapeHtml(it.topic)}${srcMarks}</h3>
        ${it.impact ? `<p><b>影响：</b>${escapeHtml(it.impact)}</p>` : ""}
        ${it.action ? `<p><b>建议：</b>${escapeHtml(it.action)}</p>` : ""}
      </article>`;
    })
    .join("");
  // M 层：风险卡片（与 insights 同样的卡片样式；M 关键特征：红/警示色 + 部门影响拆解）
  const riskCard = (() => {
    const r = report.risk;
    if (!r) return "";
    const srcMarks = (r.sources && r.sources.length > 0)
      ? ` <span class="risk-srcs">${r.sources.slice(0, 3).map((s, i) =>
          `<a class="risk-src" href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(s.title || "来源" + (i + 1))}" aria-label="来源${i + 1}">${["①","②","③","④","⑤"][i]}</a>`
        ).join("")}</span>`
      : "";
    const sourceBadge = r.source
      ? `<span class="risk-source-badge risk-source-${r.source.toLowerCase()}">${r.source === "T1" ? "官方" : r.source === "T1.5" ? "准官方" : "媒体"}</span>`
      : "";
    const fbKey = (r.sources && r.sources[0]?.url) || r.url || `risk:${r.topic}`;
    return `<article class="risk-card" data-audio-section="risk">
        <div class="risk-header">⚠️ 风险预警${sourceBadge}${srcMarks}</div>
        <h3>${escapeHtml(r.topic)}</h3>
        ${r.evidence ? `<p><b>依据：</b>${escapeHtml(r.evidence)}</p>` : ""}
        ${r.impact ? `<p><b>影响：</b>${escapeHtml(r.impact)}</p>` : ""}
        ${r.action ? `<p><b>建议：</b>${escapeHtml(r.action)}</p>` : ""}
      </article>`;
  })();
  return `<section class="exec-summary">
    <div class="exec-head">
      <h2 class="exec-title">执行摘要</h2>
      <span class="exec-sub">今日必读 · 商机洞察 · 风险预警（AI 生成）</span>
    </div>
    ${must ? `<div class="exec-must"><h3 class="exec-col-title">📌 今日必读<span class="must-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3><ul class="must-scroller">${must}</ul></div>` : ""}
    ${insights ? `<div class="exec-insights"><h3 class="exec-col-title">💡 商机洞察<span class="insight-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3><div class="insight-scroller">${insights}</div></div>` : ""}
    ${riskCard ? `<div class="exec-risk"><h3 class="exec-col-title">⚠️ 风险预警<span class="risk-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3><div class="risk-scroller">${riskCard}</div></div>` : ""}
  </section>`;
}

/**
 * 昨日股市复盘三卡（美股 / A股 / 港股）：每张 = 涨跌概况 + 关键板块。
 * 参考区，置于执行摘要之后、板块导航之前；stock_recap 缺失或三卡全空则不渲染。
 * 内容纯市场事实概述，无零售/对公引申（用户 2026-08-25 拍板，且转口播友好）。
 */
function renderStockIndexBlock(card: MarketCard, quoteChannel?: string, quoteDate?: string): string {
  if (!card.indices || !card.indices.length) return "";
  const items = card.indices
    .map((i) => {
      const cls = i.changePct
        ? i.changePct.trim().startsWith("-")
          ? "down"
          : "up"
        : "";
      const pct = i.changePct
        ? ` <em class="stock-idx-pct ${cls}">${escapeHtml(i.changePct)}</em>`
        : "";
      return `<span class="stock-idx">${escapeHtml(i.name)} <b>${escapeHtml(i.value)}</b>${pct}</span>`;
    })
    .join("");
  // 行情来源备注：精准发布时间（取值日=上一交易日收盘）+ 渠道（新浪行情）
  const src =
    quoteChannel && quoteDate
      ? `<span class="stock-idx-src">${escapeHtml(quoteChannel)} · 取值于 ${escapeHtml(quoteDate)} 收盘</span>`
      : "";
  return `<div class="stock-indices"><span class="stock-idx-cap">收盘点位</span><div class="stock-idx-list">${items}</div>${src}</div>`;
}

function renderStockRecap(report: DailyReport): string {
  const recap = report.stock_recap;
  if (!recap) return "";
  const cards = [
    { label: "A股", cls: "a", card: recap.aShare },
    { label: "港股", cls: "hk", card: recap.hk },
    { label: "美股", cls: "us", card: recap.us },
  ];
  const cardHtml = cards
    .map(({ label, cls, card }) => {
      const empty = !card.overview && !card.spoken && card.sectors.length === 0 && !card.indices?.length;
      // 卡脚小字备注：渠道（来源网站）+ 发布时间（数据日期）+ 交叉验证网站（2026-08-25 用户拍板替代来源链接按钮）
      const meta =
        card.meta && (card.meta.source || card.meta.date || card.meta.crossCheck)
          ? `<p class="stock-meta">${[
              card.meta.source ? `渠道：${escapeHtml(card.meta.source)}` : "",
              card.meta.date ? `发布时间：${escapeHtml(card.meta.date)}` : "",
              card.meta.crossCheck ? "" : "",
              card.meta.crossCheck ? `交叉验证：${escapeHtml(card.meta.crossCheck)}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}</p>`
          : "";
      const indices = renderStockIndexBlock(card, recap.quoteChannel, recap.quoteDate);
      if (empty) {
        return `<li class="stock-card stock-card--${cls}" data-audio-section="stock"><header class="stock-card-head">${label}</header><p class="stock-empty">暂无数据</p>${indices}${meta}</li>`;
      }
      const overview = card.overview || card.spoken || "";
      // 大盘解读权威源（2026-08-29 用户：港股大盘解读应锚定新浪财经等收评/总结报告）
      // 卡内展示「直接看原报告」入口，让行长不必另去检索即可读权威解读。
      const sourceReport = card.sourceReport
        ? `<a class="stock-source-report" href="${escapeHtml(card.sourceReport.url)}" target="_blank" rel="noopener">📄 原报告：${escapeHtml(card.sourceReport.title)}</a>`
        : "";
      // 关键板块总结：最多取 3 条，避免「具体的板块细节」挤占顶部复盘卡
      // （细节下沉到底部「股市动态」消息清单，2026-08-25 用户要求）
      const sectors = card.sectors.length
        ? `<div class="stock-sectors"><span class="stock-sec-label">关键板块总结</span><ul>${card.sectors
            .slice(0, 3)
            .map((s) => `<li>${escapeHtml(s)}</li>`)
            .join("")}</ul></div>`
        : "";
      return `<li class="stock-card stock-card--${cls}" data-audio-section="stock">
        <header class="stock-card-head">${label}</header>
        ${indices}
        ${overview ? `<p class="stock-overview"><span class="stock-sec-label">大盘一句话总结</span>${escapeHtml(overview)}</p>` : ""}
        ${sourceReport}
        ${sectors}
        ${meta}
      </li>`;
    })
    .join("");
  const ms = recap.marketStatus;
  const stockNote = ms?.isMarketClosed
    ? `<p class="stock-note stock-note--closed" style="color:#c8842a;font-weight:600">⚠️ ${escapeHtml(ms.note)}</p>`
    : `<p class="stock-note">昨日市场复盘 · 涨跌概况与关键板块（AI 生成）</p>`;
  return `<section class="stock-recap">
    <div class="stock-must">
      <h3 class="exec-col-title">📊 股市解读<span class="stock-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3>
      ${stockNote}
      <ul class="stock-scroller">${cardHtml}</ul>
    </div>
  </section>`;
}

// ----- top-level renderer -----

/**
 * 外地地名锚（广州本地严格过滤用）：标题命中任一外地省/市/地名 → 该条为全国/外地
 * 政策（上海/北京/深圳/江苏/浙江…），即使 category=gz 也不进 gz_local，归政策与市场。
 * 广州本地板块宁缺毋滥：领导冲着「广州」点进来，看到的必须是广州事件本身。
 */
const FOREIGN_REGION_RE =
  /上海|北京|深圳|江苏|浙江|南京|苏州|杭州|宁波|成都|重庆|天津|武汉|长沙|合肥|青岛|济南|福州|厦门|昆明|西安|郑州|东莞|佛山|珠海|中山|惠州|汕头|湛江|茂名|肇庆|江门|清远|韶关|梅州|河源|阳江|揭阳|汕尾|潮州|云浮|广东/;

/** 摘要地域一致性兜底（2026-08-23 R3 扩展）：摘要声称「广东/广州…企业」的写法。 */
const GD_ENTERPRISE_RE =
  /(广东|广州)(省|市)?[一-鿿]{0,3}(企业|公司|科技|集团)/;

/** 已上市公司资本运作公告词（2026-08-23 IPO 桶分流）：命中且非 IPO 流程 → 转财经要点，
 *  避免定增/审核问询/购买资产/解禁等「已上市公司公告」污染 IPO 动态板块。 */
const IPO_CAPITAL_ACT_RE =
  /(定增|增发|可转债|解禁|限售|回购|减持|增持|特定对象|发行股份购买资产|重大资产重组|资产重组|并购|审核问询|问询函|问询回复|年报|中报|季报|财报|分红|派息|业绩快报|澄清|停牌|复牌|诉讼|质押|担保|员工持股)/i;
const IPO_FLOW_RE =
  /(受理|辅导|备案|招股|过会|上市委|注册生效|提交注册|询价|申购|路演|拟登陆|pre-?ipo|新股上市|上市公告|发行结果|中签|已受理)/i;

/**
 * subcategory → 部门中文 tag 的双标构造已统一移至 lib/classify/tag-rollup.ts 的
 * rollUpTags()（2026-08-24）：同时消费 subcategory 与自由标签，确保每张卡必带 ≥1 个
 * 业务线部门标签。下方 mergeRollingIntoReport 的标签即调用 rollUpTags。
 */

/**
 * 把滚动历史（近 2 天，buildRolling 产物——buildRolling 按 FETCH_WINDOW_DAYS=2 取
 * publishedAt/lastSeenAt ≤2 天的历史条目；2026-08-25 核实修正，原注释误写"近 7 天"）中
 * 「符合要求」的条目并入 report.sections，
 * 使渲染展示过去符合要求的资讯（有摘要用摘要、无则摘录原文前 90 字），而非仅今日 AI 成稿。
 * （2026-08-21 用户：过去符合要求的都展示 + 区分零售各部门呈现。）
 *
 * 规则：
 * - 与今日成稿 URL 去重（今日优先）；
 * - 历史条目按发布时间倒序追加到板块末尾（今日 AI 条目保持 rank 在前）；
 * - ai_relevant===false（AI 判无关）的历史条目不并入；ai_relevant===null（未打标，retag-fill 覆盖低）的历史条目需过分行相关性门槛（评分器 tier!=="drop"）才并入（2026-08-29 方案③ 放宽，救 gz_local 空/板块偏薄，同时挡住个股财报类噪声）；
 * - summary 优先取历史库缓存摘要（预分析回填），否则摘录 excerpt；
 * - source_type 按源等级 tier 推断（T1/T1.5 → official，其余 → media）；
 * - tags 由 subcategory 映射为中文部门 tag（财富/信贷/私行/客群）。
 */
export function mergeRollingIntoReport(
  report: DailyReport,
  rolling: ArticleInput[],
  tierBySource: Map<string, SourceTier | undefined>,
): DailyReport {
  const sectionOf = (a: ArticleInput): ReportSectionKey | null => {
    const title = a.title_cn || a.title || "";
    // 无状态源架构红线（2026-08-29 用户）：最终板块归属一律由**内容判定**，
    // 数据源的 category/subcategory 只是采集元数据，不得决定渲染分类。
    // tech/ipo 是独立内容栏目（科技前沿/IPO 动态），按内容类别归栏，其余全走内容判定。
    if (a.category === "tech") return "tech";
    if (a.category === "ipo" || a.category === "gd-ipo") {
      // 2026-08-23：已上市公司资本运作公告（定增/审核问询/购买资产/解禁等）不进 IPO 动态，
      // 与 PASS1/groupRaw 分流口径一致（诺思兰德「审核问询函」等不再污染 IPO 板块）。
      if (
        IPO_CAPITAL_ACT_RE.test(`${title} ${a.excerpt || ""}`) &&
        !IPO_FLOW_RE.test(`${title} ${a.excerpt || ""}`)
      ) {
        return null;
      }
      return "ipo";
    }
    // 广州本地：只看标题内容（广州锚 + 银行业务线），与采集分类无关——
    // 广州市政府批复（SOURCE_ROUTE 归 finance）标题含「广州」→ 进 gz_local。
    // 摘要里的「广州」是 AI 解读视角（「分行应跟踪广州房贷…」），不代表事件在广州。
    if (isGzLocalCandidate(title)) return "gz_local";
    // 政策与市场：内容判定（外地地名/政策动作/全国市场信号）→ 政策与市场；否则业务启示。
    if (isPolicyMarketCandidate(title, a.excerpt || "")) return "policy_market";
    return "biz_insight";
  };
  const seen = new Set<string>();
  for (const sec of SECTIONS) {
    for (const it of report.sections[sec] ?? []) {
      if (it.url) seen.add(it.url);
    }
  }
  const extra: Record<ReportSectionKey, ReportItem[]> = {
    gz_local: [],
    biz_insight: [],
    policy_market: [],
    tech: [],
    ipo: [],
  };
  const rankKey = new Map<string, number>(); // url → 发布时间戳，用于板块内排序
  for (const a of rolling) {
    if (!a.url || seen.has(a.url)) continue; // 今日已展示 → 跳过
    // 「符合要求」三态（2026-08-29 方案③，放宽覆盖但守业务相关性）：
    //  1. ai_relevant===true  → 无条件并入（与放宽前一致）；
    //  2. ai_relevant===false → 排除（AI 明确判无关，始终是硬门槛）；
    //  3. ai_relevant===null（未打标）→ 需过「分行相关性」门槛才并入（下方评分判定）。
    // 背景：历史库 96% 未打标，放宽前条目池仅 25 条 → 板块几乎只含今日新条目、gz_local 常空。
    // 但不能裸放行：实测 305 条未打标条目里 156 条是个股财报（九毛九/周六福/东方盛虹半年报）
    // 与外文股市噪声，裸放行会把它们灌满政策与市场/业务启示，违反 08-21「宁缺毋滥」
    // 与「业务启示必须能挂钩客群/财富/私行/信贷」的业务相关性红线。
    // 故未打标条目卡 tier!=="drop"（实测：挡掉 156 条噪声，放行 149 条带业务线标签的相关条目）。
    if (a.relevant === false) continue;
    if (a.relevant !== true) {
      const rel = scoreBranchRelevance({
        title: a.title_cn || a.title || "",
        category: a.category,
        subcategory: a.subcategory,
        sourceId: a.sourceId,
        summary: a.summary,
      });
      if (rel.tier === "drop") continue;
    }
    const sec = sectionOf(a);
    if (!sec) continue;
    const d = a.publishedAt ?? a.fetchedAt;
    const mmdd = d
      ? `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`
      : "";
    const tier = a.tier ?? tierBySource.get(a.sourceId);
    // 2026-08-23：历史缓存摘要地域一致性兜底（R3 扩展）——标题无粤地名但摘要声称
    // 「广东/广州…企业」（如北交所全国公告被模板标成「广东企业」）→ 摘要疑误，
    // 降级用原文摘录，避免错误地域信息进报告。
    let summary = (a.summary || "").trim();
    if (
      summary &&
      GD_ENTERPRISE_RE.test(summary) &&
      !FOREIGN_REGION_RE.test(a.title_cn || a.title || "")
    ) {
      summary = (a.excerpt || "").slice(0, 90).trim();
    }
    if (!summary) summary = (a.excerpt || "").slice(0, 90).trim();
    if (!summary) continue; // 无摘要且无正文 → 跳过（避免空卡片）
    // 退化卡片守卫（2026-08-29）：有效摘要若与标题**实质相同** → 只是标题复读，跳过。
    // 比较前先剥离开头的【栏目/业务线】标签前缀：历史库里大量条目的 summary 是
    // 「【财富管理】+ 原标题」（如「【财富管理】深夜，利空突袭，黄金直线跳水！…」），
    // 若只做严格相等比较会被标签前缀绕过（2026-08-29 实跑实测：biz_insight 20 条全是此类）。
    // 来源：lib/ingest/merge.ts 的 excerpt fallback（无 excerpt 时用 title 前 90 字符占位）。
    // 实测方案A 下新并入的 149 条中 96 条（64.4%）属此类，占满板块上限会稀释有效信息，
    // 违反 PRINCIPLES 原则 2（信息密度）。
    const stripTagPrefix = (s: string) => s.replace(/^(\s*【[^】]*】\s*)+/, "").trim();
    const titleText = stripTagPrefix(a.title_cn || a.title || "");
    const summaryText = stripTagPrefix(summary);
    if (
      titleText &&
      (summaryText === titleText || summaryText === titleText.slice(0, 90))
    )
      continue;
    extra[sec].push({
      url: a.url,
      title_cn: a.title_cn || a.title || "",
      title_orig: a.title_cn ? a.title : undefined,
      source: a.source || "",
      source_type: tier === "T1" || tier === "T1.5" ? "official" : "media",
      tier,
      date: mmdd,
      summary,
      importance: 2,
      rank: 0,
      tags: rollUpTags(a),
      // 无状态源架构红线（2026-08-29 用户）：locale 由内容判定（广州锚），不依赖采集分类。
      locale: isGzLocalCandidate(a.title_cn || a.title || "") ? "gz" : "national",
    });
    rankKey.set(a.url, (a.publishedAt ?? a.fetchedAt)?.getTime() ?? 0);
    seen.add(a.url);
  }
  // 板块内历史条目按发布时间倒序追加（今日 AI 条目已在数组头部保持 rank）
  for (const sec of SECTIONS) {
    extra[sec].sort((x, y) => (rankKey.get(y.url) ?? 0) - (rankKey.get(x.url) ?? 0));
    report.sections[sec] = [...report.sections[sec], ...extra[sec]];
    // 重排 rank（今日条目已由 finalizeRanks 生成，历史追加后统一重编号）
    report.sections[sec].forEach((it, i) => (it.rank = i + 1));
  }
  return report;
}

/**
 * SKIP_AI 模式执行摘要回填（2026-08-21 修复：store.json 复用断链）。
 *
 * 背景：两阶段管线改造后 daily.ts 不再调用旧 selectExecutiveSummary，
 * history/<date>/store.json（真实 AI 当日产物）成为死数据——SKIP_AI 本地预览
 * 时 must_read/insights 恒空（PASS2 不产出），尽管 store.json 里有当日 executive。
 *
 * 本函数把 store 的 ExecutiveSummary（旧 schema：must_read{title,why,url?} /
 * insights{topic,impact,action,tag?}）适配为 report 的新 schema：
 * - must_read：url 缺失时按标题在 report.sections 回匹配（Dice≥0.5），仍无则丢弃
 *   （宁缺毋滥，避免空链接卡片）；why 保留
 * - insights：tag[] → tags[]，topic/impact/action 照搬
 * - 违禁词过滤：命中 BANNED_WORDS 的 must_read/insights 丢弃（P0 合规，
 *   store 里「加密资产疯涨」这类旧产物不回流）
 */
/**
 * 商机洞察来源回链在 AI 生成阶段完成（executive-summary.ts 的 resolveInsightSources，
 * 用生成时看到的 inputs 含真实 URL 回链），结果随 store.json 落库复用；本函数仅透传。
 */
export function mergeStoredExecutive(
  report: DailyReport,
  exec: {
    hero_line?: string;
    must_read: Array<{ title: string; why: string; url?: string }>;
    insights: Array<{ topic: string; impact: string; action: string; tag?: string[]; sources?: Array<{ title: string; url: string }> }>;
    // M 层：风险（M 阶段 SKIP_AI 复用 store 时透传）
    risk?: {
      topic: string;
      evidence: string;
      impact: string;
      action: string;
      url?: string;
      source?: "T1" | "T1.5" | "T2";
      sources?: Array<{ title: string; url: string }>;
    };
  },
): DailyReport {
  const banned = new Set(BANNED_WORDS);
  const bannedIn = (s: string): boolean => banned.has(s) || BANNED_WORDS.some((w) => s.includes(w));

  // 标题 → url 回匹配：先宽松前缀包含（store 标题常是 sections 标题的精简版，
  // 如「8月LPR不变，房贷或续降」⊂「8月LPR保持不变，今年房贷还能否下调？」），
  // 再 Dice≥0.4 兜底（措辞改写宽容）。
  // 不可变：复制入参，全程只改 out，最后返回 out（不污染调用方的 report）
  const out: DailyReport = { ...report };
  const allItems: ReportItem[] = SECTIONS.flatMap((s) => report.sections[s] ?? []);
  const matchUrl = (title: string): string | undefined => {
    if (!title) return undefined;
    const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
    const nt = norm(title);
    if (!nt) return undefined;
    let best: { url: string; score: number } | undefined;
    for (const it of allItems) {
      const t = it.title_cn || it.title_orig || "";
      if (!t) continue;
      const nti = norm(t);
      if (nti.includes(nt) || nt.includes(nti)) return it.url; // 包含关系直接命中
      const score = titleSimilarityDice(title, t);
      if (score >= 0.4 && (!best || score > best.score)) best = { url: it.url, score };
    }
    return best?.url;
  };

  // must_read 回填（保留 url 显式携带的，其余按标题回匹配，无匹配丢弃）
  const must: ReportMustRead[] = [];
  for (const m of exec.must_read ?? []) {
    if (!m || !m.why || bannedIn(`${m.title} ${m.why}`)) continue;
    const url = m.url || matchUrl(m.title);
    if (!url) continue; // 无法定位到报告内条目 → 丢弃（宁缺毋滥）
    must.push({ url, why: m.why, ...(m.title ? { title: m.title } : {}) });
  }
  if (must.length > 0) out.must_read = must;

  // insights 回填（tag[] → tags[]，违禁过滤；sources：store 已含（生成时回链），原样透传）
  const insights: ReportInsight[] = [];
  for (const it of exec.insights ?? []) {
    if (!it || !it.topic || bannedIn(JSON.stringify(it))) continue;
    const sources = Array.isArray(it.sources) && it.sources.length > 0
      ? it.sources.slice(0, 3).filter((s) => s && s.url).map((s) => ({ title: s.title || "", url: s.url }))
      : [];
    insights.push({
      topic: it.topic,
      tags: Array.isArray(it.tag) ? it.tag.slice(0, 6) : [],
      impact: it.impact || "",
      action: it.action || "",
      ...(sources.length > 0 ? { sources } : {}),
    });
  }
  if (insights.length > 0) out.insights = insights;

  // M 层：风险回填（store.json 复用路径，SKIP_AI 必走此处）。evidence/impact/action 任一违禁 → 整条丢弃。
  if (exec.risk && exec.risk.topic) {
    const r = exec.risk;
    const corpus = `${r.topic} ${r.evidence} ${r.impact} ${r.action}`;
    if (!bannedIn(corpus)) {
      const sources = Array.isArray(r.sources) && r.sources.length > 0
        ? r.sources.slice(0, 3).filter((s) => s && s.url).map((s) => ({ title: s.title || "", url: s.url }))
        : [];
      out.risk = {
        topic: r.topic,
        evidence: r.evidence || "",
        impact: r.impact || "",
        action: r.action || "",
        ...(r.url ? { url: r.url } : {}),
        ...(r.source ? { source: r.source } : {}),
        ...(sources.length > 0 ? { sources } : {}),
      };
    }
  }

  // hero_line 回填：SKIP_AI 的弱兜底非空但无定调价值 → 视为缺省，用 store 的 hero_line
  //（真实 AI 当日定调）或回填成功的 must_read 首条生成「今日关注：xxx」覆盖（2026-08-21 用户反馈）。
  // 弱兜底两种形态：pipeline.ts 的「今日更新 N 条资讯：<PASS2首条>」+ degrade ⑦ 的
  // HERO_FALLBACK「今日暂无可推送重点」（SKIP_AI 下 PASS2 必读为空触发 R12 → 降级）。
  const heroIsWeakFallback =
    !report.hero_line ||
    /^今日更新\s*\d+\s*条资讯/.test(report.hero_line) ||
    /今日暂无可推送重点/.test(report.hero_line);
  if (heroIsWeakFallback) {
    if (exec.hero_line) {
      out.hero_line = exec.hero_line;
    } else if (must.length > 0) {
      const it = allItems.find((x) => x.url === must[0].url);
      if (it) out.hero_line = `今日关注：${it.title_cn || it.title_orig || ""}`.slice(0, 70);
    }
  }
  return out;
}

export function renderHtml(
  report: DailyReport,
  date: string,
  opts: { audio?: AudioMeta } = {},
): string {
  // 跨板块去重（一文一卡）：同一 URL 只展示一次，优先级
  // 广州本地 > 业务启示 > 政策与市场 > 科技前沿 > IPO。
  const seen = new Set<string>();
  const dedupe = (list: ReportItem[]): ReportItem[] => {
    // 同板块内二次去重：来自不同源、标题完全一致（归一化后）、且权威等级
    // 相同的条目只留一条（用户规则：同权威等级留一个，避免通稿被多源重复刷屏）。
    const seenTitleTier = new Set<string>();
    const normTitle = (t: string): string =>
      (t || "")
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "");
    const authorityOf = (it: ReportItem): string =>
      it.tier ?? (it.source_type === "official" ? "T1" : "T2");
    return list.filter((it) => {
      if (it.url && seen.has(it.url)) return false;
      const key = `${normTitle(it.title_cn || it.title_orig || "")}|${authorityOf(it)}`;
      if (seenTitleTier.has(key)) return false;
      if (it.url) seen.add(it.url);
      seenTitleTier.add(key);
      return true;
    });
  };

  const gzLocal = dedupe(report.sections?.gz_local ?? []);
  const bizInsight = dedupe(report.sections?.biz_insight ?? []);
  const policyMarket = dedupe(report.sections?.policy_market ?? []);
  const techAll = dedupe(report.sections?.tech ?? []);
  const ipoAll = dedupe(report.sections?.ipo ?? []);
  // 股市动态（底部消息清单，非 AI 生成）：直接来自 report.stock_news（三市场原始新闻）
  const stockNews = (report.stock_news ?? []).filter((it) => it.url);

  // 中文日期「8月22日 星期六」：用 UTC 解析避免 CI(UTC) runner 的本地时区偏移
  // 导致 getDay() 算错一天（例：2026-08-22 在 UTC 下被当作 8/21 星期五）。
  const zhDate = (() => {
    const [yy, mm, dd] = date.split("-").map(Number);
    const w = ["日", "一", "二", "三", "四", "五", "六"][new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()];
    return `${mm}月${dd}日 星期${w}`;
  })();

  // 2026-08-29 原则5 失败可见：gz_local 板块即使 0 条也常驻展示并显式提示「今日无广州本地要闻」，
  // 避免静默消失让行长误以为系统缺数/漏采（其余板块仍按 count>0 取舍）。
  const tabs = [
    { id: "p-gz", label: "广州本地", section: "gz_local", cls: "var(--c-gz)", count: gzLocal.length, items: gzLocal, alwaysShow: true, emptyHint: "今日暂无广州本地要闻（本地源未捕捉到高价值广州事件）。大湾区/广东要闻可在「政策与市场」查看。" },
    { id: "p-stock", label: "股市动态", section: "stock_news", cls: "var(--c-trading)", count: stockNews.length, items: stockNews, alwaysShow: false, emptyHint: "今日暂无股市动态" },
    { id: "p-biz", label: "业务启示", section: "biz_insight", cls: "var(--c-biz)", count: bizInsight.length, items: bizInsight, alwaysShow: false, emptyHint: "今日暂无业务启示" },
    { id: "p-pol", label: "政策与市场", section: "policy_market", cls: "var(--c-pol)", count: policyMarket.length, items: policyMarket, alwaysShow: false, emptyHint: "今日暂无政策与市场动态" },
    { id: "p-tech", label: "科技前沿", section: "tech", cls: "var(--c-tech)", count: techAll.length, items: techAll, alwaysShow: false, emptyHint: "今日暂无科技前沿" },
    // 2026-08-25 用户决定：IPO 功能全部废弃（明天重新设计方案），tab 隐藏（代码保留）
    // { id: "p-ipo", label: "IPO动态", section: "ipo", cls: "var(--c-ipo)", count: ipoAll.length, items: ipoAll },
  ].filter((t) => t.count > 0 || t.alwaysShow);

  const totalItems = gzLocal.length + bizInsight.length + policyMarket.length + techAll.length;
  // 数据截止时间用北京时间（Asia/Shanghai，UTC+8 无夏令时）。此前 toTimeString()
  // 在 CI（ubuntu=UTC）下显示 UTC 时间（如 11:14 实为北京 19:14），误导读者。
  const nowHm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  const hero = report.hero_line?.trim();
  // 微信/QQ/推特 等转发卡片元信息：默认 gh-pages 根，可用 REPORT_BASE_URL 覆盖
  const shareBase = process.env.REPORT_BASE_URL || "https://shengc-shv.github.io/gzcmbdf3";
  const shareTitle = `${STR.siteTitle} · ${date}`;
  const shareDesc = hero
    ? `今日定调：${hero}`
    : "广州地区零售业务每日资信简报（个人整理，非本行立场）";

  return `<!doctype html>
<html lang="${REPORT_LOCALE === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${shareTitle}</title>
<meta name="description" content="${escapeHtml(shareDesc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(shareTitle)}">
<meta property="og:description" content="${escapeHtml(shareDesc)}">
<meta property="og:image" content="${shareBase}/og-image.png">
<meta property="og:image:width" content="240">
<meta property="og:image:height" content="240">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(shareTitle)}">
<meta name="twitter:description" content="${escapeHtml(shareDesc)}">
<meta name="twitter:image" content="${shareBase}/og-image.png">
<style>
${THEME_CSS}
${AUDIO_HIGHLIGHT_CSS}
  </style>
</head>
<body>
<main>
    ${opts.audio ? `<div class="player-card">
    <div class="player-title"><span class="ic">🎧</span> 今日语音简报 <span class="player-dur">${escapeHtml(opts.audio.duration)}</span>${opts.audio.backend ? `<span class="player-badge player-badge-${opts.audio.backend}">${opts.audio.backend === "tencent" ? "腾讯合成" : "开源合成"}</span>` : ""}</div>
    <audio controls preload="none" src="${escapeHtml(opts.audio.src)}" id="audio-player"></audio>
    ${opts.audio.segments && opts.audio.segments.length ? `<script type="application/json" id="audio-segments">${escapeHtml(JSON.stringify(opts.audio.segments))}</script>` : ""}
  </div>` : ""}
  <!-- 报头：今日定调 + 数据截至 -->
  <header class="masthead">
    <div class="eyebrow">广州地区 · 零售业务每日资信（个人整理，非本行立场）</div>
    <h1>${zhDate}</h1>
    ${hero ? `<p class="hero-line">今日定调：${escapeHtml(hero)}</p>` : ""}
    <p class="meta-line">数据截至 ${nowHm} · 去重后资讯 ${totalItems} 条 · 商机 ${report.insights?.length ?? 0} 条${process.env.WEB_MODE === "true" ? ` · <a class="archive" href="../archive.html">${STR.archiveLink}</a>` : ""}</p>
  </header>

  ${renderReportExec(report)}

  ${renderStockRecap(report)}

  <!-- 板块导航：单层 tab，移动端横滑不折行 -->
  <nav class="tabs">
    ${tabs.map((t, i) => `<button class="tab${i === 0 ? " active" : ""}" data-target="${t.id}" style="--cat:${t.cls}">${t.label}<span class="n">${t.count}</span></button>`).join("")}
  </nav>

  ${tabs.map((t, i) => `<section class="panel${i === 0 ? " active" : ""}" id="${t.id}">
    ${t.id === "p-stock" ? renderStockFilterBar() : renderFilterBarForPanel(t.items)}
    ${t.items.length ? renderReportCardList(t.items, true) : `<p class="empty-hint">${escapeHtml(t.emptyHint || "今日暂无相关内容")}</p>`}
  </section>`).join("")}

  <footer>
    <p>免责声明：本页面为个人学习项目，内容基于公开信息整理，不代表任何机构立场；市场信息不构成投资建议。页面面向内部参考，请勿外传。</p>
    ${process.env.WEB_MODE === "true" ? `<p><a class="archive" href="../archive.html">${STR.archiveLink}（8月20日 / 8月19日 / 更多 →）</a></p>` : ""}
  </footer>
</main>
<script>
  // tab 切换（单层五板块）
  document.querySelectorAll('.tabs > .tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.dataset.target;
      document.querySelectorAll('.tabs > .tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('.panel').forEach(function (p) {
        p.classList.toggle('active', p.id === target);
      });
    });
  });
  // 空板块保险：panel 无卡片则连同 tab 移除
  document.querySelectorAll('.panel').forEach(function (panel) {
    if (panel.querySelectorAll('.brief').length === 0) {
      var tab = document.querySelector('.tab[data-target="' + panel.id + '"]');
      if (tab) tab.remove();
      panel.remove();
    }
  });
  // 展开其余 N 条
  document.querySelectorAll('.expand-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = btn.closest('.panel');
      if (panel) panel.classList.add('expanded');
      btn.remove();
    });
  });
  // 板块内标签筛选（两维度：来源 OR、业务线 OR；维度间 AND；全不选 / 全选 = 全部显示）
  document.querySelectorAll('.filter-bar').forEach(function (bar) {
    var panel = bar.closest('.panel');
    if (!panel) return;
    bar.addEventListener('click', function (e) {
      var chip = e.target.closest('.filter-chip');
      if (chip) { chip.classList.toggle('active'); applyFilter(panel, bar); return; }
      if (e.target.closest('.filter-reset')) {
        bar.querySelectorAll('.filter-chip.active').forEach(function (c) { c.classList.remove('active'); });
        applyFilter(panel, bar);
      }
    });
  });
  function applyFilter(panel, bar) {
    var chips = bar.querySelectorAll('.filter-chip');
    var active = Array.prototype.filter.call(chips, function (c) { return c.classList.contains('active'); });
    var btn = panel.querySelector('.expand-btn');
    // 全不选（重置）或全选 → 全部显示，并恢复「前 5 展示 + 其余折叠」的默认布局
    if (active.length === 0 || active.length === chips.length) {
      panel.classList.remove('expanded');
      if (btn) btn.style.display = '';
      panel.querySelectorAll('.brief').forEach(function (card) { card.classList.remove('filtered-out'); });
      return;
    }
    // 筛选生效：自动展开折叠区——命中项（含原折叠区内）无需再点「展开」即可见，
    // 与查询结果刷新的预期联动；隐藏展开按钮，避免出现「仍提示折叠 N 条」的错位。
    panel.classList.add('expanded');
    if (btn) btn.style.display = 'none';
    // 按维度（data-group）分组收集选中值
    var selByGroup = {};
    active.forEach(function (c) {
      var g = c.getAttribute('data-group');
      (selByGroup[g] = selByGroup[g] || []).push(c.getAttribute('data-filter'));
    });
    panel.querySelectorAll('.brief').forEach(function (card) {
      var src = card.getAttribute('data-source');
      var tags = (card.getAttribute('data-tags') || '').split(' ').filter(Boolean);
      var market = card.getAttribute('data-market');
      var ok = true;
      for (var g in selByGroup) {
        var sel = selByGroup[g];
        if (g === 'src') {
          // 维度内 OR：命中官方 / 媒体 其一即满足
          if (sel.indexOf(src) < 0) { ok = false; break; }
        } else if (g === 'market') {
          // 股市动态面板：按 A股 / 港股 / 美股 过滤（维度内 OR）
          if (sel.indexOf(market) < 0) { ok = false; break; }
        } else {
          // 维度内 OR：命中业务线其一即满足；「__none__」（其他）命中空标签卡片
          var hit = sel.some(function (f) {
            if (f === '__none__') return tags.length === 0; // 其他 = 无 4 部门标签
            return tags.indexOf(f) >= 0;
          });
          if (!hit) { ok = false; break; }
        }
      }
      card.classList.toggle('filtered-out', !ok);
    });
  }
</script>
${opts.audio?.segments && opts.audio.segments.length ? `<script>
${generateAudioHighlightScript()}
</script>` : ""}
</body>
</html>`;
}

// ----- trading panel -----

const SIGNAL_TONE: Record<string, "bull" | "bear" | "caution"> = {
  "golden-cross": "bull",
  "macd-bull-cross": "bull",
  "above-sma50-sma200": "bull",
  "near-52w-high": "bull",
  "death-cross": "bear",
  "macd-bear-cross": "bear",
  "below-sma50-sma200": "bear",
  "near-52w-low": "bear",
  "rsi-overbought": "caution",
  "rsi-oversold": "caution",
};

// ----- markdown（新管线 schema: report.sections）-----

export function renderMarkdown(report: DailyReport, date: string): string {
  const blocks: string[] = [];
  blocks.push(`# ${STR.siteTitle} · ${date}\n`);
  if (report.hero_line) blocks.push(`> ${report.hero_line}\n`);

  const secMap: [string, ReportSectionKey][] = [
    ["广州本地", "gz_local"],
    ["业务启示", "biz_insight"],
    ["政策与市场", "policy_market"],
    ["科技前沿", "tech"],
    ["IPO动态", "ipo"],
  ];
  for (const [label, key] of secMap) {
    const items = report.sections?.[key] ?? [];
    if (items.length === 0) {
      if (key === "gz_local") blocks.push(`## 广州本地\n\n（今日无广州本地要闻）\n`);
      continue;
    }
    const body = items
      .map(
        (it) =>
          `### [${it.title_cn || it.title_orig || ""}](${it.url})\n${it.source} · ${it.source_type === "official" ? "官方" : "媒体"} · 重要度 ${it.importance}/3\n\n${it.summary}\n`,
      )
      .join("\n");
    blocks.push(`## ${label}\n\n${body}\n`);
  }

  if (report.must_read.length > 0) {
    blocks.push(
      `## 今日必读\n\n${report.must_read
        .map((m, i) => `${i + 1}. ${m.url}${m.why ? ` — ${m.why}` : ""}`)
        .join("\n")}\n`,
    );
  }
  if (report.insights.length > 0) {
    blocks.push(
      `## 商机洞察\n\n${report.insights
        .map((it) => `- **${it.topic}**${it.impact ? `：影响 ${it.impact}` : ""}${it.action ? ` → 动作 ${it.action}` : ""}`)
        .join("\n")}\n`,
    );
  }
  return blocks.filter(Boolean).join("\n");
}
