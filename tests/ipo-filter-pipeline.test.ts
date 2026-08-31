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
import { EastMoneyDeclareCrawler } from "../lib/sources/crawlers/sources/eastmoney-declare";
import type { ArticleInput } from "../lib/types";
import type { DailyContext } from "../lib/pipeline/context";

/**
 * ⚠️ mock 日期一律相对今天动态生成，绝不写死（2026-08-31 踩坑记录）：
 * 初版把 publishedAt 写死成 2026-08-27 / 2026-08-24，随真实日期推移
 * （08-30 → 08-31）条目滑出爬虫 7 天窗口与过滤 2 天窗口，测试结果当天通过、
 * 次日随机失败（且同一天不同时刻因「窗口按时刻算」也会翻）。这里统一用
 * daysAgo()/endDateAgo() 生成，保证任何一天跑都是同一语义。
 */
const DAY = 86_400_000;
/** n 天前的同一时刻（Date） */
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);
/** n 天前的 YYYY-MM-DD（东财 END_DATE 格式） */
const endDateAgo = (n: number): string => {
  const d = daysAgo(n);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
/** 今日 YYYY-MM-DD（ctx.date） */
const todayKey = endDateAgo(0);

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
  date: todayKey,
  sources: [{ id: "em-declare" }],
  history: {},
  tierBySource: new Map(),
  allSourceIds: new Set(["em-declare"]),
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as DailyContext;

// 在审企业更新稀疏（几天一更），取 3/4 天前：既越过 2 天抓取窗口（验证豁免生效），
// 又稳稳落在爬虫 7 天窗口与 7 天展示窗口内（不会因真实日期推移被别的闸误杀）。
const AGO_A = 3;
const AGO_B = 4;

test("gd-ipo 条目穿过完整过滤管线不被误杀", () => {
  const articles: ArticleInput[] = [
    makeIpo({
      title: "尚睿科技：IPO问询中（拟北交所）",
      excerpt: `注册地：广东｜保荐：广发证券股份有限公司｜更新：${endDateAgo(AGO_A)}`,
      // 故意越过 2 天抓取窗口（验证 gd-ipo 豁免生效）
      publishedAt: daysAgo(AGO_A),
    }),
    makeIpo({
      title: "东莞市腾信精密制造：IPO注册生效（拟北交所）",
      excerpt: `注册地：广东｜保荐：国泰海通证券股份有限公司｜更新：${endDateAgo(AGO_B)}`,
      publishedAt: daysAgo(AGO_B),
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
    publishedAt: daysAgo(6), // 越过 2 天窗口，且 gd-ipo 豁免不适用于 finance
  } as ArticleInput;
  const { articles: out } = runFilterPipeline([oldNews], ctx);
  assert.equal(out.length, 0, "非 IPO 的旧文（6 天前）仍应被 2 天窗口过滤");
});

/**
 * BUG A 回归：东财在审表同批多家广东企业必须产出「唯一 URL」。
 * 旧实现所有条目共用列表页 URL（https://data.eastmoney.com/xg/xg/），
 * 被 fetchCrawledArticles 的 dedupeByUrl 合并成 1 条 → 多家企业被压成 1 家。
 * 修复后 URL 带 #企业代码锚点，每家独立。直接喂假响应，避免依赖网络。
 */
test("东财在审爬虫同批多家企业产出唯一 URL（BUG A 回归）", async () => {
  const c = new EastMoneyDeclareCrawler();
  const fake = JSON.stringify({
    result: {
      data: [
        {
          DECLARE_ORG: "尚睿科技股份有限公司",
          STATE: "已问询",
          REG_ADDRESS: "广东",
          END_DATE: `${endDateAgo(3)} 00:00:00`,
          SECURITY_CODE: "A25256",
          PREDICT_LISTING_MARKET: "北交所",
          RECOMMEND_ORG: "广发证券股份有限公司",
        },
        {
          DECLARE_ORG: "东莞市腾信精密制造股份有限公司",
          STATE: "注册",
          REG_ADDRESS: "广东",
          END_DATE: `${endDateAgo(4)} 00:00:00`,
          SECURITY_CODE: "A25121",
          PREDICT_LISTING_MARKET: "北交所",
          RECOMMEND_ORG: "国泰海通证券股份有限公司",
        },
      ],
    },
  });
  const parsed = await c.parseArticle(fake);
  assert.equal(parsed.length, 2, "应解析出 2 家");
  const urls = parsed.map((p) => p.url);
  assert.equal(new Set(urls).size, urls.length, "每家应产出唯一 URL，避免 dedupeByUrl 合并");
  for (const u of urls) {
    assert.ok(
      (u ?? "").startsWith("https://data.eastmoney.com/xg/xg/#"),
      "URL 应为列表页 + 企业锚点",
    );
  }
});

/**
 * BUG B 回归：跨天标题判重（第 7 道）必须豁免 gd-ipo/ipo。
 * 旧实现未豁免 → 重抓到的同一批广东企业被「历史库已覆盖」判重剔除，
 * 表现为「抓取 N 条但报告 0 条」。IPO 是滚动 7 天视图，应持续展示。
 */
test("gd-ipo 跨天判重豁免（BUG B 回归）", () => {
  const articles: ArticleInput[] = [
    makeIpo({
      title: "尚睿科技：IPO问询中（拟北交所）",
      excerpt: `注册地：广东｜保荐：广发证券股份有限公司｜更新：${endDateAgo(AGO_A)}`,
      url: "https://data.eastmoney.com/xg/xg/#A25256",
      publishedAt: daysAgo(AGO_A),
    }),
    makeIpo({
      title: "东莞市腾信精密制造：IPO注册生效（拟北交所）",
      excerpt: `注册地：广东｜保荐：国泰海通证券股份有限公司｜更新：${endDateAgo(AGO_B)}`,
      url: "https://data.eastmoney.com/xg/xg/#A25121",
      publishedAt: daysAgo(AGO_B),
    }),
  ];
  // 历史库已覆盖（上一轮同批企业已归档）→ 旧实现会在此被跨天判重剔除
  const histCtx: DailyContext = {
    ...ctx,
    history: Object.fromEntries(
      articles.map((a, i) => [
        `h${i}`,
        { title: a.title, url: a.url, sourceId: "em-declare" },
      ]),
    ),
  } as unknown as DailyContext;
  const { articles: out } = runFilterPipeline(articles, histCtx);
  assert.equal(out.length, 2, "历史库已覆盖时，gd-ipo 仍应全部保留（滚动 7 天视图）");
  for (const a of out) {
    assert.equal(a.category, "gd-ipo", "category 必须保持 gd-ipo");
  }
});
