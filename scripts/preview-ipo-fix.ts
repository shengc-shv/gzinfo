/**
 * 聚焦预览：仅跑 IPO 爬虫（复用已修好的真实爬虫 + renderGdIpo + renderHtml），
 * 把「广东IPO动态」板块（今日必读横滑 + 底部 tab）渲染成 outputs/ipo-preview.html，
 * 用于肉眼核对 HKEX 链接已指向「申請版本（招股书）」而非警示函/承诺书。
 *
 * 不调用任何 AI、不写 article-history.json、不跑 gz/stocks 管线，纯本地预览。
 */
import fs from "node:fs";
import path from "node:path";
import { fetchCrawledArticles } from "../lib/sources/crawlers";
import { buildGdIpo } from "../lib/pipeline/side-outputs/gd-ipo";
import { renderHtml } from "../lib/output/render";
import { loadAllSources } from "../lib/sources/registry";
import type { ArticleInput, DailyReport } from "../lib/types";
import type { SourceTier } from "../lib/sources/tiers";
import type { DailyContext } from "../lib/pipeline/context";

async function main() {
  console.log("[preview] 抓取 IPO 源（含港交所披露易）…");
  const { ipo } = await fetchCrawledArticles();
  console.log(`[preview] 抓到 IPO 原始条目 ${ipo.length} 条`);

  // 源等级（T1/T1.5/T2）：生产链路由 ingest 按 registry 补齐，预览脚本此前漏传 →
  // 交易所官方源被错标成「媒体」。此处按 registry 补齐，保证预览与线上渲染一致。
  const tierBySource = new Map<string, SourceTier | undefined>(
    loadAllSources().map((s) => [s.id, s.tier]),
  );

  const articles: ArticleInput[] = ipo
    .filter((c) => c.url)
    .map((c) => ({
      sourceId: c.sourceId || "",
      title: c.title || "",
      url: c.url || "",
      excerpt: c.excerpt || "",
      publishedAt: c.publishedAt ? new Date(c.publishedAt) : undefined,
      // region 由爬虫在广东企业侧置 'gd' → 归类为 gd-ipo（与 routeRegion 同口径）
      category: (c.region === "gd" ? "gd-ipo" : "ipo") as ArticleInput["category"],
      summary: c.summary || "",
      source: c.source || "",
      region: c.region,
      tier: tierBySource.get(c.sourceId || ""),
      ipoStage: c.ipoStage,
      listedDate: c.listedDate,
      registeredProvince: c.registeredProvince,
      officialUrl: c.officialUrl,
      officialLabel: c.officialLabel,
      fetchedToday: true,
    }));

  const date = new Date().toISOString().slice(0, 10);
  const stubCtx = {
    log: { info: () => {}, warn: () => {} },
  } as unknown as DailyContext;
  const base: DailyReport = {
    date,
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
  const report = buildGdIpo(base, articles, stubCtx);

  const ipoItems = report.sections?.ipo ?? [];
  const hkCount = ipoItems.filter((i) => (i.url || "").includes("hkexnews")).length;
  console.log(`[preview] 构建后 IPO 板块 ${ipoItems.length} 条（其中港交所相关 ${hkCount} 条）`);

  const html = renderHtml(report, date, {});
  const out = path.resolve("outputs/ipo-preview.html");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, "utf8");
  console.log(`[preview] ✅ 预览已生成: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
