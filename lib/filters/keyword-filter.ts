/**
 * 关键词漏斗（边界③最前端，零成本）。
 *
 * 消费 sources.keywords.json（银行零售业务关键词体系 v4），对每条文章做
 * 三级过滤：L0 全局硬排除 → 地域分 → 维度命中 → 商机触发。
 * 未命中一律 pass=false（硬过滤，不进任何 AI 调用）。
 *
 * 匹配语义（v1 实现约定）：
 *  - L0 global_exclude 仅匹配标题（配置 `_note` 要求：误杀率<5%，命中即丢）。
 *  - geo / dimensions / opportunity 匹配 title+content（excerpt）拼接文本；
 *    `filter_rules.matching_mode=title_first` 的「正文≥3词复审池」分支为可选
 *    优化（配置注记建议初期关闭），v1 统一按全文本匹配实现。
 *  - 类正则 token（如 branch_expansion 的 "招聘.*人"）按正则编译，其余按精确子串。
 */
import type {
  KeywordConfig,
  DimensionRule,
  OpportunityTracker,
  RawArticleInput,
  FilterResult,
} from "./types";

const REGEX_META = /[.*+?^${}()|[\]\\]/;

/** 类正则 token 按正则编译匹配（失败降级子串），其余按精确子串。 */
function matchToken(token: string, text: string): boolean {
  if (REGEX_META.test(token)) {
    try {
      return new RegExp(token).test(text);
    } catch {
      return text.includes(token);
    }
  }
  return text.includes(token);
}

function anyTokenMatch(tokens: string[] | undefined, text: string): boolean {
  if (!tokens || tokens.length === 0) return false;
  return tokens.some((t) => matchToken(t, text));
}

function matchGeo(
  config: KeywordConfig,
  text: string,
): { score: number; hit: boolean } {
  const g = config.geo_filter;
  if (!g) return { score: 0, hit: false };
  if (anyTokenMatch(g.tier1_exact, text)) {
    return { score: g.weight?.tier1_hit ?? 100, hit: true };
  }
  if (anyTokenMatch(g.tier2_risky, text)) {
    return { score: g.weight?.tier2_only ?? 60, hit: false };
  }
  return { score: 0, hit: false };
}

function matchDimension(
  d: DimensionRule,
  text: string,
): { hit: boolean; strong: boolean; matched: string[] } {
  const matched: string[] = [];
  // exclude 优先：命中即强制不归入该维度
  if (d.exclude && d.exclude.some((w) => text.includes(w))) {
    return { hit: false, strong: false, matched };
  }
  for (const w of d.strong_keywords ?? []) {
    if (text.includes(w)) return { hit: true, strong: true, matched: [w] };
  }
  // weak 关键词必须与其 cooccurrence 词共现才算命中（无共现配置的 weak 词不单独命中）
  for (const [weak, coWords] of Object.entries(d.cooccurrence_for_weak ?? {})) {
    if (!(d.weak_keywords ?? []).includes(weak)) continue;
    if (text.includes(weak) && coWords.some((c) => text.includes(c))) {
      return { hit: true, strong: false, matched: [weak] };
    }
  }
  return { hit: false, strong: false, matched };
}

function matchTracker(
  t: OpportunityTracker,
  text: string,
  geoHit: boolean,
): { hit: boolean; matched: string[] } {
  if (t.geo_lock && !geoHit) return { hit: false, matched: [] };
  if (t.exclude_if_in_title && t.exclude_if_in_title.some((c) => text.includes(c))) {
    return { hit: false, matched: [] };
  }
  for (const tok of [...(t.strong_triggers ?? []), ...(t.triggers ?? [])]) {
    if (matchToken(tok, text)) return { hit: true, matched: [tok] };
  }
  return { hit: false, matched: [] };
}

/**
 * 参考区分类：不参与银行零售维度过滤（tech 技术动态 / ipo 全国IPO /
 * gd-ipo 广东IPO / politics 时政观察 是展示参考区，有独立 AI enrich），
 * 仅扫描商机追踪器；命中商机进商机池，未命中直接放行。
 * finance / gz（银行零售业务线）走完整漏斗。
 */
const REFERENCE_CATEGORIES = new Set(["tech", "ipo", "gd-ipo", "politics", "stocks"]);

/** 商机追踪（多值：命中即全部收录，按 S>A>B 排序；一条信息可进多个商机池）。 */
function scanOpportunities(
  config: KeywordConfig,
  text: string,
  geoHit: boolean,
  matched: string[],
): NonNullable<FilterResult["opportunities"]> {
  const PRIORITY_ORDER: Record<"S" | "A" | "B", number> = { S: 0, A: 1, B: 2 };
  const opportunities: NonNullable<FilterResult["opportunities"]> = [];
  for (const [key, t] of Object.entries(config.opportunity_tracker ?? {})) {
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    if (t.priority !== "S" && t.priority !== "A" && t.priority !== "B") continue;
    const r = matchTracker(t, text, geoHit);
    if (r.hit) {
      opportunities.push({
        tracker: key,
        priority: t.priority,
        label: t.label ?? key,
        fields: t.fields ?? [],
        action: t.action ?? "",
      });
      matched.push(...r.matched);
    }
  }
  opportunities.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  return opportunities;
}

/**
 * 对单条文章执行关键词漏斗（硬过滤）。
 *
 * @returns FilterResult — pass=false 表示未命中，应直接丢弃、不进 AI。
 */
export function applyKeywordFilter(
  article: RawArticleInput,
  config: KeywordConfig,
): FilterResult {
  const title = article.title ?? "";
  const full = `${title}\n${article.content ?? ""}`;
  const matched: string[] = [];

  // 参考区豁免：tech/ipo/gd-ipo/politics 不过银行零售漏斗（技术动态/IPO/时政
  // 是参考展示区，有自己的 AI enrich），仅扫描商机追踪器。
  if (article.category && REFERENCE_CATEGORIES.has(article.category)) {
    // 仍跑 geo 判定：商机追踪器里 geo_lock=true 的（上市/融资/扩张等）依赖地域命中
    const geo = matchGeo(config, full);
    const opportunities = scanOpportunities(config, full, geo.hit, matched);
    return {
      pass: true,
      score: geo.score + (opportunities.length > 0 ? 1000 : 0),
      dimensions: [],
      ...(opportunities.length > 0 ? { opportunities } : {}),
      matched,
      bucket: opportunities.length > 0 ? "opportunity" : "daily",
    };
  }

  // —— L0 全局硬排除（仅标题，命中即丢，负向优先；finance/gz 主战场的唯一硬闸）——
  for (const group of Object.values(config.global_exclude ?? {})) {
    if (!Array.isArray(group)) continue; // 跳过 _note 等描述字段
    for (const w of group) {
      if (title.includes(w)) {
        matched.push(w);
        return { pass: false, score: 0, dimensions: [], matched, bucket: "dropped" };
      }
    }
  }

  const geo = matchGeo(config, full);

  // 维度命中（multi_dimension: all_hit）。任一维度命中（含宏观政策·零售传导弱共现）即视为相关。
  const hitDims: string[] = [];
  let dimScore = 0;
  let weekly = false;
  for (const [key, d] of Object.entries(config.dimensions ?? {})) {
    if (!d || typeof d !== "object" || Array.isArray(d)) continue;
    const r = matchDimension(d, full);
    if (r.hit) {
      hitDims.push(key);
      dimScore += r.strong ? 2 : 1;
      if (d.weekly) weekly = true;
      matched.push(...r.matched);
    }
  }

  // 商机追踪（多值：命中即全部收录，按 S>A>B 排序）
  const opportunities = scanOpportunities(config, full, geo.hit, matched);

  // 漏斗只做 L0 明显噪声硬排除（零成本预过滤），真正的「相关性准度」交由
  // PASS1/PASS2 AI 回检裁决。2026-08-22 回退：此前的相关性闸门误杀了
  // 「央行货币政策执行报告」「落户…研发中心」等本应进 AI 研判的条目，违背
  // 用户「准确性第一、宁花 AI 成本换准确」的取舍。finance/gz 主战场在 L0 之后
  // 一律放行进 AI；参考区（tech/ipo/gd-ipo/politics）本就豁免。
  // bucket：opportunity > weekly > daily
  let bucket: FilterResult["bucket"] = "daily";
  if (opportunities.length > 0) bucket = "opportunity";
  else if (weekly) bucket = "weekly";

  return {
    pass: true,
    score: geo.score + dimScore + (opportunities.length > 0 ? 1000 : 0),
    dimensions: hitDims,
    ...(opportunities.length > 0 ? { opportunities } : {}),
    matched,
    bucket,
  };
}
