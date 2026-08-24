import fs from "node:fs";
import type { CrawledArticle } from "../ingest/merge";

/**
 * 本地手动采集文件（data/local-acquired.json）
 *
 * 背景（2026-08-20 方案，替代已放弃的 self-hosted runner）：
 * NFRA / PBC / 财联社 / 同花顺 等站点 WAF/防火墙拦截 GitHub 托管 runner 的国外出口 IP
 * （CI 下 0 条、本地直连正常）。由用户在本地 WorkBuddy 触发 skill（local-acquire）：
 *   本地抓取这些源 → 归一化 CrawledArticle → 合并进本文件 → git 提交推送。
 * daily 正式跑时（托管 runner）读取本文件，只取「最新 7 天」条目，与其它采集数据
 * （rss + 爬虫）同一管线合并处理（toMergeArticle + dedupeByUrl）。
 *
 * ⚠️ 本文件必须提交（git 跟踪），CI checkout 才能拿到最新数据。
 *    文件结构：{ fetchedAt: 最近一次本地抓取时间, items: CrawledArticle[] }
 */
export interface LocalAcquiredFile {
  /** 最近一次本地抓取时间（ISO 8601；空串 = 尚未抓取过） */
  fetchedAt: string;
  /** 与爬虫产物同构的条目（sourceId/source/title/url/excerpt/publishedAt/region/category...） */
  items: CrawledArticle[];
}

const DEFAULT_PATH = "data/local-acquired.json";

/** 读取时只采纳最近 N 天的条目（2026-08-24 用户拍板：与报告口径一致，全部只取 2 天） */
export const LOCAL_ACQUIRED_DAYS = 2;

/** 读取本地采集文件（缺失/损坏/结构不符 → null） */
export function loadLocalAcquired(filePath = DEFAULT_PATH): LocalAcquiredFile | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as LocalAcquiredFile;
    if (data && Array.isArray(data.items)) return data;
    return null;
  } catch {
    return null;
  }
}

/** 只保留 publishedAt 在最近 days 天内的条目；无有效日期一律丢弃（无法判时效） */
export function filterLocalAcquiredRecent(
  items: CrawledArticle[],
  days = LOCAL_ACQUIRED_DAYS,
): CrawledArticle[] {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  return items.filter((it) => {
    if (!it.publishedAt) return false;
    const t = Date.parse(it.publishedAt);
    return Number.isFinite(t) && t >= cutoff;
  });
}
