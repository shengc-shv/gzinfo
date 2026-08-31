/**
 * 观测脚本（无 AI、网络无关、可复现）：评估 relevanceGate 启用实际丢弃后的误杀率。
 *
 * 复用 3漏斗整改 commit④ 的豁免集合与评分逻辑（scoreBranchRelevance），
 * 对当前历史库（data/article-history.json，即当前渲染/展示保留池）逐条打分，
 * 统计「主战场」文章中被判 tier==="drop"（非分行相关业务）的数量与占比。
 *
 * 输出：
 *  - 控制台：总量 / 主战场量 / 将丢弃量 / 误杀率 / 档位分布 / 抽样标题
 *  - data/gate-observation.json：结构化结果（供后续比对 / 决策留痕）
 *
 * 注意：本脚本只观测、不修改任何条目；不改变 RELEVANCE_GATE_DROP 开关。
 */
import fs from "node:fs";
import path from "node:path";

import { loadHistory } from "../lib/output/history";
import { scoreBranchRelevance } from "../lib/ai/relevance-score";
import type { Category } from "../lib/types";

// 与 stages.ts:178 保持一致（IPO 类 + 参考区豁免）
const EXEMPT = new Set<Category>(["tech", "politics", "ipo", "gd-ipo", "stocks"]);

function main() {
  const history = loadHistory();
  const entries = Object.values(history);
  const total = entries.length;

  let mainBattlefield = 0;
  let dropCount = 0;
  const tierDist: Record<string, number> = {};
  const dropByCat: Record<string, number> = {};
  const keptByCat: Record<string, number> = {};
  const samples: Array<{
    title: string;
    category: string;
    score: number;
    signals: string[];
    url: string;
  }> = [];

  for (const e of entries) {
    const cat = e.category;
    // 与 gate 相同豁免判定：IPO 类（历史库以 category 表达）+ 参考区
    if (EXEMPT.has(cat)) {
      keptByCat[cat] = (keptByCat[cat] ?? 0) + 1;
      continue;
    }
    mainBattlefield++;
    const r = scoreBranchRelevance({
      title: e.title ?? "",
      category: e.category,
      subcategory: e.subcategory,
      sourceId: e.sourceId,
      summary: e.summary,
      url: e.url,
    });
    tierDist[r.tier] = (tierDist[r.tier] ?? 0) + 1;
    if (r.tier === "drop") {
      dropCount++;
      dropByCat[cat] = (dropByCat[cat] ?? 0) + 1;
      if (samples.length < 25) {
        samples.push({
          title: (e.title ?? "").slice(0, 80),
          category: e.category,
          score: r.score,
          signals: r.signals.slice(0, 4),
          url: e.url,
        });
      }
    } else {
      keptByCat[cat] = (keptByCat[cat] ?? 0) + 1;
    }
  }

  const rate = mainBattlefield > 0 ? (dropCount / mainBattlefield) * 100 : 0;
  const report = {
    generatedAt: new Date().toISOString(),
    totalEntries: total,
    mainBattlefield,
    wouldDrop: dropCount,
    dropRatePct: Number(rate.toFixed(2)),
    tierDistribution: tierDist,
    dropByCategory: dropByCat,
    keptByCategory: keptByCat,
    samples,
    note: "warn-only 观测：RELEVANCE_GATE_DROP 仍为 false，本脚本仅评估，不改任何开关或数据",
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(
    path.join("data", "gate-observation.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  console.log("🔎 relevanceGate warn-only 观测（基于当前历史库保留池）");
  console.log(`  历史库总条目      : ${total}`);
  console.log(`  主战场文章(待评估) : ${mainBattlefield}`);
  console.log(`  若启用将丢弃(tier=drop): ${dropCount}`);
  console.log(`  误杀率(占主战场)   : ${rate.toFixed(2)}%  ${rate < 5 ? "✅ <5%" : "⚠️ ≥5% 需复核"}`);
  console.log(`  档位分布          : ${JSON.stringify(tierDist)}`);
  console.log(`  将被丢弃的分类分布 : ${JSON.stringify(dropByCat)}`);
  console.log(`  抽样(将被丢弃)前 ${samples.length} 条:`);
  for (const s of samples) {
    console.log(`    - [${s.category}] (分${s.score}) ${s.title}`);
    console.log(`       信号: ${s.signals.join("; ")}`);
  }
  console.log(`\n📄 报告 → data/gate-observation.json`);
}

main();
