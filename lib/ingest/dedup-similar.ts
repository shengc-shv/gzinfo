/**
 * 标题相似度判重（归一化边界②，漏斗之后、AI 之前）。
 *
 * 用户规则（2026-08-19）：同一主题（标题相似度 ≥ threshold）最多保留
 * maxPerTheme 条（默认 2），且**同 tier 只留 1 条**——两个政府源（T1）发同
 * 一消息只留 1；政府 + 媒体 = 政府留 1 + 媒体留 1（共 2）。保留优先级按
 * 来源等级：T1 官方一手 > T1.5 准官方·机构一手 > T2 媒体·智库 > 无等级。
 *
 * 与 URL 精确判重（dedupeByUrl）互补：URL 判重管"同一条"，本模块管
 * "同一事件的多家报道"（不同 URL、相似标题）。放在 AI 之前执行，
 * 让 LLM 只处理保留条目（省钱）。
 */
import type { ArticleInput } from "../types";
import { SOURCE_TIERS, type SourceTier } from "../sources/tiers";

export interface SimilarDedupOptions {
  /** 标题相似度阈值（0-1），≥ 阈值视为同一主题。默认 0.7。 */
  threshold?: number;
  /** 每个主题最多保留条数。默认 2。 */
  maxPerTheme?: number;
}

export interface SimilarDedupResult {
  kept: ArticleInput[];
  removed: ArticleInput[];
}

/** 标题字符二元组（bigram）集合——中文标题相似度的零依赖近似。 */
export function titleBigrams(s: string): Set<string> {
  // 去除所有非字母/数字字符（含中英文标点、空白、符号），仅保留 \p{L}\p{N}。
  // 让「央行：降准！」与「央行降准」归一化为同一 bigram 序列，提升对同事件
  // 不同措辞（标点/全半角差异）的合并率（B：内容级去重增强，2026-08-20）。
  const t = s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  const grams = new Set<string>();
  if (t.length === 0) return grams;
  if (t.length === 1) {
    grams.add(t);
    return grams;
  }
  for (let i = 0; i < t.length - 1; i++) grams.add(t.slice(i, i + 2));
  return grams;
}

/** Jaccard 相似度：交集 / 并集。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Dice 系数：2 × 交集 / (A + B)——对长度差异与措辞改写更宽容（跨天判重用）。 */
export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const denom = a.size + b.size;
  return denom === 0 ? 0 : (2 * inter) / denom;
}

/** 两标题相似度（bigram Jaccard）。 */
export function titleSimilarity(a: string, b: string): number {
  return jaccard(titleBigrams(a), titleBigrams(b));
}

/** 两标题相似度（bigram Dice，跨天判重专用）。 */
export function titleSimilarityDice(a: string, b: string): number {
  return dice(titleBigrams(a), titleBigrams(b));
}

/** tier 优先级排序权重（越小越优先保留）。 */
function tierWeight(tier: SourceTier | undefined): number {
  if (tier === undefined) return SOURCE_TIERS.length; // 无等级垫底
  const i = SOURCE_TIERS.indexOf(tier);
  return i === -1 ? SOURCE_TIERS.length : i;
}

/**
 * 标题相似度判重：把标题相似度 ≥ threshold 的条目聚为同一主题，
 * 每主题保留 ≤ maxPerTheme 条，且同一 tier 只留 1 条（不同 tier 可各留 1）。
 * 簇内选择：按 (tier 优先级, publishedAt 新→旧) 排序，贪心取不重复 tier 的条目。
 */
export function dedupeByTitleSimilarity(
  articles: ArticleInput[],
  opts: SimilarDedupOptions = {},
): SimilarDedupResult {
  const threshold = opts.threshold ?? 0.7;
  const maxPerTheme = opts.maxPerTheme ?? 2;
  if (articles.length <= 1 || maxPerTheme < 1) {
    return { kept: articles, removed: [] };
  }

  // 贪心聚簇：每条与已有簇的代表比较，相似则入簇，否则新建簇。
  // B-2 跨源去重精度：先按 canonical URL 归一（同一文章不同 utm_*/协议/尾斜杠
  // 直接归一簇），再做标题相似度匹配（捕捉"同一事件不同源不同角度"）。
  const clusters: ArticleInput[][] = [];
  const reps: ArticleInput[] = [];
  const repCanonical: (string | undefined)[] = [];
  const { canonicalizeUrl } = require("./canonical-url") as typeof import("./canonical-url");
  for (const a of articles) {
    let placed = false;
    const aCanon = a.url ? canonicalizeUrl(a.url) : undefined;
    for (let i = 0; i < reps.length; i++) {
      // 1) canonical URL 相同 → 直接归一簇（最强信号）
      if (aCanon && repCanonical[i] && aCanon === repCanonical[i]) {
        clusters[i].push(a);
        placed = true;
        break;
      }
      // 2) 标题相似度达阈值 → 归一簇（捕捉跨源同事件）
      if (titleSimilarity(a.title, reps[i].title) >= threshold) {
        clusters[i].push(a);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([a]);
      reps.push(a);
      repCanonical.push(aCanon);
    }
  }

  const kept: ArticleInput[] = [];
  const removed: ArticleInput[] = [];
  for (const cluster of clusters) {
    if (cluster.length <= 1) {
      kept.push(...cluster);
      continue;
    }
    // 排序：tier 优先级升序，其次 publishedAt 新→旧（undefined 垫底）
    const sorted = [...cluster].sort((a, b) => {
      const tw = tierWeight(a.tier) - tierWeight(b.tier);
      if (tw !== 0) return tw;
      const at = a.publishedAt ? a.publishedAt.getTime() : -Infinity;
      const bt = b.publishedAt ? b.publishedAt.getTime() : -Infinity;
      return bt - at;
    });
    // 同 tier 只留 1（总是生效，与簇大小无关）；总上限 maxPerTheme。
    // 例：T1+T1 → 留 1；T1+T1.5 → 留 2；T1+T1.5+T2 → 留 T1+T1.5（2 条上限，T2 移除）。
    const seenTier = new Set<SourceTier | "none">();
    const picked: ArticleInput[] = [];
    for (const it of sorted) {
      const key: SourceTier | "none" = it.tier ?? "none";
      if (seenTier.has(key)) continue; // 同 tier 只留 1 条
      seenTier.add(key);
      picked.push(it);
      if (picked.length >= maxPerTheme) break;
    }
    kept.push(...picked);
    removed.push(...sorted.filter((x) => !picked.includes(x)));
  }

  return { kept, removed };
}

/** 参与跨天判重的历史条目（只需 title + tier）。 */
export interface HistorySimilarEntry {
  title: string;
  url: string;
  tier?: SourceTier;
}

/**
 * 跨天标题判重（先来后到）：新抓取的条目与历史库中标题相似（≥ threshold）的
 * 既有条目比较——同主题重复报道按「同 tier 只留 1、不同 tier 最多 maxPerTheme
 * 条、历史先来者优先占位」过滤。
 *
 * 用户规则（2026-08-19）：政府今天发公积金，明天某媒体发、后天又一家媒体发——
 * 这些都是同一主题的重复报道；历史条目先占位（T1），新条目仅当该 tier 空缺且
 * 总数 < 上限时才补充 1 条（T2），同 tier 的新条目互相去重只留 1，其余视为无效。
 *
 * 实现：历史 + 新条目混合贪心聚簇（历史先加入、作簇代表 = 先来后到），
 * 簇内按「历史占位 → 新条目按 (tier 优先级, 时间新) 填补空缺」选择。
 * 相似度用 bigram Dice（对措辞改写更宽容），默认阈值 0.6（低于当日内部判重
 * 的 0.7——跨天抓的是「媒体改写政府通稿」这类措辞近似的重复报道）。
 */
export function dedupeAgainstHistory<T extends { title: string; tier?: SourceTier; publishedAt?: Date }>(
  articles: T[],
  history: HistorySimilarEntry[],
  opts: SimilarDedupOptions = {},
): { kept: T[]; removed: T[] } {
  const threshold = opts.threshold ?? 0.6;
  const maxPerTheme = opts.maxPerTheme ?? 2;
  if (articles.length === 0) return { kept: articles, removed: [] };

  type Cand = {
    title: string;
    tier?: SourceTier;
    kind: "hist" | "new";
    item: T | null;
  };
  const gramsCache = new Map<string, Set<string>>();
  const gramsOf = (t: string): Set<string> => {
    let g = gramsCache.get(t);
    if (!g) {
      g = titleBigrams(t);
      gramsCache.set(t, g);
    }
    return g;
  };

  // 混合聚簇（历史先加入 → 历史条目优先成为簇代表；相似度用 Dice，更宽容）
  const clusters: Cand[][] = [];
  const reps: Set<string>[] = [];
  const add = (c: Cand): void => {
    const g = gramsOf(c.title);
    for (let i = 0; i < reps.length; i++) {
      if (dice(g, reps[i]) >= threshold) {
        clusters[i].push(c);
        return;
      }
    }
    clusters.push([c]);
    reps.push(g);
  };
  for (const h of history) {
    if (!h || !h.title) continue;
    add({ title: h.title, tier: h.tier, kind: "hist", item: null });
  }
  for (const a of articles) add({ title: a.title, tier: a.tier, kind: "new", item: a });

  const kept: T[] = [];
  const removed: T[] = [];
  for (const cluster of clusters) {
    const newItems = cluster.filter((c) => c.kind === "new");
    if (newItems.length === 0) continue;
    // 历史先来者占位：历史条目的 tier 集合（同 tier 只占 1 个位置）
    const occupied = new Set<SourceTier | "none">();
    for (const h of cluster) {
      if (h.kind === "hist") occupied.add(h.tier ?? "none");
    }
    // 新条目按 (tier 优先级, publishedAt 新→旧) 排序，填补空缺；同 tier 只补 1 个
    const sorted = [...newItems].sort((a, b) => {
      const tw = tierWeight(a.tier) - tierWeight(b.tier);
      if (tw !== 0) return tw;
      const at = a.item?.publishedAt?.getTime() ?? -Infinity;
      const bt = b.item?.publishedAt?.getTime() ?? -Infinity;
      return bt - at;
    });
    for (const c of sorted) {
      const key: SourceTier | "none" = c.tier ?? "none";
      const fits = !occupied.has(key) && occupied.size < maxPerTheme;
      if (fits) {
        occupied.add(key);
        kept.push(c.item!);
      } else {
        removed.push(c.item!);
      }
    }
  }
  return { kept, removed };
}
