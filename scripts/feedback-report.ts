/**
 * 反馈聚合读取脚本（P0-D）。
 *
 * 读 `data/feedback/*.json`（行长用"导出反馈"按钮下载后放到这里），
 * 输出按日期 / 板块 / URL 维度的统计。
 *
 * 使用：
 *   npx tsx scripts/feedback-report.ts                       # 汇总
 *   npx tsx scripts/feedback-report.ts --by-url              # 按 URL（看哪些条目被 👍/👎）
 *   npx tsx scripts/feedback-report.ts --date 2026-08-26     # 看某天
 */

import fs from "node:fs";
import path from "node:path";
import { listAll, aggregate, type FeedbackEntry } from "../lib/feedback/storage";

const FEEDBACK_DIR = path.resolve(process.cwd(), "data/feedback");

function loadAll(): FeedbackEntry[] {
  if (!fs.existsSync(FEEDBACK_DIR)) return [];
  const files = fs.readdirSync(FEEDBACK_DIR).filter((f) => f.endsWith(".json"));
  const all: FeedbackEntry[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(FEEDBACK_DIR, f), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const e of parsed) all.push(e);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ 跳过 ${f}：${msg}`);
    }
  }
  // 按时间排序
  return all.sort((a, b) => a.ts - b.ts);
}

function main() {
  const args = process.argv.slice(2);
  const byUrl = args.includes("--by-url");
  const dateIdx = args.indexOf("--date");
  const filterDate = dateIdx >= 0 ? args[dateIdx + 1] : undefined;

  const entries = loadAll().filter((e) => !filterDate || e.date === filterDate);
  if (entries.length === 0) {
    console.log(
      filterDate
        ? `📭 ${filterDate} 无反馈数据（data/feedback/）`
        : `📭 暂无反馈数据（data/feedback/）— 行长点页面底部"📤 导出反馈"按钮即可下载`,
    );
    return;
  }
  const stats = aggregate(entries);

  console.log(`\n=== 反馈汇总 ===`);
  console.log(`总条数：${entries.length}（👍 ${stats.totalUp} / 👎 ${stats.totalDown}）`);

  console.log(`\n按日期：`);
  const dates = Object.keys(stats.byDate).sort();
  for (const d of dates) {
    const c = stats.byDate[d];
    const pct = c.up + c.down > 0 ? Math.round((c.up / (c.up + c.down)) * 100) : 0;
    console.log(`  ${d}  👍 ${c.up}  👎 ${c.down}  (👍率 ${pct}%)`);
  }

  console.log(`\n按板块：`);
  const sections = Object.keys(stats.bySection).sort();
  for (const s of sections) {
    const c = stats.bySection[s];
    const pct = c.up + c.down > 0 ? Math.round((c.up / (c.up + c.down)) * 100) : 0;
    console.log(`  ${s.padEnd(15)}  👍 ${c.up}  👎 ${c.down}  (👍率 ${pct}%)`);
  }

  if (byUrl) {
    console.log(`\n按 URL（被点过 ≥1 次的条目）：`);
    const urls = Object.entries(stats.byUrl).sort((a, b) => {
      const ac = a[1].up + a[1].down;
      const bc = b[1].up + b[1].down;
      return bc - ac;
    });
    for (const [key, c] of urls) {
      const v = c.up > c.down ? "👍" : c.down > c.up ? "👎" : "±";
      console.log(`  ${v} ${c.date}  ${key}  (up=${c.up} down=${c.down})`);
    }
  }

  console.log(``);
}

main();
