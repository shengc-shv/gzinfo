/**
 * 渲染卡片/面板（M3-C 二期拆分自 lib/output/render.ts）：
 * 单篇文章卡片、来源 tab、L2 子面板、分类面板与共享类型。
 */
import type { ArticleInput } from "../../types";
import type { Category } from "../../sources/types";
import { STR, SUBCATEGORY_ORDER, SUBCATEGORY_LABELS } from "./i18n";
import { TIER_COLORS } from "./theme";
import { SOURCE_TIER_LABELS, SOURCE_TIER_ORDER, type SourceTier } from "../../sources/tiers";
import { REPORT_LOCALE } from "../../sources/registry";
import { getReportTz } from "../../utils";

// ----- types -----
export type SourceGroup = {
  sourceId: string;
  sourceName: string;
  items: ArticleInput[];
  /**
   * When true, items come from multiple merged sources and the renderer
   * should label each article with `a.source` since the source-tab row
   * is suppressed (only one synthetic group).
   */
  merged?: boolean;
};

export type SubGroup = {
  id: string;
  name: string;
  sources: SourceGroup[];
};

export type RawByCategory = Record<Category, SubGroup[]>;

export const CATEGORY_LABELS: Record<Category, string> = {
  tech: STR.catTech,
  finance: STR.catFinance,
  politics: STR.catPolitics,
  'gd-ipo': '广东地区IPO',
  ipo: STR.catIpo,
  gz: '广州商机',
  stocks: '昨日股市',
};

export const CATEGORY_DIGEST_LABELS: Record<Category, string> = {
  tech: STR.catTech,
  finance: STR.catFinance,
  politics: STR.catPolitics,
  'gd-ipo': STR.catGdIpo,
  ipo: STR.catIpo,
  gz: '广州商机',
  stocks: '昨日股市',
};

/**
 * 展示窗口（天）：所有面板统一展示最近 N 天发布的内容，按发布时间倒序。
 * （2026-08-19 用户调整：不再区分「当天/过去7天」时间拆分；2026-08-22 改为与
 * 抓取窗口一致，只展示最近 2 天发布的内容，抓取窗口见 history.ts 的 FETCH_WINDOW_DAYS。）
 */
export const DISPLAY_WINDOW_DAYS = 2;



export const TECH_MAIN_SUBS = new Set(["cn-tech", "overseas-tech"]);
export const TECH_COMMUNITY_SUBS = new Set(["cn-community", "overseas-community"]);

// ----- HTML helpers -----

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 该日期是否只到「日」精度（无真实时分）：
 * 爬虫/直抓源只有 URL 日期时存在两种存储形态——国内源存 UTC 零点
 * （T00:00:00.000Z = 北京 08:00）、ftchinese 存北京时间零点
 * （T16:00:00.000Z = 北京次日 00:00）。任一命中即视为「只有日期」，
 * 卡片时间只展示 YYYY-MM-DD；有真实时分的 RSS 源两者均不命中 → 展示时分。
 */
export function isDateOnly(d: Date | undefined): boolean {
  if (!d) return false;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) {
    return true; // UTC 零点存储形态
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: getReportTz(),
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return fmt.format(d) === "00:00"; // 报告时区零点存储形态（如 ftchinese 北京 0 点）
  } catch {
    return false;
  }
}

export function formatDate(d: Date | undefined): string {
  if (!d) return "";
  try {
    // 只有日期（无时分）→ 展示日期；有真实时分 → 展示 MM/DD HH:mm
    // （2026-08-21 用户要求：有小时分钟展示到小时分钟，没有则展示日期）
    if (isDateOnly(d)) return tzDateStr(d);
    // zh: "05/20 16:00"  · en: "May 20, 4:00 PM" → keep 24h en-GB style "20/05 16:00"
    const localeTag = REPORT_LOCALE === "en" ? "en-GB" : "zh-CN";
    return d.toLocaleString(localeTag, {
      timeZone: getReportTz(),
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

// ----- raw article renderers -----

/** 广州严格锚（2026-08-21 重构 #9：「广州本地」板块严格过滤，宁缺毋滥） */
export const GZ_ANCHOR_RE =
  /广州|穗|天河|海珠|越秀|荔湾|白云|黄埔|番禺|南沙|增城|从化|花都|琶洲|珠江新城|白鹅潭|广州开发区|中新知识城/;

/**
 * 广州本地业务相关性红线（2026-08-29 用户拍板：广州本地板块须与客群/财富/私行/信贷挂钩）。
 * 「广州本地」是稀缺位，植物园志愿者、公安暂停服务、学校上新这类本地生活政务
 * 虽含广州锚，但与零售银行业务无关，不应占用该板块（宁缺毋滥的补充门槛）。
 */
export const GZ_BUSINESS_RE =
  /银行|信贷|房贷|按揭|消费|理财|财富|私行|基金|保险|投资|金融|楼市|购房|房地产|房价|IPO|上市|融资|企业|商户|就业|消费券|补贴|利率|存款|黄金|代发|客群|公积金|税务|社保|外贸|出口|制造|经济|项目|商圈/;

/** 是否为「广州本地板块」候选：内容含广州锚 + 与银行业务相关（两个条件都按内容判定）。 */
export function isGzLocalCandidate(title: string, excerpt = ""): boolean {
  const text = `${title} ${excerpt}`;
  return GZ_ANCHOR_RE.test(text) && GZ_BUSINESS_RE.test(text);
}

/** 来源徽章（2026-08-21 重构 #12：来源降级为卡片左上角徽章，扫一眼即知可信度） */
export function srcBadgeOf(a: ArticleInput): { label: string; cls: string } {
  const sid = a.sourceId || "";
  if (a.tier === "T1") {
    if (sid === "govcn-policy") return { label: "政策", cls: "src-official" };
    if (sid === "pbc") return { label: "央行", cls: "src-official" };
    if (sid === "nfra") return { label: "监管", cls: "src-official" };
    if (sid === "fed-press") return { label: "央行", cls: "src-official" };
    if (a.category === "ipo" || a.category === "gd-ipo") return { label: "交易所", cls: "src-official" };
    return { label: "官方", cls: "src-official" };
  }
  if (a.tier === "T1.5") {
    if (a.category === "ipo" || a.category === "gd-ipo") return { label: "交易所", cls: "src-official" };
    return { label: "机构", cls: "src-official" };
  }
  if (a.subcategory === "news") return { label: "海外", cls: "src-media" };
  return { label: "媒体", cls: "src-media" };
}

export function renderArticleHtml(a: ArticleInput, showSource = false): string {
  const title = escapeHtml(a.title_cn || a.title);
  const url = escapeHtml(a.url);
  // Backwards-compat: old sidecar JSON files may carry `cnSummary` instead.
  const summaryText = a.summary ?? (a as unknown as { cnSummary?: string }).cnSummary;
  const summary = summaryText ? escapeHtml(summaryText) : "";
  const time = formatDate(a.publishedAt ?? a.fetchedAt);
  const badge = srcBadgeOf(a);
  const srcName = showSource && a.source ? escapeHtml(a.source) : "";
  const bm = [badge.label, srcName, time].filter(Boolean);
  return `<article class="brief">
  <div class="bm"><span class="src-badge ${badge.cls}">${badge.label}</span>${srcName ? `<span>${srcName}</span>` : ""}${time ? `<span>${time}</span>` : ""}</div>
  <h3><a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a></h3>
  ${summary ? `<p class="sum">${summary}</p>` : ""}
</article>`;
}

/**
 * 面板卡片列表（2026-08-21 重构 #13：每板块默认 Top 5 + 「展开其余 N 条」）。
 * 前 5 条直接展示；多于 5 条的隐藏于 .brief.more，底部虚线按钮点击展开（panel 加 expanded）。
 */
export function renderCardList(items: ArticleInput[], showSource = true): string {
  if (items.length === 0) return `<p class="empty">${STR.emptySource}</p>`;
  const top = items.slice(0, 5);
  const more = items.slice(5);
  let html = top.map((a) => renderArticleHtml(a, showSource)).join("\n");
  if (more.length > 0) {
    html +=
      more.map((a) => renderArticleHtml(a, showSource).replace('<article class="brief">', '<article class="brief more">')).join("\n") +
      `<button class="expand-btn" type="button">展开其余 ${more.length} 条</button>`;
  }
  return html;
}

export function renderSourceContent(
  category: Category,
  subId: string,
  source: SourceGroup,
  isActive: boolean,
): string {
  const showSource = source.merged === true;
  return `<div class="source-content${isActive ? " active" : ""}" data-source-content="${escapeHtml(source.sourceId)}" data-sub="${escapeHtml(subId)}" data-cat="${category}">
    ${source.items.length === 0 ? `<p class="empty">${STR.emptySource}</p>` : source.items.map((a) => renderArticleHtml(a, showSource)).join("\n")}
  </div>`;
}

/**
 * 合并流按权威等级拆「官方 / 媒体」两个子标签 tab（任务三 #43 改版）：
 * 官方 tab 默认展示（T1 官方一手 + T1.5 准官方·机构），媒体 tab（T2 媒体·智库）。
 * 广州商机面板（单一 gz-all 合并流）同样采用此结构（2026-08-21 用户）。
 * 拆分只在渲染层，过滤/去重逻辑不变；tab 内仍按 sortByTierAndTime 排序。
 */
function isOfficialTier(tier?: SourceTier): boolean {
  return tier === "T1" || tier === "T1.5";
}

function renderBandPanel(kind: string, items: ArticleInput[], showSource: boolean, active = false): string {
  const body =
    items.length === 0
      ? `<p class="empty">${STR.emptySource}</p>`
      : items.map((a) => renderArticleHtml(a, showSource)).join("\n");
  return `<div class="band-panel${active ? " active" : ""}" data-band-panel="${kind}">${body}</div>`;
}

export function renderBandedFeed(items: ArticleInput[], showSource = false): string {
  const official = sortByTierAndTime(items.filter((a) => isOfficialTier(a.tier)));
  const media = sortByTierAndTime(items.filter((a) => !isOfficialTier(a.tier)));
  const tabs = `<nav class="band-tabs">
    <button class="band-tab active" data-band="official">${escapeHtml(STR.bandOfficial)}<span class="count">${official.length}</span></button>
    <button class="band-tab" data-band="media">${escapeHtml(STR.bandMedia)}<span class="count">${media.length}</span></button>
  </nav>`;
  return `${tabs}${renderBandPanel("official", official, showSource, true)}${renderBandPanel("media", media, showSource)}`;
}

export function renderSourceTabs(
  category: Category,
  subId: string,
  sources: SourceGroup[],
): string {
  // L3 信息源 tabs 已停用（2026-08-21 用户要求：渲染只到子标签）：
  // 所有子标签统一构造成单一 _merged source（merged:true），此处恒返回空串，
  // 来源信息降级为卡片 meta 行的来源小字。
  if (sources.length < 2) return "";
  return `<nav class="source-tabs">${sources
    .map(
      (s, i) =>
        `<button class="source-tab${i === 0 ? " active" : ""}" data-source="${escapeHtml(s.sourceId)}" data-sub="${escapeHtml(subId)}" data-cat="${category}">${escapeHtml(s.sourceName)}<span class="count">${s.items.length}</span></button>`,
    )
    .join("")}</nav>`;
}

/**
 * 部门中文 tag 映射（与 render.ts SUB_TO_TAG 同源，避免跨模块循环依赖）。
 * 4 大零售部门 = 财富 / 私行 / 客群 / 信贷（2026-08-22 用户口径）。
 */
const DEPT_SUB_TO_TAG: Record<string, string> = {
  "gz-wealth": "财富",
  "cn-wealth": "财富",
  "gz-credit": "信贷",
  "cn-credit": "信贷",
  "gz-private": "私行",
  "cn-private": "私行",
  "gz-customer": "客群",
  "cn-customer": "客群",
};

/** 是否命中 4 大零售部门标签（subcategory 映射）。 */
export function hasDeptTag(a: ArticleInput): boolean {
  const subs =
    a.subcategories && a.subcategories.length > 0
      ? a.subcategories
      : a.subcategory
        ? [a.subcategory]
        : [];
  return subs.some((s) => DEPT_SUB_TO_TAG[s] !== undefined);
}

/**
 * 子标签内统一排序（2026-08-22 用户：无 4 部门标签的条目排最后，优先展示带标签的）：
 * ① 4 部门标签命中优先（带标签 > 无标签）；
 * ② 时间精度：有真实时分 > 只有日期 > 无发布时间（「只有日期的放最后」）；
 * ③ 同精度内按 信息源权威等级（T1 > T1.5 > T2）升序；
 * ④ 同等级内按发布时间倒序（最新在前）。
 */
export function sortByTierAndTime<T extends ArticleInput>(list: T[]): T[] {
  const precision = (a: ArticleInput): number => {
    if (!a.publishedAt) return 2; // 无发布时间 → 最沉底
    return isDateOnly(a.publishedAt) ? 1 : 0; // 只有日期 → 次沉底
  };
  return [...list].sort((a, b) => {
    const da = hasDeptTag(a) ? 0 : 1;
    const db = hasDeptTag(b) ? 0 : 1;
    if (da !== db) return da - db; // 带标签优先
    const pa = precision(a);
    const pb = precision(b);
    if (pa !== pb) return pa - pb;
    const ra = a.tier ? (SOURCE_TIER_ORDER[a.tier] ?? 0) : 0;
    const rb = b.tier ? (SOURCE_TIER_ORDER[b.tier] ?? 0) : 0;
    if (ra !== rb) return rb - ra;
    const ta = (a.publishedAt ?? a.fetchedAt)?.getTime() ?? 0;
    const tb = (b.publishedAt ?? b.fetchedAt)?.getTime() ?? 0;
    return tb - ta;
  });
}

/**
 * 保留每个源中「最近 days 天」的条目，并按 sortByTierAndTime 排序
 * （tier 权威等级 + 发布时间，只有日期的放最后）。
 * 时间判定统一为 `publishedAt ?? fetchedAt`（2026-08-19 用户确认：
 * 没有发布时间的采用信息采集时间）；两者皆无的保留（时间未知）。
 */
export function filterRecentDays(sources: SourceGroup[], days = DISPLAY_WINDOW_DAYS): SourceGroup[] {
  const cutoff = Date.now() - days * 86_400_000;
  return sources.map((s) => {
    const items = s.items
      .filter((a) => {
        const t = a.publishedAt ?? a.fetchedAt;
        if (!t) return true;
        return t.getTime() >= cutoff;
      });
    return { ...s, items: sortByTierAndTime(items) };
  });
}

let _tzFmt: Intl.DateTimeFormat | undefined;
/** Report-timezone date string "YYYY-MM-DD" for a Date. */
export function tzDateStr(d: Date): string {
  if (!_tzFmt) {
    _tzFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: getReportTz(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return _tzFmt.format(d);
}


export function countItems(sources: SourceGroup[]): number {
  return sources.reduce((n, s) => n + s.items.length, 0);
}

/** 最近 N 天（默认 DISPLAY_WINDOW_DAYS）的条数合计——顶部 tab 徽标。 */
export function countItemsRecent(subs: SubGroup[], days = DISPLAY_WINDOW_DAYS): number {
  return subs.reduce((n, sg) => n + countItems(filterRecentDays(sg.sources, days)), 0);
}

export function renderSourcesBlock(
  category: Category,
  subId: string,
  sources: SourceGroup[],
): string {
  if (sources.length === 0) {
    return `<p class="empty">${STR.emptySource}</p>`;
  }
  // 合并流（子标签内单一 _merged 源）：按权威等级拆「官方 / 媒体」tab（任务三 #43 改版）
  // 广州商机面板的单一 gz-all 合并流同样走此结构（2026-08-21 用户）。
  if (sources.length === 1 && sources[0].merged === true) {
    return renderBandedFeed(sources[0].items, true);
  }
  return `${renderSourceTabs(category, subId, sources)}
  <div class="source-contents">
    ${sources.map((s, i) => renderSourceContent(category, subId, s, i === 0)).join("\n")}
  </div>`;
}

/**
 * 广东地区 IPO 各上市阶段对应的「股份行广州分行商机线索」（任务二）。
 * 静态规则提示，帮助零售条线领导从 IPO 动态中快速定位可跟进的商机动作。
 */
const GD_IPO_STAGE_BIZ: Record<string, string> = {
  "stage-listed":
    "商机线索 · 已上市新股：可跟进 员工持股计划/股权激励理财、高管私行、募资后代发工资",
  "stage-registered":
    "商机线索 · 注册生效·过会（即将发行）：募资入账在即，可对接 机构合作、代发工资、员工财富管理",
  "stage-reviewing":
    "商机线索 · 在审·已受理：Pre-IPO 授信、投贷联动、员工持股计划储备商机",
  "stage-tutoring":
    "商机线索 · 辅导备案·Pre-IPO（最佳商机）：Pre-IPO 授信、投贷联动、代发工资、高管私行、员工持股托管",
};

export function renderSubContent(category: Category, sub: SubGroup, isActive: boolean, date: string): string {
  const activeCls = isActive ? " active" : "";
  const subAttr = `data-sub-content="${escapeHtml(sub.id)}" data-cat="${category}"`;

  // 空 sub 直接占位
  if (sub.sources.length === 0) {
    return `<div class="sub-content${activeCls}" ${subAttr}><p class="empty">${STR.emptySource}</p></div>`;
  }

  // 统一展示窗口（2026-08-19 用户调整）：所有分类展示最近 DISPLAY_WINDOW_DAYS 天
  // 发布的内容，按发布时间倒序；不再区分「当天 / 过去7天」时间拆分。
  const recent = filterRecentDays(sub.sources, DISPLAY_WINDOW_DAYS);
  // 任务二：广东地区 IPO 各阶段栏顶部注入「股份行广州分行商机线索」提示
  const bizTip = category === "gd-ipo" ? GD_IPO_STAGE_BIZ[sub.id] : undefined;
  return `<div class="sub-content${activeCls}" ${subAttr}>
    ${bizTip ? `<p class="biz-tip">${escapeHtml(bizTip)}</p>` : ""}
    ${renderSourcesBlock(category, sub.id, recent)}
  </div>`;
}

export function renderRawCategoryPanel(
  category: Category,
  subs: SubGroup[],
  date: string,
): string {
  if (subs.length === 0) {
    return `<p class="empty">${STR.emptyCategory}</p>`;
  }
  if (subs.length === 1) {
    return renderSubContent(category, subs[0], true, date);
  }
  const subTabs = subs
    .map((s, i) => {
      // 计数与内容口径一致：最近 DISPLAY_WINDOW_DAYS 天、按发布时间倒序
      const count = countItems(filterRecentDays(s.sources, DISPLAY_WINDOW_DAYS));
      return `<button class="sub-tab${i === 0 ? " active" : ""}" data-sub="${escapeHtml(s.id)}" data-cat="${category}">${escapeHtml(s.name)}<span class="count">${count}</span></button>`;
    })
    .join("");
  const panels = subs
    .map((s, i) => renderSubContent(category, s, i === 0, date))
    .join("\n");
  return `<nav class="sub-tabs">${subTabs}</nav>\n<div class="sub-contents">${panels}</div>`;
}
