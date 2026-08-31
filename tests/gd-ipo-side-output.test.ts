/**
 * 回归测试：广东 IPO 板块必须绕过相关性 LLM 直接构建（2026-08-30 实跑修复）。
 *
 * 背景：CI run 33315502473 日志 line 828-829 `[ai] 管线产出：必读 0 条 / 商机 0 条 /
 * 正文 0 条` —— 2 条 gd-ipo 穿过了全部 9 道过滤，却在 runAiPipeline 里被相关性 LLM
 * 整体丢弃（LLM 不把 ipo 当有效 section 输出），导致线上 sections['ipo'] 恒为 0、
 * 口播「广东IPO=无」。
 *
 * 修复方案（本测试锁住的行为）：
 *  1. buildGdIpo 作为第 4 个 side-output，直接从 filteredArticles 的 gd-ipo/ipo 条目
 *     构建 report.sections['ipo']，不经过任何 LLM；
 *  2. gd-ipo 条目统一打「粤」标，detectGdIpo / buildGdIpoSpoken 靠标签识别，
 *     不再只依赖 IPO_PROGRESS_RE 强词（「IPO已受理」不在强词表内，只靠正则会整批漏）；
 *  3. IPO_PROGRESS_RE 补 IPO受理 / IPO问询 两种在审高频状态。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGdIpo, buildGdIpoSpoken } from "../lib/pipeline/side-outputs/gd-ipo";
import { detectGdIpo } from "../lib/audio/audio";
import { isGdIpoCandidate } from "../lib/output/render/cards";
import type { ArticleInput, DailyReport } from "../lib/types";
import type { DailyContext } from "../lib/pipeline/context";

const ctx = {
  date: "2026-08-30",
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as DailyContext;

const emptyReport = (): DailyReport =>
  ({
    date: "2026-08-30",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  }) as unknown as DailyReport;

const makeIpo = (over: Partial<ArticleInput>): ArticleInput =>
  ({
    sourceId: "em-declare",
    source: "东财在审表",
    title: "t",
    url: "https://data.eastmoney.com/xg/xg/#X",
    excerpt: "",
    category: "gd-ipo",
    tier: "T1.5",
    publishedAt: new Date("2026-08-28T08:00:00+08:00"),
    ...over,
  }) as ArticleInput;

test("buildGdIpo：gd-ipo 条目绕过 LLM 直接进入 sections.ipo", () => {
  const arts: ArticleInput[] = [
    makeIpo({
      title: "尚睿科技：IPO已受理（拟北交所）",
      url: "https://data.eastmoney.com/xg/xg/#A25256",
      excerpt: "注册地：广东｜保荐：广发证券股份有限公司｜更新：2026-08-28",
    }),
    makeIpo({
      title: "东莞市腾信精密制造：IPO注册生效（拟北交所）",
      url: "https://data.eastmoney.com/xg/xg/#A25118",
      excerpt: "注册地：广东｜保荐：国泰海通证券股份有限公司｜更新：2026-08-27",
      publishedAt: new Date("2026-08-27T08:00:00+08:00"),
    }),
  ];
  const out = buildGdIpo(emptyReport(), arts, ctx);
  assert.equal(out.sections.ipo?.length, 2, "两条 gd-ipo 都应进入 IPO 板块");
  assert.ok(out.sections.ipo!.every((i) => i.tags?.includes("粤")), "gd-ipo 必须打「粤」标");
  assert.equal(out.sections.ipo![0].title_cn, "尚睿科技：IPO已受理（拟北交所）", "按更新日期倒序");
  assert.equal(out.sections.ipo![0].rank, 1);
  assert.equal(out.sections.ipo![0].source_type, "official", "T1.5 → 官方徽章");
});

test("buildGdIpo：与滚动并入的历史条目按 url 去重，不覆盖已有板块", () => {
  const base = emptyReport();
  base.sections.ipo = [
    {
      url: "https://data.eastmoney.com/xg/xg/#A25256",
      title_cn: "历史同款条目",
      source: "",
      source_type: "media",
      date: "08/20",
      summary: "旧",
      importance: 2,
      rank: 1,
      tags: [],
      locale: "national",
    },
  ];
  const arts = [
    makeIpo({
      title: "尚睿科技：IPO已受理（拟北交所）",
      url: "https://data.eastmoney.com/xg/xg/#A25256", // 与历史同 URL
      excerpt: "注册地：广东｜更新：2026-08-28",
    }),
    makeIpo({
      title: "粤芯半导体：IPO过会（拟科创板）",
      url: "https://data.eastmoney.com/xg/xg/#A26001",
      excerpt: "注册地：广东｜更新：2026-08-29",
    }),
  ];
  const out = buildGdIpo(base, arts, ctx);
  assert.equal(out.sections.ipo?.length, 2, "1 条历史 + 1 条新增（同 URL 的今日条目被去重）");
});

test("buildGdIpo：无 gd-ipo 命中时原样返回（保留滚动并入的 IPO）", () => {
  const base = emptyReport();
  base.sections.ipo = [
    {
      url: "u1",
      title_cn: "历史IPO",
      source: "",
      source_type: "media",
      date: "08/20",
      summary: "s",
      importance: 2,
      rank: 1,
      tags: [],
      locale: "national",
    },
  ];
  const out = buildGdIpo(base, [makeIpo({ category: "finance" })], ctx);
  assert.equal(out.sections.ipo?.length, 1);
  assert.equal(out.sections.ipo![0].title_cn, "历史IPO");
});

test("detectGdIpo / buildGdIpoSpoken：靠「粤」标识别，不被 IPO_PROGRESS_RE 强词漏掉", () => {
  // 「IPO已受理」原先不在 IPO_PROGRESS_RE 内 → 纯正则判定会漏
  const items = [
    {
      url: "u1",
      title_cn: "尚睿科技：IPO已受理（拟北交所）",
      source: "东财在审表",
      source_type: "official" as const,
      date: "08/28",
      summary: "注册地：广东｜更新：2026-08-28",
      importance: 2 as const,
      rank: 1,
      tags: ["粤"],
      locale: "national" as const,
    },
  ];
  assert.equal(detectGdIpo(items).length, 1, "带「粤」标应被识别为广东IPO线索");
  const spoken = buildGdIpoSpoken(items);
  assert.ok(spoken.length > 0, "应产出确定性口播稿");
  assert.ok(!spoken.includes("（"), "口播稿不含括号修饰");
  assert.equal(spoken, "尚睿科技，IPO已受理");
});

test("IPO_PROGRESS_RE：覆盖 IPO受理 / IPO问询 两种在审高频状态", () => {
  assert.ok(
    isGdIpoCandidate("尚睿科技：IPO已受理（拟北交所）", "注册地：广东"),
    "IPO已受理 + 广东 → 命中",
  );
  assert.ok(
    isGdIpoCandidate("腾信精密：IPO问询中（拟北交所）", "注册地：广东"),
    "IPO问询 + 广东 → 命中",
  );
  assert.ok(
    isGdIpoCandidate("粤芯半导体：IPO注册生效（拟科创板）", "注册地：广东"),
    "既有强词不被回退破坏",
  );
});

test("buildGdIpoSpoken：超过 2 家收尾「等N家」且总长不超过 50 字", () => {
  const items = ["A", "B", "C", "D"].map((n, i) => ({
    url: `u${i}`,
    title_cn: `${n}科技：IPO已受理（拟北交所）`,
    source: "",
    source_type: "official" as const,
    date: "08/28",
    summary: "注册地：广东",
    importance: 2 as const,
    rank: i + 1,
    tags: ["粤"],
    locale: "national" as const,
  }));
  const spoken = buildGdIpoSpoken(items);
  assert.equal(spoken, "A科技，IPO已受理；B科技，IPO已受理；等4家");
  assert.ok(spoken.length <= 50);
});
