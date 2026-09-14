/**
 * P0-3 / P0-4 回归测试（2026-09-14，详见 docs/gzinfo-fix-list-2026-09-14.md）。
 *
 * P0-3：采集分类（category=gd-ipo）不再直通决定 IPO 板块归属 / 「粤」标。
 *   - 英文创投 RSS 被误标 gd-ipo → 不得进 IPO 板块、不得打「粤」标；
 *   - registeredProvince="广东" 但标题无粤地名 → 仍须打「粤」标（防过度收紧）。
 * P0-4：categoryToSection 收敛为 lib/classify/section.ts 单一真源。
 *
 * 注意：buildGdIpo 侧-output 走「结构化信号（ipoStage / 广东注册地）+ 内容判定」，
 * 不再靠 category 直通；而 categoryToSection（无 AI 报告兜底映射）仍按 tech/ipo 独立栏目归栏，
 * 二者职责不同，勿混淆。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildGdIpo } from "../lib/pipeline/side-outputs/gd-ipo";
import { categoryToSection } from "../lib/classify/section";
import type { ArticleInput, DailyReport } from "../lib/types";
import type { DailyContext } from "../lib/pipeline/context";

const ctx = {
  date: "2026-09-14",
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as DailyContext;

const emptyReport = (): DailyReport =>
  ({
    date: "2026-09-14",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  }) as unknown as DailyReport;

const mk = (over: Partial<ArticleInput>): ArticleInput =>
  ({
    sourceId: "crunchbase-news",
    source: "Crunchbase News",
    title: "t",
    url: "https://news.crunchbase.com/x",
    excerpt: "",
    category: "gd-ipo",
    tier: "T2",
    publishedAt: new Date("2026-09-13T08:00:00+08:00"),
    ...over,
  }) as ArticleInput;

test("P0-3：sources.config.json 无启用 rss 源携带 gd-ipo/ipo 分类（Crunchbase 已改 finance）", () => {
  const raw = JSON.parse(readFileSync("sources.config.json", "utf8"));
  const sources: any[] = Array.isArray(raw) ? raw : raw.sources;
  const bad = sources.filter(
    (s) => s.enabled && ["ipo", "gd-ipo"].includes(s.category) && s.type === "rss",
  );
  assert.deepEqual(
    bad.map((b) => b.id),
    [],
    "不应有启用 rss 源被标为 ipo/gd-ipo（否则会误入广东IPO板块）",
  );
});

test("P0-3：英文创投 RSS（category=gd-ipo，无结构化/内容信号）不进 IPO 板块、不打「粤」标", () => {
  const arts: ArticleInput[] = [
    mk({
      sourceId: "crunchbase-news",
      title: "How This Doctor-Turned-Startup-Founder Decided To Fix The Broken Supply Chain",
      excerpt:
        "The startup raised a $40M Series B to optimize last-mile logistics across North America.",
      category: "gd-ipo",
      registeredProvince: undefined,
    }),
  ];
  const out = buildGdIpo(emptyReport(), arts, ctx);
  assert.equal(out.sections.ipo?.length, 0, "英文创投新闻不得窜入广东 IPO 板块");
});

test("P0-3：registeredProvince='广东' 但标题无粤地名 → 仍打「粤」标（防过度收紧，结构化信号兜底）", () => {
  const arts: ArticleInput[] = [
    mk({
      sourceId: "em-declare",
      source: "东财在审表",
      title: "Acme Tech：IPO注册生效（拟科创板）", // 标题无「广东/广州」等粤地名
      excerpt: "保荐：中信证券｜更新：2026-09-10", // 摘要也无粤地名
      category: "gd-ipo",
      registeredProvince: "广东",
    }),
  ];
  const out = buildGdIpo(emptyReport(), arts, ctx);
  assert.equal(out.sections.ipo?.length, 1, "应进 IPO 板块");
  assert.ok(out.sections.ipo![0].tags?.includes("粤"), "结构化 registeredProvince=广东 应兜底打「粤」标");
});

test("P0-3：结构化 ipoStage 也能驱动进 IPO 板块（全国参考递表条目）", () => {
  const arts: ArticleInput[] = [
    mk({
      sourceId: "hk-filing",
      source: "港交所",
      title: "Some Co. 递表（港股）",
      excerpt: "",
      category: "ipo",
      registeredProvince: undefined,
      ipoStage: "stage-reviewing",
    }),
  ];
  const out = buildGdIpo(emptyReport(), arts, ctx);
  assert.equal(out.sections.ipo?.length, 1, "带结构化 ipoStage 的全国递表条目应进 IPO 板块");
  assert.ok(!out.sections.ipo![0].tags?.includes("粤"), "非广东注册地不打「粤」标");
});

test("P0-4：categoryToSection 单一真源行为正确（tech/ipo 按栏目；广东IPO候选→ipo）", () => {
  assert.equal(categoryToSection("tech", "x", ""), "tech");
  assert.equal(categoryToSection("ipo", "x", ""), "ipo");
  assert.equal(categoryToSection("gd-ipo", "x", ""), "ipo");
  assert.equal(
    categoryToSection("finance", "证监会同意粤芯半导体IPO注册", "注册地：广东"),
    "ipo",
    "媒体源广东企业 IPO 进展 → ipo（isGdIpoCandidate 补位）",
  );
  assert.equal(
    categoryToSection("gz", "广州房贷利率下调", "广州出台新政"),
    "gz_local",
    "广州锚 → gz_local",
  );
  assert.equal(categoryToSection("finance", "央行宣布降准", "释放长期资金"), "policy_market");
  assert.equal(categoryToSection("misc", "某行业动态", ""), "biz_insight");
});
