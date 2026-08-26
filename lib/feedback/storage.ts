/**
 * 反馈回路数据层（P0-D）。
 *
 * 存储：浏览器 localStorage（key = "gzinfo:feedback:v1"）
 * 数据：FeedbackEntry[] JSON 数组
 *
 * 设计原则：
 * - 无后端（项目是 local-first + 静态 GitHub Pages）
 * - 幂等：同一 (date, url, section) 只保留最新一条
 * - 导出：localStorage → JSON 文件下载，行长可发给开发团队
 * - 汇总：`scripts/feedback-report.ts` 扫描 data/feedback/*.json 聚合
 *
 * 注意：localStorage 只能在浏览器访问。Node 端（daily.ts / reader 脚本）只
 * 读已经导出的 JSON 文件，不直接调本文件。
 */

export type FeedbackSection =
  | "must_read"
  | "insights"
  | "risk"
  | "gz_local"
  | "biz_insight"
  | "policy_market"
  | "ipo"
  | "stock_news"
  | "audio";

export type FeedbackVote = "up" | "down";

export interface FeedbackEntry {
  date: string;            // YYYY-MM-DD
  url: string;             // article URL；audio 用 "__audio__"
  section: FeedbackSection;
  vote: FeedbackVote;
  ts: number;              // unix ms
}

export const STORAGE_KEY = "gzinfo:feedback:v1";

/** 段 → 卡片 data-section 属性映射（与 render.ts 的 fb-btn 一致） */
export const SECTION_KEYS: FeedbackSection[] = [
  "must_read",
  "insights",
  "risk",
  "gz_local",
  "biz_insight",
  "policy_market",
  "ipo",
  "stock_news",
  "audio",
];

/** 单一反馈来源标识（用于聚合去重） */
export function entryKey(e: Pick<FeedbackEntry, "date" | "url" | "section">): string {
  return `${e.date}|${e.url}|${e.section}`;
}

/** 读全部反馈（Node + 浏览器通用；浏览器用 localStorage，Node 用入参）。 */
export function listAll(getRaw?: () => string | null): FeedbackEntry[] {
  const raw = getRaw ? getRaw() : readBrowserStorage();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is FeedbackEntry =>
        e &&
        typeof e.date === "string" &&
        typeof e.url === "string" &&
        typeof e.section === "string" &&
        (e.vote === "up" || e.vote === "down") &&
        typeof e.ts === "number",
    );
  } catch {
    return [];
  }
}

function readBrowserStorage(): string | null {
  const ls = getBrowserLocalStorage();
  return ls ? ls.getItem(STORAGE_KEY) : null;
}

/** 浏览器 localStorage 守卫（Node 环境返回 null；本文件不引入 DOM 类型）。 */
function getBrowserLocalStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g: any = globalThis;
    const ls = g?.localStorage;
    if (ls && typeof ls.getItem === "function" && typeof ls.setItem === "function") return ls;
    return null;
  } catch {
    return null;
  }
}

/** 写一条反馈（幂等：同 date+url+section 替换投票）。 */
export function recordVote(
  entry: FeedbackEntry,
  setRaw?: (raw: string) => void,
): FeedbackEntry[] {
  const all = listAll(getRawIf(setRaw));
  const idx = all.findIndex((e) => entryKey(e) === entryKey(entry));
  if (idx >= 0) all[idx] = entry;
  else all.push(entry);
  const next = JSON.stringify(all);
  if (setRaw) setRaw(next);
  else writeBrowserStorage(next);
  return all;
}

function getRawIf(setRaw?: (raw: string) => void): (() => string | null) | undefined {
  if (!setRaw) return undefined;
  // Node mode: 闭包持有 current raw
  let buf = "{}";
  return () => buf;
}

function writeBrowserStorage(raw: string): void {
  const ls = getBrowserLocalStorage();
  if (!ls) return;
  try { ls.setItem(STORAGE_KEY, raw); } catch { /* quota / private mode */ }
}

/** 导出为 JSON 字符串（用于下载）。 */
export function exportJson(entries?: FeedbackEntry[]): string {
  const all = entries ?? listAll();
  return JSON.stringify(all, null, 2);
}

/** 聚合统计（Node 端 feedback-report.ts 复用）。 */
export interface FeedbackStats {
  totalUp: number;
  totalDown: number;
  byDate: Record<string, { up: number; down: number }>;
  bySection: Record<string, { up: number; down: number }>;
  byUrl: Record<string, { up: number; down: number; date: string; section: string }>;
}

export function aggregate(entries: FeedbackEntry[]): FeedbackStats {
  const stats: FeedbackStats = {
    totalUp: 0,
    totalDown: 0,
    byDate: {},
    bySection: {},
    byUrl: {},
  };
  for (const e of entries) {
    if (e.vote === "up") stats.totalUp++;
    else stats.totalDown++;
    (stats.byDate[e.date] ??= { up: 0, down: 0 })[e.vote]++;
    (stats.bySection[e.section] ??= { up: 0, down: 0 })[e.vote]++;
    const k = `${e.date}|${e.url}`;
    if (!stats.byUrl[k]) {
      stats.byUrl[k] = { up: 0, down: 0, date: e.date, section: e.section };
    }
    stats.byUrl[k][e.vote]++;
  }
  return stats;
}
