/**
 * 脏数据体检：profile article-history.json 的「未打标 / 无摘要」分布。
 *
 * 用途（2026-08-31 新增）：
 *   定位 `ai_relevant` 与 `summary` 缺失的规模与来源，回答「脏数据从哪来」。
 *   判定口径与生产一致 —— 只有穿过 9 道过滤并经过 PASS1/PASS2 判定的条目才会被
 *   写入 `relevant`（saveHistory 落盘为 ai_relevant），其余条目带「无 ai_relevant
 *   字段」进 history，且会被跨天判重永久挡在 AI 管线之外。
 *
 * 用法：
 *   npm run analyze:dirty                  # 默认 data/article-history.json
 *   HISTORY_PATH=/path/to.json npm run analyze:dirty
 *   npx tsx scripts/analyze-dirty-data.ts /path/to.json
 *
 * 输出 10 组：总览 / 打标×摘要交叉 / 按 sourceId / 按 category / 按 subcategory /
 *            按 publishedAt 日期 / 未打标来源 top10 / 留存跨度 / URL 唯一性 / 疑似爬虫来源。
 */
import fs from "node:fs";

type E = Record<string, any>;

const HISTORY_PATH = process.argv[2] ?? process.env.HISTORY_PATH ?? "data/article-history.json";
const TZ = process.env.REPORT_TZ || "Asia/Shanghai";

function pct(n: number, d: number): string {
  return d === 0 ? "0%" : `${((n / d) * 100).toFixed(1)}%`;
}

function dayKey(v: any): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function main(): void {
  if (!fs.existsSync(HISTORY_PATH)) {
    console.error(`❌ 找不到历史库: ${HISTORY_PATH}`);
    process.exit(1);
  }
  const raw: Record<string, E> = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  const es = Object.values(raw);
  const total = es.length;
  if (total === 0) {
    console.log("历史库为空，无数据可分析");
    return;
  }

  const has = (e: E, k: string): boolean => !!e[k] && String(e[k]).trim() !== "";
  const untaggedOf = (e: E): boolean => e.ai_relevant === undefined || e.ai_relevant === null;

  const taggedTrue = es.filter((e) => e.ai_relevant === true).length;
  const taggedFalse = es.filter((e) => e.ai_relevant === false).length;
  const untagged = es.filter(untaggedOf).length;

  console.log(`历史库: ${HISTORY_PATH}`);
  console.log("=========== 1. 总览 ===========");
  console.log(`总条目 ${total}`);
  console.log(`  ai_relevant=true  ${String(taggedTrue).padStart(4)}  (${pct(taggedTrue, total)})`);
  console.log(`  ai_relevant=false ${String(taggedFalse).padStart(4)}  (${pct(taggedFalse, total)})`);
  console.log(`  未打标            ${String(untagged).padStart(4)}  (${pct(untagged, total)})`);
  console.log(`  有 summary        ${String(es.filter((e) => has(e, "summary")).length).padStart(4)}  (${pct(es.filter((e) => has(e, "summary")).length, total)})`);
  console.log(`  有 excerpt        ${String(es.filter((e) => has(e, "excerpt")).length).padStart(4)}  (${pct(es.filter((e) => has(e, "excerpt")).length, total)})`);
  console.log(`  无 publishedAt    ${String(es.filter((e) => !dayKey(e.publishedAt)).length).padStart(4)}  (${pct(es.filter((e) => !dayKey(e.publishedAt)).length, total)})`);

  console.log("\n=========== 2. 打标状态 × 有无 summary 交叉 ===========");
  console.log("  （「有摘要但未打标」或「打标true但无摘要」若 >0，说明存在半写入/回写丢失）");
  const cross: Record<string, number> = {};
  for (const e of es) {
    const k = `${e.ai_relevant === true ? "true" : e.ai_relevant === false ? "false" : "未打标"} / ${has(e, "summary") ? "有摘要" : "无摘要"}`;
    cross[k] = (cross[k] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(cross).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${String(v).padStart(4)}  (${pct(v, total)})`);
  }

  const groupBy = (keyFn: (e: E) => string | undefined, label: string, topN: number) => {
    const g: Record<string, { n: number; tag: number; sum: number }> = {};
    for (const e of es) {
      const k = keyFn(e) ?? "(缺失)";
      g[k] = g[k] ?? { n: 0, tag: 0, sum: 0 };
      g[k].n++;
      if (e.ai_relevant === true) g[k].tag++;
      if (has(e, "summary")) g[k].sum++;
    }
    const rows = Object.entries(g).sort((a, b) => b[1].n - a[1].n);
    console.log(`\n=========== ${label}（共 ${rows.length} 组，显示前 ${topN}）===========`);
    console.log("  " + "键".padEnd(34) + "总数".padStart(6) + "占比".padStart(8) + "打标".padStart(6) + "摘要".padStart(6));
    for (const [k, v] of rows.slice(0, topN)) {
      console.log(
        `  ${k.slice(0, 32).padEnd(34)}${String(v.n).padStart(6)}${pct(v.n, total).padStart(8)}${String(v.tag).padStart(6)}${String(v.sum).padStart(6)}`,
      );
    }
    return rows;
  };

  const bySource = groupBy((e) => String(e.sourceId ?? ""), "3. 按来源 sourceId", 18);
  groupBy((e) => String(e.category ?? ""), "4. 按 category", 12);
  groupBy((e) => String(e.subcategory ?? ""), "5. 按 subcategory", 15);
  groupBy((e) => dayKey(e.publishedAt) ?? "(无日期)", "6. 按 publishedAt 日期", 15);

  console.log("\n=========== 7. 未打标条目来源 top10（脏数据主力）===========");
  const un = es.filter(untaggedOf);
  const g2: Record<string, number> = {};
  for (const e of un) {
    const k = String(e.sourceId ?? "(缺失)");
    g2[k] = (g2[k] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(g2).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${k.slice(0, 32).padEnd(34)}${String(v).padStart(6)}  (占未打标 ${pct(v, un.length)})`);
  }

  console.log("\n=========== 8. 留存跨度（firstSeenAt）===========");
  const times = es.map((e) => new Date(e.firstSeenAt ?? e.publishedAt).getTime()).filter((t) => !Number.isNaN(t));
  if (times.length) {
    const min = Math.min(...times);
    const max = Math.max(...times);
    console.log(`  最早 ${new Date(min).toISOString().slice(0, 10)} / 最晚 ${new Date(max).toISOString().slice(0, 10)}`);
    console.log(`  跨度 ${((max - min) / 86_400_000).toFixed(1)} 天`);
  }

  console.log("\n=========== 9. URL 唯一性 ===========");
  const urls = es.map((e) => String(e.url ?? ""));
  console.log(`  条目 ${total} / 唯一 url ${new Set(urls).size} / 重复 ${total - new Set(urls).size}`);

  console.log("\n=========== 10. 疑似爬虫来源 ===========");
  const crawlerish = bySource.filter(([k]) => /商机|crawl|gz-|ipo|stock|eastmoney|hkex/i.test(k));
  const crawlerCount = crawlerish.reduce((s, [, v]) => s + v.n, 0);
  console.log(`  疑似爬虫来源 ${crawlerish.length} 个，合计 ${crawlerCount} 条 (${pct(crawlerCount, total)})`);
  for (const [k, v] of crawlerish) console.log(`    ${k.slice(0, 32).padEnd(34)}${String(v.n).padStart(6)}  打标 ${v.tag}`);

  console.log(`\n⚠️  未打标占比 ${pct(untagged, total)}（阈值参考：<30% 健康，>80% 说明打标链路未覆盖主要来源）`);
}

main();
