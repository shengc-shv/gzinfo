/**
 * 为历史记忆补填播报时刻 broadcastAt（一次性 / 可重复执行，幂等）。
 *
 * 背景：记忆库上线（2026-09-02 e37b39d）之前的播报留痕只有 date（YYYY-MM-DD），
 * 没有具体时刻，无法按 9:00 分界区分「客户演示数据」与「测试/验证数据」。
 *
 * 时刻基准：播报与页面展示绑定、几乎同时产生，因此**报告页面的生成时刻**
 * 即该批播报的时刻基准。推断优先级：
 *   1. `--base ISO` 显式指定（证据确凿时优先用，如 CI 日志时间戳）；
 *   2. 报告文件 mtime：`history/<date>/<date>.html`
 *      （回退 `data/history/reports/<date>/<date>.html`）；
 *   3. `history/<date>/store.json` mtime；
 *   4. 兜底：该日 12:00（中性值，既不归入演示也不归入测试，避免误判）。
 *
 * 同一批（同 date）内按数组原顺序每秒递增 1 秒，以体现播报先后顺序。
 *
 * 用法：
 *   npm run memory:backfill -- --dry-run          # 预览，不写盘
 *   npm run memory:backfill                        # 执行回填
 *   npm run memory:backfill -- --base 2026-09-02T23:39:47+08:00 --date 2026-09-02
 */

import fs from "node:fs";
import path from "node:path";
import {
  broadcastAtFromDateAndSeconds,
  memoryTimeZone,
  parseBroadcastAt,
  summarizeByHour,
} from "../lib/memory/broadcast-time";
import type { BroadcastSample, EventMemoryStore, EventRecord } from "../lib/memory/event-memory";

const MEM_PATH = path.resolve(process.cwd(), "data/event-memory.json");

interface Args {
  dryRun: boolean;
  base?: string;
  date?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--dry-run") a.dryRun = true;
    else if (v === "--base") a.base = argv[++i];
    else if (v === "--date") a.date = argv[++i];
  }
  return a;
}

/** 推断某天报告页面的生成时刻（返回当天秒数；无法推断返回 null）。 */
function inferSecondsOfDay(date: string, tz: string): number | null {
  const candidates = [
    path.resolve(process.cwd(), `history/${date}/${date}.html`),
    path.resolve(process.cwd(), `data/history/reports/${date}/${date}.html`),
    path.resolve(process.cwd(), `history/${date}/store.json`),
    path.resolve(process.cwd(), `data/history/reports/${date}/store.json`),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const mtime = fs.statSync(p).mtime;
      // 把 UTC 时刻换算为指定时区的「当天秒数」
      const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const parts: Record<string, string> = {};
      for (const x of fmt.formatToParts(mtime)) if (x.type !== "literal") parts[x.type] = x.value;
      const h = Number(parts.hour ?? "0") % 24;
      const mi = Number(parts.minute ?? "0");
      const s = Number(parts.second ?? "0");
      console.log(`    ↳ 依据文件 mtime: ${path.relative(process.cwd(), p)} → ${h}:${mi}:${s}`);
      return h * 3600 + mi * 60 + s;
    } catch {
      continue;
    }
  }
  return null;
}

/** 显式 --base 转为「当天秒数」（ISO 带偏移）。 */
function secondsFromBase(base: string, tz: string): number | null {
  const t = parseBroadcastAt(base);
  if (t === null) return null;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(t))) if (x.type !== "literal") parts[x.type] = x.value;
  const h = Number(parts.hour ?? "0") % 24;
  const mi = Number(parts.minute ?? "0");
  const s = Number(parts.second ?? "0");
  return h * 3600 + mi * 60 + s;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const tz = memoryTimeZone();

  if (!fs.existsSync(MEM_PATH)) {
    console.log(`未找到 ${path.relative(process.cwd(), MEM_PATH)}，无需回填。`);
    return;
  }
  const store = JSON.parse(fs.readFileSync(MEM_PATH, "utf8")) as EventMemoryStore;

  // 收集所有缺 broadcastAt 的留痕，按日期分组
  const missing: Array<{ rec: EventRecord | null; sample: BroadcastSample; where: string }> = [];
  for (const [id, rec] of Object.entries(store.events ?? {})) {
    if (!Array.isArray(rec.samples)) continue;
    rec.samples.forEach((s, i) => {
      if (!s || parseBroadcastAt(s.broadcastAt) !== null) return;
      missing.push({ rec, sample: s, where: `events/${id}#${i}` });
    });
  }
  (store.today?.entries ?? []).forEach((s, i) => {
    if (!s || parseBroadcastAt(s.broadcastAt) !== null) return;
    missing.push({ rec: null, sample: s, where: `today#${i}` });
  });

  if (missing.length === 0) {
    console.log("✅ 所有播报留痕均已有 broadcastAt，无需回填。");
    return;
  }

  console.log(`发现 ${missing.length} 条缺失 broadcastAt 的留痕：\n`);

  // 按日期分组，逐日确定基准时刻
  const byDate = new Map<string, typeof missing>();
  for (const m of missing) {
    const d = m.sample.date;
    if (args.date && d !== args.date) continue;
    const list = byDate.get(d) ?? [];
    list.push(m);
    byDate.set(d, list);
  }

  let filled = 0;
  for (const [date, list] of byDate) {
    let sec = args.base && (!args.date || args.date === date)
      ? secondsFromBase(args.base, tz)
      : null;
    let source = "--base 指定";
    if (sec === null) {
      sec = inferSecondsOfDay(date, tz);
      source = "报告文件 mtime";
    }
    if (sec === null) {
      sec = 12 * 3600;
      source = "兜底 12:00（中性，不归入演示/测试）";
    }
    console.log(`  [${date}] 基准时刻来源：${source}，共 ${list.length} 条`);

    list.forEach((m, i) => {
      // 按原顺序每秒递增，体现播报先后
      const at = broadcastAtFromDateAndSeconds(date, sec + i, tz);
      m.sample.broadcastAt = at;
      filled++;
      console.log(`    ${m.where.padEnd(22)} → ${at}  「${m.sample.title.slice(0, 24)}」`);
    });
  }

  console.log(`\n合计回填 ${filled} 条。`);
  const stats = summarizeByHour(store, 9, tz);
  console.log(
    `回填后分区统计（以 9:00 为界）：演示/正式 ${stats.before.samples} 条 | ` +
      `测试/验证 ${stats.after.samples} 条 | 未知 ${stats.unknown.samples} 条`,
  );

  if (args.dryRun) {
    console.log("\n--dry-run 模式：未写入磁盘。");
    return;
  }
  const backup = `${MEM_PATH}.bak`;
  fs.copyFileSync(MEM_PATH, backup);
  fs.writeFileSync(MEM_PATH, JSON.stringify(store, null, 2), "utf8");
  console.log(`\n✅ 已写入 ${path.relative(process.cwd(), MEM_PATH)}（原文件备份于 ${path.basename(backup)}）`);
}

main();
