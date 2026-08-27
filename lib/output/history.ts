/**
 * Rolling article history (抓取窗口 = 今天+昨天) + AI-summary cache.
 *
 * Single source of truth on disk (`data/article-history.json`) that the
 * report entrypoints (daily.ts / dry-run.ts) use for two purposes:
 *
 *  1. **滚动 backlog** — every article published within the fetch window
 *     (最近 2 天) is kept here, so the renderer can show a rolling backlog
 *     alongside the freshly-fetched "当天" items.
 *  2. **AI 解读去重** — when an article's URL already has a `summary` in the
 *     history, daily.ts reuses it instead of calling the LLM again, saving
 *     cost. The summary is the "AI 解读结果" the user referred to.
 *
 * The file is public/committed (not gitignored) so it persists across CI
 * runs — both test.yml and daily.yml commit it back after each run.
 */
import fs from "node:fs";
import path from "node:path";

import type { ArticleInput } from "../types";
import type { Category } from "../sources/types";
import { SOURCE_ROUTE } from "../sources/constants";
import { loadAllSources } from "../sources/registry";
import { todayKey } from "../utils";

const HISTORY_PATH = path.resolve(process.cwd(), "data/article-history.json");
/** 抓取窗口（天）：daily 源层前置窗口过滤 + 滚动历史(buildRolling/pruneHistory)
 *  均以此为准——只抓取/展示今天 + 昨天的日期范围（用户 2026-08-22 要求：抓 2 天）。 */
export const FETCH_WINDOW_DAYS = 2;
const MAX_AGE_MS = FETCH_WINDOW_DAYS * 86_400_000;

export interface HistoryEntry {
  title: string;
  url: string;
  sourceId: string;
  source: string;
  category: Category;
  /** 条目级子标签：AI/启发式逐条分类结果（覆盖注册表源级）；由分析脚本写入。 */
  subcategory?: string;
  /** 条目级多标签（AI 分类，多值）：非空时渲染多归桶；subcategories 优先于 subcategory。 */
  subcategories?: string[];
  excerpt?: string;
  /** ISO string (from article.publishedAt). */
  publishedAt?: string;
  /** AI-generated summary in the active REPORT_LOCALE, if analyzed before. */
  summary?: string;
  /** 条目级相关性：false = 与银行业务无关，渲染时过滤；由分析脚本写入。 */
  ai_relevant?: boolean;
  /** ISO — first time we saw this URL. */
  firstSeenAt: string;
  /** ISO — most recent run that carried this URL. Used for 7-day pruning by occurrence time. */
  lastSeenAt: string;
}

export type HistoryStore = Record<string, HistoryEntry>;

function subcatOf(a: ArticleInput): string | undefined {
  // M3-D：路由元数据优先查集中表（SOURCE_ROUTE），注册表兜底
  const route = SOURCE_ROUTE[a.sourceId];
  if (route?.subcategory) return route.subcategory;
  const s = loadAllSources().find((x) => x.id === a.sourceId);
  return s?.subcategory;
}

export function loadHistory(): HistoryStore {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as HistoryStore;
      }
    }
  } catch {
    // corrupt file — start fresh rather than crash the whole run
  }
  return {};
}

/**
 * Whether a history entry still belongs in the rolling window.
 *
 * The window is measured by the article's **occurrence time** (`publishedAt`),
 * NOT the analysis time (`lastSeenAt`). An item is "fresh" if its publish date
 * is within the last FETCH_WINDOW_DAYS. Items with no publish date (e.g. some
 * crawled datasets) fall back to `lastSeenAt` so they aren't silently dropped.
 */
function isFreshEntry(e: HistoryEntry): boolean {
  const now = Date.now();
  const agePub = e.publishedAt ? now - Date.parse(e.publishedAt) : null;
  const ageSeen = e.lastSeenAt ? now - Date.parse(e.lastSeenAt) : null;
  // 发布时间为未来（异常/源站时区错误）→ 不按发布时间判新鲜，回退用 lastSeenAt，
  // 避免 agePub<0 永远 <= MAX_AGE_MS 导致该条目永不进入 7 天裁剪（D，2026-08-20）。
  if (agePub !== null && !Number.isNaN(agePub)) {
    if (agePub >= 0) return agePub <= MAX_AGE_MS;
  }
  if (ageSeen !== null && !Number.isNaN(ageSeen)) return ageSeen <= MAX_AGE_MS;
  return false;
}

/** Drop entries outside the rolling window — measured by occurrence time (publishedAt). */
export function pruneHistory(store: HistoryStore): HistoryStore {
  const out: HistoryStore = {};
  for (const [url, e] of Object.entries(store)) {
    if (isFreshEntry(e)) out[url] = e;
  }
  return out;
}

function entryToArticle(e: HistoryEntry, fetchedToday: boolean): ArticleInput {
  return {
    sourceId: e.sourceId,
    title: e.title,
    url: e.url,
    excerpt: e.excerpt,
    publishedAt: e.publishedAt ? new Date(e.publishedAt) : undefined,
    // 2026-08-27 核心规则：无发布时间直接 undefined — history 中无 publishedAt 的
    // 条目在 buildRolling 时被 no-date-fallback 阶段丢弃，不再写 fetchedAt 兜底。
    category: e.category,
    summary: e.summary,
    source: e.source,
    fetchedToday,
    // 条目级 AI/启发式分类透传
    ...(e.subcategory ? { subcategory: e.subcategory } : {}),
    ...(e.subcategories ? { subcategories: e.subcategories } : {}),
    ...(e.ai_relevant !== undefined ? { relevant: e.ai_relevant } : {}),
  };
}

/**
 * Merge today's freshly-fetched articles with the rolling history into a
 * single list, tagging each with `fetchedToday`. Today's items win on URL
 * collision (so an updated title/excerpt/summary for a recurring URL shows
 * under "当天"). History entries outside the 7-day (by occurrence time) window are dropped.
 */
export function buildRolling(
  today: ArticleInput[],
  history: HistoryStore,
): ArticleInput[] {
  const map = new Map<string, ArticleInput>();
  // 当天已处理的内容（lastSeenAt=今天，含预 AI 分析写入的当日条目）标记为
  // fetchedToday=true 参与「当天」视图——与 OFFLINE 模式的 lastSeenAt 标记一致。
  // 否则预分析/当天早跑写入的条目当天不展示，而新抓同主题又被跨天判重挡掉，
  // 导致当天面板空洞（2026-08-19 用户反馈「国家政策空、公积金被删」）。
  const todayStr = todayKey();
  for (const e of Object.values(history)) {
    if (!isFreshEntry(e)) continue;
    const isToday = typeof e.lastSeenAt === "string" && e.lastSeenAt.startsWith(todayStr);
    map.set(e.url, entryToArticle(e, isToday));
  }
  for (const a of today) {
    // 当天抓到的旧链接（publishedAt 超 7 天窗口，如 RSS 滚动列表里的老文章、
    // 爬虫列表页里的 2025 年旧数据）：不属于「当天/过去7天」简报，直接丢弃不进渲染。
    // 无 publishedAt 的条目不受此限制（无法判断发文时间，靠 fetchedToday 归属）。
    if (a.publishedAt && Date.now() - a.publishedAt.getTime() > MAX_AGE_MS) continue;
    // Today's items win on URL collision, but keep the history's per-item
    // AI analysis (subcategory / relevance / summary) when today's fetch
    // didn't carry one — otherwise real-time fetches would wipe it.
    // 注意：直接查 history 原对象（而非 map）——月度数据等 publishedAt 超 7 天
    // 的条目会被 isFreshEntry 排除出 rolling map，但 AI 解读仍需继承。
    const h = history[a.url];
    const merged = { ...a, fetchedToday: true };
    if (h?.subcategory && !merged.subcategory) merged.subcategory = h.subcategory;
    if (h?.subcategories && !merged.subcategories) merged.subcategories = h.subcategories;
    // fix: HistoryEntry 的字段名是 ai_relevant（entryToArticle 映射为 relevant）
    if (h?.ai_relevant !== undefined && merged.relevant === undefined) {
      merged.relevant = h.ai_relevant;
    }
    if (h?.summary && !merged.summary) merged.summary = h.summary;
    map.set(a.url, merged);
  }
  return Array.from(map.values());
}

/**
 * Persist today's articles (with whatever summary they now carry) into the
 * history store, bumping lastSeenAt. Called after AI enrichment so newly
 * generated summaries are cached for future runs. Returns the updated store.
 */
export function saveHistory(
  today: ArticleInput[],
  history: HistoryStore,
  nowIso: string,
): HistoryStore {
  const store = pruneHistory(history);
  for (const a of today) {
    const prev = store[a.url];
    store[a.url] = {
      title: a.title,
      url: a.url,
      sourceId: a.sourceId,
      source: a.source,
      category: a.category,
      // 条目级 AI 分类优先，注册表源级兜底
      subcategory: a.subcategory ?? subcatOf(a),
      ...(a.subcategories ? { subcategories: a.subcategories } : {}),
      // 相关性判定：本轮有判定用本轮（AI 重跑可更新），本轮无判定（SKIP_AI/
      // dry-run）保留历史打标——避免预分析回的 ai_relevant=false 被 SKIP_AI 覆盖丢失。
      ...(a.relevant !== undefined
        ? { ai_relevant: a.relevant }
        : prev?.ai_relevant !== undefined
          ? { ai_relevant: prev.ai_relevant }
          : {}),
      excerpt: a.excerpt,
      publishedAt: a.publishedAt?.toISOString(),
      // Keep a previously-cached summary if this run produced none
      // (e.g. dry-run has no AI — don't clobber good history).
      summary: a.summary || prev?.summary,
      firstSeenAt: prev?.firstSeenAt ?? nowIso,
      lastSeenAt: nowIso,
    };
  }
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(store, null, 2), "utf8");
  return store;
}
