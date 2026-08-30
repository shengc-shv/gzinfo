/**
 * 回归测试：广东 IPO 条目必须能穿过完整 9 道过滤管线进入渲染（D-009 修复）。
 *
 * 2026-08-30 实测：东财在审表抓取 2 条（尚睿科技 / 腾信精密），但报告里 IPO 板块为 0。
 * 根因是 3 道闸之外的「通用过滤 stage」对 gd-ipo 误杀：
 *   - pre-window-2d（FETCH_WINDOW_DAYS=2）：在审企业更新稀疏（几天一更），
 *     08-24/08-27 的条目被全局 2 天窗口截掉；
 *   - single-institution：excerpt 含「保荐：XX证券股份有限公司」，被当成单家金融机构新闻丢；
 *   - title-similarity：两家不同企业共享「IPO/北交所」事件锚点被判同事件 + 爬虫未带 tier
 *     触发「同 tier 只留 1」压成 1。
 * 三处均已改为「gd-ipo/ipo 类豁免」，本测试锁住该行为，防止回退。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFilterPipeline } from "../lib/pipeline/filter";
import type { ArticleInput } from "../lib/types";
import type { DailyContext } from "../lib/pipeline/context";

// 模拟东财在审表真实产出（含保荐券商、几天前更新日）
const makeIpo = (over: Partial<ArticleInput>): ArticleInput =>
  ({
    sourceId: "em-declare",
    source: "东财在审表",
    title: "t",
    url: "https://example.com/x",
    excerpt: "",
    category: "gd-ipo",
    publishedAt: new Date(),
    ...over,
  }) as ArticleInput;

// 基准 ctx：空历史，避免跨天去重误杀；allSourceIds 用 Set（与 buildFilterContext 一致）
const ctx: DailyContext = {
  date: "2026-08-30",
  sources: [{ id: "em-declare" }],
  history: {},
  tierBySource: new Map(),
  allSourceIds: new Set(["em-declare"]),
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as DailyContext;

test("gd-ipo 条目穿过完整过滤管线不被误杀", () => {
  const articles: ArticleInput[] = [
    makeIpo({
      title: "尚睿科技：IPO问询中（拟北交所）",
      excerpt: "注册地：广东｜保荐：广发证券股份有限公司｜更新：2026-08-27",
      // 用真实「几天前」日期，故意触发 2 天窗口边界
      publishedAt: new Date("2026-08-27T08:00:00+08:00"),
    }),
    makeIpo({
      title: "东莞市腾信精密制造：IPO注册生效（拟北交所）",
      excerpt: "注册地：广东｜保荐：国泰海通证券股份有限公司｜更新：2026-08-24",
      publishedAt: new Date("2026-08-24T08:00:00+08:00"),
    }),
  ];

  const { articles: out } = runFilterPipeline(articles, ctx);
  assert.equal(out.length, 2, "两家不同在审企业应全部保留，不应被窗口/单机构/相似度过滤");
  for (const a of out) {
    assert.equal(a.category, "gd-ipo", "category 必须保持 gd-ipo");
  }
});

test("gd-ipo 豁免不波及其它类的正常过滤（对照）", () => {
  // 一条普通新闻（非 IPO）仍应走正常 2 天窗口：3 天前的旧文应被 pre-window 截掉
  const oldNews: ArticleInput = {
    sourceId: "stcn",
    source: "证券时报",
    title: "某银行发布中报",
    url: "https://example.com/n",
    category: "finance",
    publishedAt: new Date("2026-08-24T08:00:00+08:00"), // 距 08-30 已 6 天
  } as ArticleInput;
  const { articles: out } = runFilterPipeline([oldNews], ctx);
  assert.equal(out.length, 0, "非 IPO 的旧文（6 天前）仍应被 2 天窗口过滤");
});
