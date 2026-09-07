/**
 * 缓存分流：把管线输入拆成「已打标（零 LLM）」与「未打标（需 LLM）」两组。
 *
 * 这是整套复用的核心。分流只按 store 命中情况判断，与触发钟点无关：
 * - 命中且 aiRelevant=true → 复用组（本地合成，零 token）
 * - 命中且 aiRelevant=false → 已判定无价值，直接丢弃（连本地合成都不做）
 * - 未命中 → 走真 LLM，产出后回写 store
 */

import type { Pass1Input } from "../ai/pass1";
import type { TagRecord, TagStoreFile } from "./types";
import { lookup } from "./store";

export interface CacheHit {
  input: Pass1Input;
  record: TagRecord;
}

export interface SplitResult {
  /** 命中缓存且有价值的条目（零 LLM）。 */
  hit: CacheHit[];
  /** 未命中缓存的条目（需走真 LLM）。 */
  miss: Pass1Input[];
  /** 命中但已被判定无价值，直接丢弃。 */
  droppedIrrelevant: number;
  /** 输入为空/无 URL 的脏数据。 */
  droppedInvalid: number;
}

/**
 * 按 store 分流。
 * @param inputs 管线输入（Pass1Input[]）
 * @param store 标签仓库
 */
export function splitByCache(inputs: Pass1Input[], store: TagStoreFile): SplitResult {
  const hit: CacheHit[] = [];
  const miss: Pass1Input[] = [];
  let droppedIrrelevant = 0;
  let droppedInvalid = 0;

  for (const it of inputs) {
    if (!it?.url) {
      droppedInvalid++;
      continue;
    }
    const rec = lookup(store, it.url, it.title ?? "");
    if (!rec) {
      miss.push(it);
      continue;
    }
    if (rec.aiRelevant) hit.push({ input: it, record: rec });
    else droppedIrrelevant++;
  }

  return { hit, miss, droppedIrrelevant, droppedInvalid };
}

/**
 * 构造给 makeSkipAiRunner 的两个参数：
 * - summaryCache：url → 已打标的银行零售解读
 * - relevantUrls：命中且有价值的原始 url 集合（PASS1 白名单）
 *
 * 注意：必须用 input.url（管线看到的原始 URL），而非 record.url（规范化后），
 * 否则 runner 解析 prompt 时按 url 匹配会全部落空。
 */
export function toSkipRunnerArgs(hits: CacheHit[]): {
  summaryCache: Map<string, string>;
  relevantUrls: Set<string>;
} {
  const summaryCache = new Map<string, string>();
  const relevantUrls = new Set<string>();
  for (const h of hits) {
    relevantUrls.add(h.input.url);
    const s = h.record.summary?.trim();
    if (s) summaryCache.set(h.input.url, s);
  }
  return { summaryCache, relevantUrls };
}
