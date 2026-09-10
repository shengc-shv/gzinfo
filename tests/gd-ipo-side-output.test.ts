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
import {
  buildGdIpo,
  buildGdIpoSpoken,
  topGdIpo,
  gdIpoStageOf,
  companyNameOf,
} from "../lib/pipeline/side-outputs/gd-ipo";
import { detectGdIpo } from "../lib/audio/audio";
import { isGdIpoCandidate } from "../lib/output/render/cards";
import { renderGdIpoStrip } from "../lib/output/render";
import type { ArticleInput, DailyReport, ReportItem } from "../lib/types";
import type { DailyContext } from "../lib/pipeline/context";

const ctx = {
  date: "2026-08-30",
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as DailyContext;

/**
 * 动态 MM/DD：口播/今日必读有「2 天窗」（IPO_VOICE_WINDOW_DAYS=2）、底部列表 7 天窗，
 * 故测试卡面日期必须相对今天生成（硬编码日期会随真实日期漂移而失败）。
 */
function mmdd(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY_MMDD = mmdd(0);
const YESTERDAY_MMDD = mmdd(-1);

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
      date: YESTERDAY_MMDD,
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
  // 2026-08-31 增强：口播须带出 注册地/行业/上市地/进展 属性
  assert.equal(
    spoken,
    "尚睿科技，注册地广东，科技行业，拟在北交所IPO，目前IPO已受理",
  );
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

test("buildGdIpoSpoken：带出属性 + 超过 3 家收尾「等N家」", () => {
  const items = ["A", "B", "C", "D"].map((n, i) => ({
    url: `u${i}`,
    title_cn: `${n}科技：IPO已受理（拟北交所）`,
    source: "",
    source_type: "official" as const,
    date: YESTERDAY_MMDD,
    summary: "注册地：广东",
    importance: 2 as const,
    rank: i + 1,
    tags: ["粤"],
    locale: "national" as const,
  }));
  const spoken = buildGdIpoSpoken(items);
  assert.ok(spoken.includes("注册地广东"), "应带出注册地");
  assert.ok(spoken.includes("拟在北交所IPO"), "应带出上市地（北交）");
  assert.ok(spoken.includes("科技行业"), "应带出行业（公司名推断）");
  assert.ok(spoken.endsWith("等4家"), "多于3家收尾「等N家」");
  // 3 家公司带属性口播约 102 字；audio.ts 的 AUDIO_SPEAK_LIMITS.ipo（150）统一截断，此处只验证不超长失控
  assert.ok(spoken.length <= 150);
});

// —— 任务六：广东 IPO 横滑卡（今日必读 / 股市播报）+ 商机价值优先排序 ——

/** 构造一条带「粤」标的广东 IPO ReportItem（标题自带阶段词，供 gdIpoStageOf 反推）。 */
const mkGdIpo = (name: string, title: string, date: string): ReportItem => ({
  url: `u-${name}`,
  title_cn: `${name}：${title}`,
  source: "东财在审表",
  source_type: "official",
  date,
  summary: "注册地：广东",
  importance: 2,
  rank: 0,
  tags: ["粤"],
  locale: "national",
});

test("gdIpoStageOf：按标题/摘要反推阶段 key", () => {
  assert.equal(gdIpoStageOf({ title_cn: "X：IPO注册生效（拟创业板）", summary: "" } as ReportItem), "stage-registered");
  assert.equal(gdIpoStageOf({ title_cn: "X：IPO已受理（拟北交所）", summary: "" } as ReportItem), "stage-reviewing");
  assert.equal(gdIpoStageOf({ title_cn: "X：IPO辅导备案", summary: "" } as ReportItem), "stage-tutoring");
  assert.equal(gdIpoStageOf({ title_cn: "X上市", summary: "" } as ReportItem), "stage-listed");
  assert.equal(gdIpoStageOf({ title_cn: "无关标题", summary: "" } as ReportItem), "");
});

test("topGdIpo：商机价值优先排序且最多 3 条（与口播/展示卡同序同量）", () => {
  const items = [
    mkGdIpo("粤芯", "IPO注册生效（拟科创板）", YESTERDAY_MMDD), // registered → #2
    mkGdIpo("友宝", "IPO辅导备案", YESTERDAY_MMDD), // tutoring → #1（最佳商机）
    mkGdIpo("尚睿", "IPO已受理（拟北交所）", YESTERDAY_MMDD), // reviewing
    mkGdIpo("飞驰", "IPO上市", YESTERDAY_MMDD), // listed → 被 3 条上限挤出
    mkGdIpo("广汽", "IPO问询中", TODAY_MMDD), // reviewing（日期更近，排在尚睿前）
  ];
  const top = topGdIpo(items, undefined, 3);
  assert.equal(top.length, 3, "最多 3 条");
  assert.equal(companyNameOf(top[0].title_cn || ""), "友宝", "辅导备案（最佳商机）排第一");
  assert.equal(companyNameOf(top[1].title_cn || ""), "粤芯", "注册生效排第二");
  assert.equal(companyNameOf(top[2].title_cn || ""), "广汽", "在审按日期倒序取更近的广汽");
});

test("topGdIpo 窗口：默认 2 天（口播）→ 3 天前被排除；显式 7 天（列表）→ 保留", () => {
  const items = [
    mkGdIpo("新企业", "IPO已受理（拟北交所）", TODAY_MMDD),
    mkGdIpo("三天前", "IPO辅导备案", mmdd(-3)),
  ];
  const voice = topGdIpo(items, undefined, 3);
  assert.deepEqual(voice.map((it) => companyNameOf(it.title_cn || "")), ["新企业"], "口播 2 天窗排除 3 天前");
  const list = topGdIpo(items, undefined, 3, 7);
  assert.deepEqual(
    list.map((it) => companyNameOf(it.title_cn || "")),
    ["三天前", "新企业"],
    "列表 7 天窗保留 3 天前（辅导备案商机价值更高）",
  );
});

test("renderGdIpoStrip：产出横滑卡 + 商机线索文案 + 企业名（must 上下文）", () => {
  const items = [
    mkGdIpo("友宝", "IPO辅导备案", YESTERDAY_MMDD),
    mkGdIpo("粤芯", "IPO注册生效（拟科创板）", YESTERDAY_MMDD),
    mkGdIpo("尚睿", "IPO已受理（拟北交所）", YESTERDAY_MMDD),
  ];
  const html = renderGdIpoStrip(items, { section: "must" });
  assert.ok(html.includes("ipo-scroller"), "应有横滑容器");
  assert.ok(html.includes("ipo-card"), "应有卡片");
  assert.ok(html.includes("友宝") && html.includes("粤芯"), "应含企业名");
  assert.ok(html.includes("辅导备案"), "应含阶段徽标");
  assert.ok(html.includes("最佳商机"), "应含商机线索文案（GD_IPO_STAGE_BIZ）");
  assert.ok(html.includes("exec-ipo--must"), "must 上下文标记");
});

test("renderGdIpoStrip：无广东 IPO（无「粤」标）→ 空串，不渲染", () => {
  const items: ReportItem[] = [
    {
      url: "u",
      title_cn: "某外省公司IPO上市",
      source: "",
      source_type: "media",
      date: "08/01",
      summary: "注册地：江苏",
      importance: 2,
      rank: 0,
      tags: [],
      locale: "national",
    },
  ];
  assert.equal(renderGdIpoStrip(items, { section: "must" }), "", "无粤标 → 不渲染");
});
