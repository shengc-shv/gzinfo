import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, loadAllSources } from "../lib/sources/registry";
import type { ArticleInput } from "../lib/types";
import { ingestAll } from "../lib/pipeline/ingest";
import { ConsoleLogger, type DailyContext, type Tier } from "../lib/pipeline/context";
import type { HistoryStore } from "../lib/output/history";
import type { AiAssetStore } from "../lib/ai/assets";
import { renderHtml } from "../lib/output/render";
import { buildNoAiReport } from "../lib/output/report-from-articles";
import { DISPLAY_WINDOW_DAYS } from "../lib/output/render/cards";
import { loadHistory, buildRolling, saveHistory } from "../lib/output/history";
import { applyKeywordFilter } from "../lib/filters/keyword-filter";
import {
  keywordFilterEnabled,
  keywordFilterFallbackEnabled,
  loadKeywordConfig,
  dedupSimilarEnabled,
  loadDedupConfig,
} from "../lib/filters/config";
import {
  dedupeByTitleSimilarity,
  dedupeAgainstHistory,
  type HistorySimilarEntry,
} from "../lib/ingest/dedup-similar";
import { filterByWindow } from "../lib/ingest/merge";
import type { FilterResult, RawArticleInput } from "../lib/filters/types";
import { REPORTS_DIR } from "../lib/output/paths";
import { todayKey } from "../lib/utils";

// 本地验证工具（无 AI）。写盘走唯一存储 data/history/reports/，
// 与 daily.ts 一致；build-site 会从唯一存储同步到发布目录。

async function main() {
  console.log("🚀 Dry-run 模式（无 AI）开始...\n");

  const date = todayKey();
  let articles: ArticleInput[] = [];

  // ----- 采集（复用 daily.ts 的 ingestAll：24 源并发 Promise.allSettled + 爬虫合并 + tier 补齐）-----
  // 一并修掉旧 dry-run 漏掉 crawled.stocks（昨日股市）的 bug：ingestAll 已含三类爬虫合并。
  // OFFLINE 模式不访问网络：纯历史渲染，跳过采集（与 daily.ts 一致）。
  const isOffline = process.env.OFFLINE === 'true';
  if (!isOffline) {
    // 最小 ctx：ingestAll 只用 sources / tierBySource / errors，不触发凭证校验或 AI。
    const ctx: DailyContext = {
      startTime: new Date(),
      date,
      mode: { kind: 'ai' },
      sources: loadAllSources(),
      tierBySource: (() => {
        const m = new Map<string, Tier>();
        for (const s of loadAllSources()) if (s.tier) m.set(s.id, s.tier);
        return m;
      })(),
      history: {} as HistoryStore,
      aiAssets: {} as AiAssetStore,
      errors: [],
      log: new ConsoleLogger('[dry-run]'),
    };
    const ing = await ingestAll(ctx);
    articles = ing.articles;
    console.log(`  [dry-run] 采集合并完成: ${articles.length} 条`);
  } else {
    console.log('  ℹ️ OFFLINE 模式：跳过爬虫抓取与网络抓取（与 daily.ts 一致）');
  }

  // —— 关键词漏斗（与 daily.ts 一致，边界③最前端，零成本）：银行零售关键词体系硬过滤 ——
  // 仅真实抓取路径生效；OFFLINE 纯历史渲染不过漏斗（历史条目已由 AI 打标，不应再粗筛）。
  if (!isOffline && keywordFilterEnabled()) {
    const kwConfig = loadKeywordConfig();
    const before = articles.length;
    const keep: ArticleInput[] = [];
    let opp = 0;
    let weekly = 0;
    for (const a of articles) {
      const input: RawArticleInput = {
        title: a.title,
        content: a.excerpt,
        sourceId: a.sourceId,
        url: a.url,
        category: a.category, // 参考区（tech/ipo/gd-ipo/politics）豁免漏斗，仅商机扫描
      };
      const r = applyKeywordFilter(input, kwConfig);
      if (!r.pass) continue;
      const tagged = a as ArticleInput & {
        filterBucket?: string;
        filterDimensions?: string[];
        filterOpportunities?: FilterResult["opportunities"];
      };
      tagged.filterBucket = r.bucket;
      tagged.filterDimensions = r.dimensions;
      if (r.opportunities?.length) tagged.filterOpportunities = r.opportunities;
      if (r.bucket === "opportunity") opp++;
      if (r.bucket === "weekly") weekly++;
      keep.push(a);
    }
    if (keep.length === 0 && keywordFilterFallbackEnabled()) {
      console.warn(
        `[dry-run] ⚠️ 关键词漏斗将全部 ${before} 条过滤为 0（疑似误杀/词表过严）— 回退全量保底，避免空报告`,
      );
    } else {
      articles = keep;
      console.log(
        `[dry-run] 🔻 关键词漏斗: ${before} → ${articles.length} 条（商机 ${opp} / 周报 ${weekly}，其余日报池）`,
      );
    }
  }

  // —— 标题相似度判重（与 daily.ts 一致，漏斗之后、buildRolling 之前）——
  if (!isOffline && dedupSimilarEnabled()) {
    const dd = loadDedupConfig();
    const before = articles.length;
    const { kept, removed } = dedupeByTitleSimilarity(articles, {
      threshold: dd.threshold,
      maxPerTheme: dd.maxPerTheme,
    });
    if (removed.length > 0) {
      console.log(
        `[dry-run] 🔁 标题相似度判重: ${before} → ${kept.length} 条（阈值 ${dd.threshold}、每主题 ≤${dd.maxPerTheme}、同 tier 只留 1；移除 ${removed.length} 条重复报道）`,
      );
    }
    articles = kept;
  }

  // —— 超窗口旧文过滤（与 daily.ts 一致）：rss 混入的 7 天前旧文不进 AI、不展示（展示窗口 {{DISPLAY}} 天）——
  if (!isOffline) {
    const wBefore = articles.length;
    articles = filterByWindow(articles, DISPLAY_WINDOW_DAYS);
    if (articles.length !== wBefore) {
      console.log(
        `[dry-run] 🗓 超窗口旧文过滤: ${wBefore} → ${articles.length} 条（移除 ${wBefore - articles.length} 条 7 天前旧文）`,
      );
    }
  }

  // 合并滚动 7 天历史（窗口按信息发生时间 publishedAt 计）：今日抓取 + 历史缓存（按 fetchedToday 打标），
  // 使渲染同时拥有「当天」与「过去7天」两个时间标签。
  const history = loadHistory();

  // —— 跨天标题判重（与 daily.ts 一致，非 OFFLINE）：新抓取 vs 历史库，先来后到 ——
  if (!isOffline) {
    const tierBySource = new Map(loadAllSources().map((s) => [s.id, s.tier]));
    const histSim: HistorySimilarEntry[] = Object.values(history).map((e) => ({
      title: e.title,
      url: e.url,
      tier: tierBySource.get(e.sourceId),
    }));
    const dhBefore = articles.length;
    const dh = dedupeAgainstHistory(articles, histSim, { maxPerTheme: 2 }) // 跨天阈值默认 0.6（Dice）;
    if (dh.removed.length > 0) {
      console.log(
        `[dry-run] 🔄 跨天标题判重: ${dhBefore} → ${dh.kept.length} 条（历史库已覆盖 ${dh.removed.length} 条重复主题）`,
      );
    }
    articles = dh.kept;
  }

  const nowIso = new Date().toISOString();
  const rolling = buildRolling(articles, history);
  if (isOffline) {
    // 纯历史渲染无今日抓取：把历史缓存中「今天 lastSeenAt」的条目标记为当天（fetchedToday=true），
    // 复刻线上「当天」视图（与 preview-local 的 isToday 逻辑一致）；其余保持历史。
    const today = todayKey();
    let marked = 0;
    for (const a of rolling) {
      if (a.fetchedToday !== true) {
        const e = history[a.url];
        if (e && typeof e.lastSeenAt === 'string' && e.lastSeenAt.startsWith(today)) {
          a.fetchedToday = true;
          marked++;
        }
      }
    }
    console.log(`  ℹ️ OFFLINE：历史缓存中「当天(lastSeenAt=${today})」标记 ${marked} 条`);
  }
  // 非 OFFLINE：dry-run 无 AI，仅更新 lastSeenAt / 保留历史摘要，不覆盖已有摘要。
  // OFFLINE 为纯渲染验证：只读历史缓存，绝不写回（避免空 articles 触发 prune 裁剪历史）。
  if (!isOffline) {
    saveHistory(articles, history, nowIso);
  } else {
    console.log(`  ℹ️ OFFLINE：跳过 saveHistory（不修改历史缓存）`);
  }
  console.log(`\n📊 总文章数(今日): ${articles.length} ｜ 滚动列表(含过去7天): ${rolling.length} ｜ 历史缓存: ${Object.keys(history).length} 条`);

  // 统计各分类数量
  const catCount: Record<string, number> = {};
  for (const a of articles) {
    catCount[a.category] = (catCount[a.category] || 0) + 1;
  }
  console.log(`📈 分类统计:`, catCount);

  // ----- 渲染 HTML（无 AI，由滚动文章池合成新 schema 报告）-----
  console.log(`\n🎨 渲染 HTML 报告 (${date})...`);
  const report = buildNoAiReport(rolling);
  const html = renderHtml(report, date);

  // 写入文件
  const dateDir = path.join(REPORTS_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, date);
  fs.writeFileSync(`${base}.html`, html, "utf8");
  console.log(`✅ 报告已生成: ${base}.html`);

  // 导出信息源抓取结果（排除爬虫产物 gd-*/gz-*），供 test.yml 上传为 fetched-data artifact、
  // 本地「预 AI 分析加载」任务拉回比对：识别历史库中没有的信息源新增条目 → AI 分析打标。
  const fetched = articles.filter((a) => !/^(gd-|gz-)/.test(a.sourceId || ""));
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/fetched-articles.json", JSON.stringify(fetched, null, 2), "utf8");
  console.log(`📤 信息源抓取结果导出: ${fetched.length} 条 → data/fetched-articles.json`);

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
