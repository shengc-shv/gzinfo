/**
 * Tag Store 读写层。
 *
 * 三条硬约束：
 * 1. **只增不改**：既有记录的非空字段不允许被后续写入清空或被低信任来源覆盖
 *    （沿用 article-history 的守卫式写入经验，避免打标流失）。
 * 2. **原子落盘**：写临时文件再 rename，CI 中断不会留下半截 JSON。
 * 3. **损坏隔离**：文件解析失败 → 返回空 store 并告警，不让单次损坏拖垮整条管线。
 */

import fs from "node:fs";
import path from "node:path";

import {
  TAGGER_RANK,
  TAG_SCHEMA,
  emptyStore,
  type TagRecord,
  type TagStoreFile,
  type Tagger,
} from "./types";
import { contentFingerprint, normalizeUrl, titleFingerprint, urlId } from "./dedupe";
import { isExpired } from "./window";

/** 落盘路径（与 article-history 约定一致：相对 cwd 的 data/ 目录）。 */
export const TAG_STORE_PATH = path.resolve(process.cwd(), "data/tag-store.json");

// 便于使用方只 import 本模块（types 里的定义原样转发）
export { emptyStore, TAG_SCHEMA, TAGGER_RANK } from "./types";
export type { TagRecord, TagStoreFile, Tagger } from "./types";

/** 总开关：TAG_STORE=0 时所有读写旁路（保留原有行为，便于紧急回退）。 */
export function tagStoreEnabled(): boolean {
  const v = process.env.TAG_STORE?.trim();
  return v !== "0" && v !== "false";
}

/** 读取 store。损坏/缺失 → 空 store（不抛异常）。 */
export function loadTagStore(): TagStoreFile {
  if (!tagStoreEnabled()) return emptyStore();
  try {
    if (fs.existsSync(TAG_STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TAG_STORE_PATH, "utf8"));
      if (raw && typeof raw === "object" && raw.records && typeof raw.records === "object") {
        return {
          version: 1,
          schema: typeof raw.schema === "number" ? raw.schema : TAG_SCHEMA,
          updatedAt: raw.updatedAt ?? new Date().toISOString(),
          window: raw.window,
          records: raw.records as Record<string, TagRecord>,
          titleIndex: raw.titleIndex ?? {},
        };
      }
      console.warn("[tagstore] ⚠️ 文件结构异常，按空 store 处理（不中断管线）");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[tagstore] ⚠️ 读取失败，按空 store 处理：${msg}`);
  }
  return emptyStore();
}

/** 原子写盘（tmp + rename）。 */
export function saveTagStore(store: TagStoreFile): void {
  if (!tagStoreEnabled()) return;
  try {
    const dir = path.dirname(TAG_STORE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    store.updatedAt = new Date().toISOString();
    store.schema = TAG_SCHEMA;
    const tmp = `${TAG_STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, TAG_STORE_PATH);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[tagstore] ❌ 写盘失败（不中断管线）：${msg}`);
  }
}

/** 判断某字段是否「有值」（空串/空数组/undefined 都算无值）。 */
function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * 守卫式合并：把 incoming 合并进 existing，返回最终记录。
 *
 * 规则（按优先级）：
 * - incoming.schema 更新（判定口径变了）→ incoming 全量覆盖，但保留 firstSeenAt
 * - incoming 信任等级更高（pipeline > llm > workbuddy）→ 覆盖
 * - 同等级 → 覆盖
 * - 信任等级更低 → **只补齐 existing 缺失的字段**，绝不覆盖已有值
 * - 任何情况下：incoming 无值的字段不覆盖 existing 有值的字段
 */
export function mergeRecord(existing: TagRecord, incoming: TagRecord): TagRecord {
  const out: TagRecord = { ...existing };

  const newerSchema = (incoming.schema ?? 0) > (existing.schema ?? 0);
  const incomingRank = TAGGER_RANK[incoming.tagger as Tagger] ?? 0;
  const existingRank = TAGGER_RANK[existing.tagger as Tagger] ?? 0;
  const mayOverwrite = newerSchema || incomingRank >= existingRank;

  const fields: (keyof TagRecord)[] = [
    "title",
    "sourceId",
    "source",
    "publishedAt",
    "summary",
    "section",
    "locale",
    "importance",
    "businessLines",
    "tags",
  ];
  for (const f of fields) {
    const inc = incoming[f];
    if (!hasValue(inc)) continue; // 无值一律不写
    if (mayOverwrite || !hasValue(existing[f])) {
      (out as unknown as Record<string, unknown>)[f as string] = inc;
    }
  }

  // aiRelevant 是布尔值，false 也是有效值 → 单独处理
  if (mayOverwrite || existing.aiRelevant === undefined) {
    out.aiRelevant = incoming.aiRelevant;
  }

  if (mayOverwrite) {
    out.tagger = incoming.tagger;
    out.schema = incoming.schema;
    out.taggedAt = incoming.taggedAt;
  }
  // firstSeenAt 永远取最早
  out.firstSeenAt =
    existing.firstSeenAt && existing.firstSeenAt <= incoming.firstSeenAt
      ? existing.firstSeenAt
      : incoming.firstSeenAt;
  // hits 保持不累加——保证「同一输入重复 upsert 输出完全一致」的严格幂等
  out.hits = existing.hits ?? incoming.hits ?? 1;
  // URL 取最新（允许 URL 漂移后更新，便于下次直接命中一级键）
  out.url = incoming.url || existing.url;
  out.rawUrl = incoming.rawUrl || existing.rawUrl;
  return out;
}

/** 构造一条记录（供外部打标器调用）。 */
export interface BuildRecordInput {
  url: string;
  title: string;
  excerpt?: string;
  sourceId?: string;
  source?: string;
  /** 真实发布时间 ISO。**缺失调用方应直接跳过，不得用抓取日兜底。** */
  publishedAt: string;
  aiRelevant: boolean;
  summary?: string;
  section?: TagRecord["section"];
  locale?: TagRecord["locale"];
  tags?: string[];
  importance?: 1 | 2 | 3;
  businessLines?: string[];
  tagger: Tagger;
}

export function buildRecord(input: BuildRecordInput): TagRecord | null {
  const { url, title, publishedAt } = input;
  if (!url || !title) return null;
  if (!publishedAt) return null; // 时间真实性红线
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return null;
  const now = new Date().toISOString();
  return {
    id: urlId(url),
    url: normalizeUrl(url),
    rawUrl: url,
    titleFp: titleFingerprint(title),
    contentFp: contentFingerprint(title, input.excerpt ?? ""),
    title,
    sourceId: input.sourceId,
    source: input.source,
    publishedAt,
    firstSeenAt: now,
    taggedAt: now,
    tagger: input.tagger,
    schema: TAG_SCHEMA,
    aiRelevant: input.aiRelevant,
    summary: input.summary,
    section: input.section,
    locale: input.locale,
    tags: input.tags,
    importance: input.importance,
    businessLines: input.businessLines,
    hits: 1,
  };
}

export interface UpsertStats {
  added: number;
  updated: number;
  skipped: number;
}

/**
 * 内容签名：用于幂等判定。
 * 排除 taggedAt（每次写入都会刷新）与 hits（保留字段，不累加）。
 */
function signature(r: TagRecord): string {
  const clone: Record<string, unknown> = { ...r };
  delete clone.taggedAt;
  delete clone.hits;
  return JSON.stringify(clone);
}

/**
 * 批量写入（幂等）：相同输入重复执行结果一致。
 * 返回 { added, updated, skipped }——skipped 指既非新增也无实质变化。
 */
export function upsertRecords(
  store: TagStoreFile,
  records: TagRecord[],
  nowMs: number = Date.now(),
): UpsertStats {
  const stats: UpsertStats = { added: 0, updated: 0, skipped: 0 };
  for (const rec of records) {
    if (!rec?.id) {
      stats.skipped++;
      continue;
    }
    // 过期记录不入库（窗口外的旧闻没有缓存价值）；IPO 等长周期条目按自身保留期
    if (isExpired(rec.publishedAt, nowMs, rec.retainDays ?? 3)) {
      stats.skipped++;
      continue;
    }
    const prev = store.records[rec.id];
    if (!prev) {
      store.records[rec.id] = { ...rec, hits: 1 };
      store.titleIndex[rec.titleFp] = rec.id;
      stats.added++;
      continue;
    }
    const merged = mergeRecord(prev, rec);
    // 幂等判定：内容签名（排除 taggedAt / hits）相同 → 视为无变化，保持原记录不动。
    // 否则每次重复写入都会因 taggedAt 刷新而被判为「更新」，破坏严格幂等。
    if (signature(merged) === signature(prev)) {
      stats.skipped++;
      continue;
    }
    store.records[rec.id] = merged;
    store.titleIndex[merged.titleFp] = rec.id;
    stats.updated++;
  }
  return stats;
}

/**
 * 清理过期记录并重建 titleIndex。
 * 保留期 = retainDays（默认 3 = 2 天窗口 + 1 天缓冲）。
 */
export function pruneStore(store: TagStoreFile, retainDays = 3, nowMs = Date.now()): number {
  let removed = 0;
  const next: Record<string, TagRecord> = {};
  const titleIndex: Record<string, string> = {};
  for (const [id, rec] of Object.entries(store.records)) {
    if (isExpired(rec.publishedAt, nowMs, rec.retainDays ?? retainDays)) {
      removed++;
      continue;
    }
    next[id] = rec;
    titleIndex[rec.titleFp] = id;
  }
  store.records = next;
  store.titleIndex = titleIndex;
  return removed;
}

/**
 * 查询：先按 URL 主键，未命中再按标题指纹（应对 URL 漂移）。
 * 只返回 schema 与当前一致且未过期的记录。
 */
export function lookup(
  store: TagStoreFile,
  url: string,
  title: string,
): TagRecord | undefined {
  const byUrl = store.records[urlId(url)];
  if (byUrl && byUrl.schema === TAG_SCHEMA) return byUrl;
  const idByTitle = store.titleIndex[titleFingerprint(title)];
  if (!idByTitle) return undefined;
  const byTitle = store.records[idByTitle];
  if (!byTitle) return undefined;
  return byTitle.schema === TAG_SCHEMA ? byTitle : undefined;
}

/** 统计信息（日志用）。 */
export function storeStats(store: TagStoreFile): {
  total: number;
  relevant: number;
  byTagger: Record<string, number>;
} {
  const byTagger: Record<string, number> = {};
  let relevant = 0;
  for (const r of Object.values(store.records)) {
    if (r.aiRelevant) relevant++;
    byTagger[r.tagger] = (byTagger[r.tagger] ?? 0) + 1;
  }
  return { total: Object.keys(store.records).length, relevant, byTagger };
}
