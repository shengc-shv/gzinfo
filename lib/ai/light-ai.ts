// ============================================================================
// 漏斗三（业务价值取前，零 AI，方案 A，2026-08-31 3漏斗整改 commit③）。
// 本模块含两个互补工具：
//   - takeTopByValue：漏斗三主路径——全局按分行相关性评分取前 + 每源多样性封顶 + 写回 valueTag。
//   - capLightAiSources：每源限额（保留，供低命中率源 PASS1 token 截断 / 向后兼容）。
// ============================================================================

// --- 漏斗三主路径：全局业务价值取前 -----------------------------------------
/**
 * 漏斗三默认参数。
 * - VALUE_TOP_N：全局按分行相关性评分降序取前条数（避免低价值条目进 AI/展示）。
 * - VALUE_MAX_PER_SOURCE：每源多样性封顶，防止单媒体源刷屏淹没高价值异构内容。
 */
export const VALUE_TOP_N = 60;
export const VALUE_MAX_PER_SOURCE = 8;

import type { ArticleInput, ValueTag } from "../types";
import { scoreBranchRelevance, type BranchRelevance, type ScorableArticle } from "./relevance-score";

/** ArticleInput → ScorableArticle（scoreBranchRelevance 入参）。 */
function toScorable(a: ArticleInput): ScorableArticle {
  return {
    title: a.title,
    category: a.category,
    subcategory: a.subcategory,
    sourceId: a.sourceId,
    summary: a.summary,
    url: a.url,
  };
}

/** BranchRelevance → ValueTag（漏斗三写回，供 exec 口播消费）。 */
function toValueTag(r: BranchRelevance): ValueTag {
  return {
    tier: r.tier,
    score: r.score,
    businessLines: r.businessLines,
    vertical: r.vertical,
    risk: r.risk,
  };
}

/**
 * 漏斗三（业务价值取前，零 AI）：对归一化后、已过漏斗一/二的 articles 做价值排序取前。
 *   1. 全局按 `scoreBranchRelevance` 评分降序取前 `topN`（同分按发布时间倒序）；
 *   2. 叠加每源 ≤ `maxPerSource` 多样性封顶（避免单媒体刷屏）；
 *   3. 写回每条的 `valueTag`（确定性、免费、可单测），供第⑤步 LLM 口播直接消费。
 *
 * 纯函数、不 mutate 入参（与 filter 链约定一致）。返回新数组，落选/封顶的条目不出现。
 *
 * @param articles 已过漏斗一（业务相关性）/漏斗二（时效+去重）的候选集
 * @param opts.topN 全局取前条数（默认 VALUE_TOP_N=60）
 * @param opts.maxPerSource 每源多样性封顶（默认 VALUE_MAX_PER_SOURCE=8）
 */
export function takeTopByValue<T extends ArticleInput>(
  articles: T[],
  opts: { topN?: number; maxPerSource?: number } = {},
): T[] {
  const topN = opts.topN ?? VALUE_TOP_N;
  const maxPerSource = opts.maxPerSource ?? VALUE_MAX_PER_SOURCE;

  const scored = articles.map((a) => ({
    a,
    score: scoreBranchRelevance(toScorable(a)).score,
    time: a.publishedAt?.getTime() ?? 0,
  }));
  // 全局按价值降序；同分取更新者
  scored.sort((x, y) => (y.score !== x.score ? y.score - x.score : y.time - x.time));
  const top = scored.slice(0, topN).map((s) => s.a);

  // 每源多样性封顶
  const perSource = new Map<string, number>();
  const kept: T[] = [];
  for (const a of top) {
    const sid = a.sourceId ?? "";
    const used = perSource.get(sid) ?? 0;
    if (used >= maxPerSource) continue;
    perSource.set(sid, used + 1);
    kept.push({ ...a, valueTag: toValueTag(scoreBranchRelevance(toScorable(a))) });
  }
  return kept;
}

// --- 每源限额（保留：低命中率源 PASS1 token 截断 / 向后兼容） -----------------
// 2026-08-22 降本：以下命中率偏低（10%~34%）但保留作本地热点发现的爬虫源，
// 每源每天最多取 LIGHT_AI_MAX_PER_SOURCE 条进 AI 管线，且 raw_text 截断到 LIGHT_AI_RAW_CAP 字，
// 两项叠加使 PASS1 对它们的 token 占用降 ~90%（PASS2 本就很少为低命中源成稿）。
// 2026-08-25 用户指令：所有媒体数据采集，每源每天 ≤10 条进入 LLM 分析与展示
// （daily.ts 调用处以全源集合 cap，LIGHT_AI_SOURCES 保留为 raw 截断标记集）。
// 2026-09-01 用户指令更新：PASS1 过滤精准，每源限额提升至 ≤20 条进 LLM
// （进入 LLM 的总量仍由各源实际采集量控制，不会失控）。
export const LIGHT_AI_SOURCES = new Set<string>([
  "cnfin",
  "stcn",
  "dayoo-gz",
  "southcn",
  "cnr-gd",
]);
export const LIGHT_AI_MAX_PER_SOURCE = 20;
export const LIGHT_AI_RAW_CAP = 200;

export interface LightAiArticle {
  sourceId?: string;
  publishedAt?: Date;
}

/**
 * 对 lightAi 源按 sourceId 分组、每源保留 maxPer 条；其余源原样保留。
 * 用于降 AI 管线 token 占用：低命中率源只取少量条目送 PASS1。
 *
 * 排序键（2026-08-29 价值预筛）：传入 scorer 时按「分行相关性评分」降序取，
 * 无 scorer 时退化为「最新优先」。让高分行相关性条目优先进 AI（命中「价值优先」+
 * 「节约AI」），低价值条目让位；同分时仍按发布时间倒序保证新事件不漏。
 */
export function capLightAiSources<T extends LightAiArticle>(
  articles: T[],
  lightSet: Set<string>,
  maxPer: number,
  scorer?: (a: T) => number,
): T[] {
  const lightGroups = new Map<string, T[]>();
  const others: T[] = [];
  for (const a of articles) {
    const sid = a.sourceId ?? "";
    if (lightSet.has(sid)) {
      if (!lightGroups.has(sid)) lightGroups.set(sid, []);
      lightGroups.get(sid)!.push(a);
    } else {
      others.push(a);
    }
  }
  const capped: T[] = [];
  for (const items of lightGroups.values()) {
    items.sort((x, y) => {
      const sx = scorer ? scorer(x) : (x.publishedAt?.getTime() ?? 0);
      const sy = scorer ? scorer(y) : (y.publishedAt?.getTime() ?? 0);
      if (sy !== sx) return sy - sx;
      return (y.publishedAt?.getTime() ?? 0) - (x.publishedAt?.getTime() ?? 0);
    });
    capped.push(...items.slice(0, maxPer));
  }
  return [...others, ...capped];
}
