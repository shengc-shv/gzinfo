import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import { fetchCrawledArticles } from "../lib/sources/crawlers";
import type { ArticleInput } from "../lib/types";
import { renderHtml } from "../lib/output/render";
import { buildNoAiReport } from "../lib/output/report-from-articles";
import { resolveDateDir } from "../lib/output/paths";
import { todayKey } from "../lib/utils";

async function main() {
  console.log("🚀 Dry-run 模式（无 AI）开始...\n");

  const date = todayKey();
  const articles: ArticleInput[] = [];

  // ----- 加载爬虫数据（广州商机 + 广东IPO）—— M3-A：进程内 runner，与 daily.ts 同入口，不再读 JSON 中间文件 -----
  const crawled = await fetchCrawledArticles().catch((e: any) => {
    console.warn("  ⚠️ 爬虫抓取失败（跳过爬虫源）:", e?.message ?? e);
    return { ipo: [], gz: [], stocks: [] };
  });
  if (crawled.ipo.length) {
    let count = 0;
    for (const item of crawled.ipo) {
      const exists = articles.some((a) => a.url === item.url);
      if (exists) continue;
      articles.push({
        sourceId: item.sourceId || "gd-local-scraper",
        source: item.source || "广东本地爬虫",
        title: item.title || "无标题",
        url: item.url || "",
        excerpt: item.excerpt || "",
        // 时间真实性红线（2026-08-25 用户要求，2026-08-29 强化）：无明确发布时间 →
        // 不写 publishedAt（undefined），由下游渲染按无日期处理，绝不 new Date() 兜底。
        publishedAt: item.publishedAt ? new Date(item.publishedAt) : undefined,
        category: "gd-ipo",
        summary: item.summary || "",
      });
      count++;
    }
    console.log(`  ✅ 加载爬虫数据 ${count} 条（跳过 ${crawled.ipo.length - count} 条重复）`);
  } else {
    console.log(`  ℹ️ 爬虫无 IPO/新股数据（或抓取失败）`);
  }
  // 2026-08-29 修复：加载广州本地爬虫数据（dayoo/cnr/southcn 等）——
  // 此前只处理 crawled.ipo，crawled.gz 被忽略 → `npm run render` 渲染时广州本地恒空。
  if (crawled.gz.length) {
    let count = 0;
    for (const item of crawled.gz) {
      const exists = articles.some((a) => a.url === item.url);
      if (exists) continue;
      articles.push({
        sourceId: item.sourceId || "gz-crawler",
        source: item.source || "广州本地爬虫",
        title: item.title || "无标题",
        url: item.url || "",
        excerpt: item.excerpt || "",
        publishedAt: item.publishedAt ? new Date(item.publishedAt) : undefined,
        category: (item.category || "gz") as "gz",
        summary: item.summary || "",
        ...(item.subcategory ? { subcategory: item.subcategory } : {}),
      });
      count++;
    }
    console.log(`  ✅ 加载广州本地爬虫数据 ${count} 条（跳过 ${crawled.gz.length - count} 条重复）`);
  } else {
    console.log(`  ℹ️ 爬虫无广州本地数据（或抓取失败）`);
  }

  // 抓取所有 enabled 数据源
  const enabled = sources.filter((s) => s.enabled !== false);
  for (const source of enabled) {
    try {
      const items = await fetchSource(source);
      console.log(`  ${source.id.padEnd(20)} ${items.length}`);
      articles.push(...items.map((it) => ({ ...it, source: source.name })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ${source.id.padEnd(20)} FAILED — ${msg}`);
    }
  }

  console.log(`\n📊 总文章数: ${articles.length}`);

  // 统计各分类数量
  const catCount: Record<string, number> = {};
  for (const a of articles) {
    catCount[a.category] = (catCount[a.category] || 0) + 1;
  }
  console.log(`📈 分类统计:`, catCount);

  // ----- 渲染 HTML（无 AI，由文章池合成新 schema 报告）-----
  console.log(`\n🎨 渲染 HTML 报告 (${date})...`);
  const report = buildNoAiReport(articles);
  const html = renderHtml(report, date);

  // 写入文件（读路径解析：优先 data/history/reports，回退 daily_reports）
  const dateDir = resolveDateDir(date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, date);
  fs.writeFileSync(`${base}.html`, html, "utf8");
  console.log(`✅ 报告已生成: ${base}.html`);

  console.log(`\n📝 前 10 条文章:`);
  articles.slice(0, 10).forEach((a, i) => {
    console.log(`  ${i + 1}. [${a.category}] ${a.title?.slice(0, 50)}`);
  });
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
