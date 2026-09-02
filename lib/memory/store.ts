/**
 * 内容记忆库持久化。
 *
 * 落盘位置：`data/event-memory.json`。
 *
 * 为什么是这个位置：CI 的每次运行都是全新 runner，只有被 git 提交的文件
 * 才能跨运行存活。daily.yml / daily-cron-fixed.yml 的归档步骤会
 * `git add history/ data/article-history.json ...`，本文件需一并加入
 * （已同步修改两个工作流），否则「上周播过什么」第二天就忘了。
 *
 * 与 data/article-history.json 的区别：
 *  - article-history 存「抓过哪些条目」，按 publishedAt 保留 2 天（展示窗口）；
 *  - event-memory 存「播过哪些事件」，按 lastBroadcastAt 保留 45 天（记忆窗口）。
 *  两者生命周期不同，必须分开，不能复用历史库（否则会被 2 天 prune 清空）。
 */

import fs from "node:fs";
import path from "node:path";
import type { EventRecord } from "./event-memory";
import {
  emptyMemory,
  pruneMemory,
  sanitizeEvents,
  type BroadcastSample,
  type EventMemoryStore,
} from "./event-memory";

export const EVENT_MEMORY_PATH = path.resolve(process.cwd(), "data/event-memory.json");

/** 记忆保留天数（默认 45 天；重大事件自动翻倍）。 */
export const MEMORY_RETAIN_DAYS = 45;

export interface EventMemoryStoreOpts {
  /** 便于单测隔离；默认 process.cwd()。 */
  baseDir?: string;
  /** 清理时参照的「今天」YYYY-MM-DD；默认取当前日期。 */
  today?: string;
}

function resolvePath(opts: EventMemoryStoreOpts): string {
  return path.resolve(opts.baseDir ?? process.cwd(), "data/event-memory.json");
}

/**
 * 读取记忆库；文件缺失/损坏/版本不符一律返回空库（不打断主流程）。
 *
 * 注意：绝不因读取失败而抛错——记忆层是**增强**，不是主链路，
 * 任何异常都应退化为「无记忆」，让报告照常生成。
 */
export function loadEventMemory(opts: EventMemoryStoreOpts = {}): EventMemoryStore {
  try {
    const p = resolvePath(opts);
    if (!fs.existsSync(p)) return emptyMemory();
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyMemory();
    const events = (raw as EventMemoryStore).events;
    if (!events || typeof events !== "object") return emptyMemory();
    // today 暂存区必须随文件读回：若丢失，昨天播报永远结算不进长期记忆
    // （beginDay 依赖 store.today 做跨天结算），冷却机制将整体失效。
    const t = (raw as EventMemoryStore).today;
    const today =
      t && typeof t === "object" && typeof (t as any).date === "string" &&
      Array.isArray((t as any).entries)
        ? { date: (t as any).date, entries: (t as any).entries as BroadcastSample[] }
        : undefined;
    return {
      version: 1,
      updatedAt: (raw as EventMemoryStore).updatedAt,
      // 结构损坏的记录在此丢弃（而非让后续匹配抛错）→ 下次 saveEventMemory
      // 落盘的是清洗后的库 → 损坏不再写回，实现**自愈**。
      // 2026-09-02 复审修复：此前单条记录损坏会让整个记忆去重静默失效且永不恢复。
      events: sanitizeEvents(events as Record<string, EventRecord>),
      ...(today ? { today } : {}),
    };
  } catch {
    return emptyMemory();
  }
}

/**
 * 写入记忆库（先清理再落盘）。
 * 写盘失败静默忽略（归档失败不打断主流程，与 writeStore 同策略）。
 */
export function saveEventMemory(
  store: EventMemoryStore,
  opts: EventMemoryStoreOpts = {},
): void {
  try {
    const p = resolvePath(opts);
    const today =
      opts.today ??
      new Intl.DateTimeFormat("en-CA", {
        timeZone: process.env.REPORT_TZ || "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    const cleaned = pruneMemory(store, today, { retainDays: MEMORY_RETAIN_DAYS });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cleaned, null, 2), "utf8");
  } catch {
    // 归档失败不打断主流程
  }
}

/** 记忆层总开关（EVENT_MEMORY=0 关闭，便于回滚与 A/B 对比）。 */
export function isEventMemoryEnabled(): boolean {
  return (process.env.EVENT_MEMORY ?? "1") !== "0";
}
