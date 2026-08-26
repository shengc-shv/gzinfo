/**
 * 反馈洞察分析（O 层）。
 *
 * 读 `data/feedback/*.json`（行长通过页面"📤 导出反馈"按钮下载的反馈文件），
 * 产出可执行的优化建议：
 *  1. **按 section 👍/👎 比例**：高 👎 比例 section 提示"关键词漏斗可能过严"，
 *     建议补充关键词；高 👍 比例 section 提示"关键词配置合适"
 *  2. **按 URL 👍/👎 聚合**：被多次 👎 的 URL → 排查是否真相关（候选优化词表）；
 *     被多次 👍 的 URL → 候选 AI prompt 范例（few-shot 增强）
 *  3. **时间趋势**：24h / 7d / all-time 的反馈量变化（看行长是否在持续使用）
 *  4. **音频整体反馈**：section="audio" 的 👍/👎 比例（直接评估音频价值）
 *
 * 使用：
 *   npx tsx scripts/feedback-insights.ts                       # 全量分析
 *   npx tsx scripts/feedback-insights.ts --since 7d           # 仅近 7 天
 *   npx tsx scripts/feedback-insights.ts --section must_read   # 聚焦某 section
 *   npx tsx scripts/feedback-insights.ts --down-threshold 0.3 # 调整 👎 比例阈值
 */

import fs from "node:fs";
import path from "node:path";
import {
  listAll,
  aggregate,
  type FeedbackEntry,
  type FeedbackSection,
} from "../lib/feedback/storage";

const FEEDBACK_DIR = path.resolve(process.cwd(), "data/feedback");
const SECTION_LABELS: Record<FeedbackSection, string> = {
  must_read: "今日必读",
  insights: "商机洞察",
  risk: "风险预警",
  gz_local: "广州本地",
  biz_insight: "业务启示",
  policy_market: "政策与市场",
  ipo: "IPO",
  stock_news: "股市动态",
  audio: "音频整体",
};

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
  return all.sort((a, b) => a.ts - b.ts);
}

function sectionAnalysis(
  entries: FeedbackEntry[],
): { section: string; up: number; down: number; rate: number; verdict: string }[] {
  const grouped = new Map<string, { up: number; down: number }>();
  for (const e of entries) {
    const cur = grouped.get(e.section) ?? { up: 0, down: 0 };
    if (e.vote === "up") cur.up++;
    else cur.down++;
    grouped.set(e.section, cur);
  }
  const out: ReturnType<typeof sectionAnalysis> = [];
  for (const [section, c] of grouped) {
    const total = c.up + c.down;
    const rate = total > 0 ? c.up / total : 0;
    let verdict: string;
    if (total < 3) verdict = "数据不足，暂不评判";
    else if (rate < 0.5) verdict = "👎 多于 👍，建议检查关键词/AI 选择";
    else if (rate < 0.7) verdict = "👍 占多数，可继续观察";
    else verdict = "👍 率高，配置合适";
    out.push({ section, up: c.up, down: c.down, rate, verdict });
  }
  return out.sort((a, b) => b.up + b.down - (a.up + a.down));
}

function topUrlByVote(entries: FeedbackEntry[], vote: "up" | "down", n = 5): { url: string; date: string; section: string; count: number }[] {
  const grouped = new Map<string, { count: number; date: string; section: string }>();
  for (const e of entries) {
    if (e.vote !== vote) continue;
    const cur = grouped.get(e.url) ?? { count: 0, date: e.date, section: e.section };
    cur.count++;
    grouped.set(e.url, cur);
  }
  return Array.from(grouped.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, n)
    .map(([url, c]) => ({ url, date: c.date, section: c.section, count: c.count }));
}

function timeBuckets(entries: FeedbackEntry[]): { window: string; count: number; up: number; down: number }[] {
  const now = Date.now();
  const buckets = [
    { window: "24h", hours: 24 },
    { window: "7d", hours: 24 * 7 },
    { window: "30d", hours: 24 * 30 },
    { window: "all", hours: 24 * 365 * 99 },
  ];
  return buckets
    .map((b) => {
      const cutoff = now - b.hours * 3600_000;
      const filtered = entries.filter((e) => e.ts >= cutoff);
      return {
        window: b.window,
        count: filtered.length,
        up: filtered.filter((e) => e.vote === "up").length,
        down: filtered.filter((e) => e.vote === "down").length,
      };
    })
    .filter((b) => b.count > 0 || b.window === "all");
}

function main() {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf("--since");
  const sinceWindow = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined; // "24h" | "7d" | "30d"
  const sectionIdx = args.indexOf("--section");
  const focusSection = sectionIdx >= 0 ? args[sectionIdx + 1] : undefined;
  const downIdx = args.indexOf("--down-threshold");
  const downThreshold = downIdx >= 0 ? Number(args[downIdx + 1]) : 0.4;

  let entries = loadAll();
  if (entries.length === 0) {
    console.log("📭 暂无反馈数据（data/feedback/）");
    console.log("   行长点报告页底部「📤 导出反馈」按钮即可下载反馈 JSON 放回此处");
    return;
  }

  // 按时间窗过滤
  if (sinceWindow) {
    const hours = sinceWindow.endsWith("h")
      ? Number(sinceWindow.slice(0, -1))
      : sinceWindow.endsWith("d")
        ? Number(sinceWindow.slice(0, -1)) * 24
        : 24 * 30;
    const cutoff = Date.now() - hours * 3600_000;
    entries = entries.filter((e) => e.ts >= cutoff);
    if (entries.length === 0) {
      console.log(`📭 近 ${sinceWindow} 无反馈数据`);
      return;
    }
  }

  // 按 section 过滤
  if (focusSection) {
    entries = entries.filter((e) => e.section === focusSection);
    if (entries.length === 0) {
      console.log(`📭 section="${focusSection}" 无反馈数据`);
      return;
    }
  }

  const stats = aggregate(entries);
  const dateRange = entries.length > 0
    ? `${new Date(entries[0].ts).toISOString().slice(0, 10)} → ${new Date(entries[entries.length - 1].ts).toISOString().slice(0, 10)}`
    : "—";

  console.log(`\n=== 反馈洞察（${entries.length} 条，${dateRange}）===\n`);

  // 1) 时间趋势
  console.log("📅 时间趋势：");
  for (const b of timeBuckets(entries)) {
    if (b.count === 0) continue;
    const rate = b.count > 0 ? Math.round((b.up / b.count) * 100) : 0;
    console.log(`  ${b.window.padEnd(6)}  ${b.count} 条  👍 ${b.up} / 👎 ${b.down}  (👍率 ${rate}%)`);
  }
  console.log();

  // 2) section 维度
  console.log("🎯 按 section 分布：");
  const sa = sectionAnalysis(entries);
  for (const s of sa) {
    const total = s.up + s.down;
    if (total === 0) continue;
    const label = SECTION_LABELS[s.section as FeedbackSection] ?? s.section;
    const rate = Math.round(s.rate * 100);
    const bar = "█".repeat(Math.round(s.rate * 10)) + "░".repeat(10 - Math.round(s.rate * 10));
    console.log(`  ${label.padEnd(8)}  👍 ${String(s.up).padStart(3)}  👎 ${String(s.down).padStart(3)}  👍率 ${String(rate).padStart(3)}%  ${bar}`);
    if (s.rate < downThreshold && total >= 3) {
      console.log(`     └─ ⚠️  ${s.verdict}`);
    } else if (s.rate >= 0.7 && total >= 3) {
      console.log(`     └─ ✅  ${s.verdict}`);
    }
  }
  console.log();

  // 3) 高 👎 URL（候选词表优化）
  const downUrls = topUrlByVote(entries, "down", 5);
  if (downUrls.length > 0) {
    console.log("👎 多次 👎 的 URL（候选词表/AI prompt 优化）：");
    for (const u of downUrls) {
      const sec = SECTION_LABELS[u.section as FeedbackSection] ?? u.section;
      console.log(`  ${String(u.count).padStart(2)}×👎  ${sec.padEnd(8)}  ${u.url}  (${u.date})`);
    }
    console.log();
  }

  // 4) 高 👍 URL（候选 AI prompt 范例）
  const upUrls = topUrlByVote(entries, "up", 5);
  if (upUrls.length > 0) {
    console.log("👍 多次 👍 的 URL（候选 AI prompt few-shot 范例）：");
    for (const u of upUrls) {
      const sec = SECTION_LABELS[u.section as FeedbackSection] ?? u.section;
      console.log(`  ${String(u.count).padStart(2)}×👍  ${sec.padEnd(8)}  ${u.url}  (${u.date})`);
    }
    console.log();
  }

  // 5) 音频整体反馈
  const audioEntries = entries.filter((e) => e.section === "audio");
  if (audioEntries.length > 0) {
    const up = audioEntries.filter((e) => e.vote === "up").length;
    const down = audioEntries.length - up;
    const rate = Math.round((up / audioEntries.length) * 100);
    console.log(`🎙️ 音频整体反馈：${audioEntries.length} 条  👍率 ${rate}%`);
    if (rate < 50 && audioEntries.length >= 3) {
      console.log("   └─ ⚠️ 音频内容需优化（行长听完后多数 👎）");
    } else if (rate >= 70) {
      console.log("   └─ ✅ 音频内容获得行长认可");
    }
    console.log();
  }

  // 6) 行动建议
  console.log("💡 行动建议：");
  const highDown = sa.filter((s) => s.rate < downThreshold && s.up + s.down >= 3);
  if (highDown.length > 0) {
    for (const s of highDown) {
      const label = SECTION_LABELS[s.section as FeedbackSection] ?? s.section;
      console.log(`  • [${label}]  👎 占比 ${Math.round((1 - s.rate) * 100)}%（${s.down}/${s.up + s.down}）→ 检查关键词漏斗是否过严，或 AI 选择是否跑偏`);
    }
  } else {
    console.log("  • 所有 section 👍 率 ≥ 阈值，无明显优化点");
  }
  if (upUrls.length > 0) {
    console.log(`  • 候选 few-shot：把 ${upUrls[0].url}（${upUrls[0].count}×👍）作为 AI prompt 的"什么是好必读"范例`);
  }
  if (downUrls.length > 0) {
    console.log(`  • 候选剔除：把 ${downUrls[0].url}（${downUrls[0].count}×👎）作为 AI prompt 的反例（"这种不要进"）`);
  }
  console.log();
}

main();
