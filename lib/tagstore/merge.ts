/**
 * 报告合并 + 结果回灌 store。
 *
 * **不漏损保证（用户 2026-09-07 明确：核心是预分析与正式跑过程中不能掉条目）**
 *
 * G1 只增不减：合并是两组的并集，任何一组产出的条目都必须出现在最终报告里，
 *    绝不因走了缓存路径而被静默丢弃。
 * G2 失败不误标：fresh 组 LLM 失败时**不回写** store（否则一次抖动会把条目
 *    永久标成「无价值」，属于最严重的漏损）。
 * G3 可观测对账：每个阶段打印 输入 / 复用 / LLM / 丢弃 / 成稿 五个数字，
 *    数量对不上能一眼看出来。
 * G4 空 store 等价现状：store 为空 → 全部 miss → 与改造前行为完全一致。
 */

import type { ArticleInput, DailyReport, ReportItem } from "../types";
import type { Tagger, TagRecord } from "./types";
import { TAG_SCHEMA } from "./types";
import { buildRecord } from "./store";
import { contentFingerprint, titleFingerprint, urlId, normalizeUrl } from "./dedupe";

type SectionMap = DailyReport["sections"];

/** 合并两份报告：sections 取并集，must_read/insights/hero_line 以 fresh 为准。 */
export function mergeReports(
  fresh: DailyReport,
  cached: DailyReport,
  date: string,
): DailyReport {
  const sections: SectionMap = {
    gz_local: [],
    biz_insight: [],
    policy_market: [],
    tech: [],
    ipo: [],
  };
  const seen = new Set<string>();

  // fresh 先入（真 LLM 产出的条目排在前面），cached 后补，按 url 去重
  for (const src of [fresh, cached]) {
    for (const key of Object.keys(sections) as (keyof SectionMap)[]) {
      for (const item of src.sections?.[key] ?? []) {
        if (!item?.url) continue;
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        sections[key].push(item);
      }
    }
  }

  // rank 重排（合并后原 rank 可能重复/错乱）
  for (const key of Object.keys(sections) as (keyof SectionMap)[]) {
    sections[key] = sections[key].map((it, i) => ({ ...it, rank: i + 1 }));
  }

  return {
    date,
    // hero_line：fresh 有则用（真 LLM 定调），否则用 cached，都空则由下游兜底
    hero_line: fresh.hero_line?.trim() || cached.hero_line?.trim() || "",
    // must_read / insights：cached 由本地合成产出恒为空数组，取并集即可
    must_read: [...(fresh.must_read ?? []), ...(cached.must_read ?? [])],
    insights: [...(fresh.insights ?? []), ...(cached.insights ?? [])],
    sections,
  };
}

/** 从 report 中按 url 建索引（url → 条目 + 所属板块）。 */
function indexReportItems(
  report: DailyReport,
): Map<string, { item: ReportItem; section: keyof SectionMap }> {
  const map = new Map<string, { item: ReportItem; section: keyof SectionMap }>();
  for (const key of Object.keys(report.sections ?? {}) as (keyof SectionMap)[]) {
    for (const item of report.sections?.[key] ?? []) {
      if (item?.url) map.set(item.url, { item, section: key });
    }
  }
  return map;
}

export interface HarvestOptions {
  /** 参与本轮 LLM 的 url 列表（miss 组）。 */
  urls: string[];
  /** url → 原始条目（取 publishedAt / sourceId / excerpt）。 */
  articlesByUrl: Map<string, ArticleInput>;
  tagger: Tagger;
  /**
   * 是否把「进了 LLM 但没进成稿」的条目标记为无价值。
   * **仅当 LLM 成功返回时才能传 true**——失败时标 false 会永久误杀（最严重的漏损）。
   */
  markDroppedAsIrrelevant: boolean;
}

/**
 * 把本轮 LLM 的产出回灌成 TagRecord，供后续增量更新 store。
 *
 * 时间真实性红线：取不到 publishedAt 的条目**不产记录**（宁可不缓存，也不缓存错）。
 */
export function harvestFromReport(
  report: DailyReport,
  opts: HarvestOptions,
): TagRecord[] {
  const kept = indexReportItems(report);
  const out: TagRecord[] = [];

  for (const url of opts.urls) {
    const art = opts.articlesByUrl.get(url);
    if (!art) continue;
    // 时间真实性红线：无真实发布时间 → 不入库
    const publishedAt = art.publishedAt
      ? new Date(art.publishedAt as unknown as string).toISOString()
      : undefined;
    if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) continue;

    const hit = kept.get(url);
    if (!hit && !opts.markDroppedAsIrrelevant) continue;

    const rec = buildRecord({
      url,
      title: art.title ?? hit?.item.title_cn ?? "",
      excerpt: art.excerpt ?? hit?.item.summary ?? "",
      sourceId: art.sourceId,
      source: art.source ?? hit?.item.source,
      publishedAt,
      aiRelevant: Boolean(hit),
      summary: hit?.item.summary,
      section: hit?.section,
      locale: hit?.item.locale,
      tags: hit?.item.tags,
      importance: hit?.item.importance,
      tagger: opts.tagger,
    });
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * 直接按已有 TagRecord 构造回灌记录（预分析阶段用，不经过 report）。
 * 用于把 WorkBuddy / LLM 打标结果落成标准记录。
 */
export function recordFromArticle(
  art: ArticleInput,
  verdict: { aiRelevant: boolean; summary?: string; section?: TagRecord["section"]; locale?: TagRecord["locale"]; tags?: string[]; importance?: 1 | 2 | 3 },
  tagger: Tagger,
): TagRecord | null {
  const publishedAt = art.publishedAt
    ? new Date(art.publishedAt as unknown as string).toISOString()
    : undefined;
  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) return null;
  return buildRecord({
    url: art.url,
    title: art.title ?? "",
    excerpt: art.excerpt ?? "",
    sourceId: art.sourceId,
    source: art.source,
    publishedAt,
    aiRelevant: verdict.aiRelevant,
    summary: verdict.summary,
    section: verdict.section,
    locale: verdict.locale,
    tags: verdict.tags,
    importance: verdict.importance,
    tagger,
  });
}

/** 供测试与日志：统计合并前后条数，验证不漏损。 */
export function countItems(report: DailyReport): number {
  let n = 0;
  for (const key of Object.keys(report.sections ?? {}) as (keyof SectionMap)[]) {
    n += (report.sections?.[key] ?? []).length;
  }
  return n;
}
