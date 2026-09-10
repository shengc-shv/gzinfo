/**
 * IPO 呈现层与阶段口径（2026-09-10 回检 P0-1 / P2-1 落地验证）。
 *
 * 覆盖：
 *  1. inferStage 收敛（提交注册 → 注册发行；注册生效 → 注册发行，不再误判已上市）；
 *  2. gdIpoStageOf 单一判定入口（结构化字段优先 / 回退关键词 / 无信号返回空）；
 *  3. **同卡口径一致**（P0-1 核心断言）：分栏归属与徽章文案读同一字段，不再自相矛盾；
 *  4. 四阶段分栏（renderIpoPanelHtml）与空阶段隐藏；
 *  5. 阶段筛选条（renderIpoFilterBar）复用同级「官方/媒体」过滤机制；
 *  6. 卡片层：data-stage / 相对时距 / 交易所官方源双链接 / ipoMeta 不被截断；
 *  7. 同企业阶段进展条（renderIpoProgress，P2-6：多阶段素材渲染为推进过程）；
 *  8. 口播素材池广东预过滤（buildIpoPool，P1-1）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inferStage } from "../lib/classify/gdIpo";
import { gdIpoStageOf, gdIpoCandidates, buildGdIpo } from "../lib/pipeline/side-outputs/gd-ipo";
import { buildTwoDayExecPool } from "../lib/ai/exec-pool";
import type { DailyContext } from "../lib/pipeline/context";
import type { ArticleInput, DailyReport } from "../lib/types";
import {
  renderIpoFilterBar,
  renderIpoPanelHtml,
  renderIpoProgress,
  renderReportItemHtml,
  relativeDayLabel,
  IPO_STAGE_ORDER,
} from "../lib/output/render";
import type { ReportItem } from "../lib/types";

/** 今天的 MM/DD（候选有 2/7 天窗，硬编码会随真实日期漂移）。 */
function mmdd(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function ipo(over: Partial<ReportItem> & { title_cn: string }): ReportItem {
  return {
    url: `https://example.com/${encodeURIComponent(over.title_cn)}`,
    source: "上交所",
    source_type: "official",
    tier: "T1",
    date: mmdd(0),
    summary: "注册地：广东｜状态：IPO注册生效｜更新：2026-09-07",
    importance: 2,
    rank: 1,
    tags: ["粤"],
    locale: "national",
    ...over,
  } as ReportItem;
}

// —— 1. inferStage 收敛 ——

test("inferStage：提交注册归「注册发行」而非「在审」（与官方源状态字典统一）", () => {
  assert.equal(inferStage("某某：IPO提交注册（拟创业板）"), "stage-registered");
});

test("inferStage：注册生效归「注册发行」（待发行，非已上市）", () => {
  assert.equal(inferStage("钶锐锶：IPO注册生效（拟科创板）"), "stage-registered");
  assert.equal(inferStage("某某：IPO过会（拟主板）"), "stage-registered");
});

test("inferStage：上市委会议通过 = 过会 → 注册发行；上市委审议（未过）→ 在审", () => {
  assert.equal(inferStage("某某：上市委会议通过（拟主板）"), "stage-registered");
  assert.equal(inferStage("某某：上市委审议中（拟主板）"), "stage-reviewing");
});

// —— 2. gdIpoStageOf 单一入口 ——

test("gdIpoStageOf：官方结构化字段优先于标题关键词", () => {
  // 标题像「已上市」，但官方给的结构化阶段是注册发行 → 采用结构化字段
  const it = ipo({ title_cn: "某某：IPO注册生效并上市（拟科创板）", ipoStage: "stage-registered" });
  assert.equal(gdIpoStageOf(it), "stage-registered");
});

test("gdIpoStageOf：无结构化字段 → 回退 inferStage（同一张词表）", () => {
  assert.equal(gdIpoStageOf(ipo({ title_cn: "某某：IPO已受理（拟科创板）", summary: "" })), "stage-reviewing");
  assert.equal(gdIpoStageOf(ipo({ title_cn: "某某：辅导备案（广东省）", summary: "" })), "stage-tutoring");
});

test("gdIpoStageOf：无任何阶段信号 → 空（不落回 stage-tutoring，避免顶到横滑前排）", () => {
  const it = ipo({ title_cn: "某某科技有限公司公告", summary: "公司发布人事调整公告" });
  assert.equal(gdIpoStageOf(it), "");
});

// —— 3. P0-1 核心：分栏与徽章口径一致 ——

test("P0-1：同一张卡「分栏归属」与「阶段文案」读同一判定，不再自相矛盾", () => {
  // 钶锐锶实锤：官方「注册生效（拟科创板）」曾被判 stage-listed 进「已上市」，
  // 徽章却写「注册生效·过会」→ 同卡打架。现在两者都来自 gdIpoStageOf。
  const it = ipo({ title_cn: "钶锐锶：IPO注册生效（拟科创板）", ipoStage: "stage-registered" });
  const stage = gdIpoStageOf(it);
  const html = renderIpoPanelHtml([it]);
  assert.equal(stage, "stage-registered");
  assert.match(html, /data-stage="stage-registered"/, "卡片应归入 stage-registered 分组");
  assert.match(html, /注册发行/, "组头文案应为「注册发行」");
  assert.doesNotMatch(html, /已上市/, "不得出现「已上市」栏（分栏与阶段判定一致）");
});

// —— 4. 四阶段分栏 ——

test("renderIpoPanelHtml：按商机价值顺序分栏，空阶段整组不渲染", () => {
  const items = [
    ipo({ title_cn: "A：辅导备案", ipoStage: "stage-tutoring" }),
    ipo({ title_cn: "B：IPO已受理", ipoStage: "stage-reviewing" }),
    ipo({ title_cn: "C：IPO注册生效", ipoStage: "stage-registered" }),
  ];
  const html = renderIpoPanelHtml(items);
  const order = [...html.matchAll(/ipo-group" data-stage="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["stage-tutoring", "stage-registered", "stage-reviewing"]);
  assert.doesNotMatch(html, /data-stage="stage-listed"/, "无数据的阶段不应出现");
  assert.equal(IPO_STAGE_ORDER.length, 4);
});

test("renderIpoPanelHtml：无阶段信号条目进「阶段待定」组，且排在最后", () => {
  const items = [
    ipo({ title_cn: "A：IPO已受理", ipoStage: "stage-reviewing" }),
    ipo({ title_cn: "某公司发布公告", summary: "无阶段信息", ipoStage: undefined }),
  ];
  const html = renderIpoPanelHtml(items);
  assert.match(html, /阶段待定/);
  assert.ok(html.indexOf("在审") < html.indexOf("阶段待定"), "「阶段待定」应排在四阶段之后");
});

test("renderIpoPanelHtml：组头带家数", () => {
  const items = [
    ipo({ title_cn: "A：IPO已受理", ipoStage: "stage-reviewing" }),
    ipo({ title_cn: "B：IPO问询中", ipoStage: "stage-reviewing" }),
  ];
  const html = renderIpoPanelHtml(items);
  assert.match(html, /<span class="ipo-group-n">2<\/span>/);
});

// —— 5. 阶段筛选条（复用同级「官方/媒体」机制） ——

test("renderIpoFilterBar：来源维度固定 + 阶段维度只渲染有数据的阶段", () => {
  const items = [
    ipo({ title_cn: "A：IPO已受理", ipoStage: "stage-reviewing" }),
    ipo({ title_cn: "B：辅导备案", ipoStage: "stage-tutoring" }),
  ];
  const html = renderIpoFilterBar(items);
  // 与业务板块同款组件与 data-* 契约
  assert.match(html, /class="filter-bar"/);
  assert.match(html, /data-group="src" data-filter="official"/);
  assert.match(html, /data-group="src" data-filter="media"/);
  assert.match(html, /data-group="stage" data-filter="stage-reviewing"/);
  assert.match(html, /data-group="stage" data-filter="stage-tutoring"/);
  assert.doesNotMatch(html, /data-filter="stage-listed"/, "无数据的阶段不出 chip");
  assert.match(html, /filter-reset/, "应带重置按钮");
});

test("renderIpoFilterBar：存在无阶段条目时才出现「阶段待定」chip（__none__）", () => {
  const withNone = renderIpoFilterBar([
    ipo({ title_cn: "A：IPO已受理", ipoStage: "stage-reviewing" }),
    ipo({ title_cn: "无阶段条目", summary: "无", ipoStage: undefined }),
  ]);
  assert.match(withNone, /data-filter="__none__"/);
  const without = renderIpoFilterBar([ipo({ title_cn: "A：IPO已受理", ipoStage: "stage-reviewing" })]);
  assert.doesNotMatch(without, /__none__/);
});

// —— 6. 卡片层 ——

test("relativeDayLabel：今天 / 昨天 / N 天前；超 30 天或无日期返回空", () => {
  const today = "2026-09-10";
  assert.equal(relativeDayLabel("09/10", today), "今天");
  assert.equal(relativeDayLabel("09/09", today), "昨天");
  assert.equal(relativeDayLabel("09/03", today), "7 天前");
  assert.equal(relativeDayLabel("07/01", today), "");
  assert.equal(relativeDayLabel("", today), "");
  assert.equal(relativeDayLabel("garbage", today), "");
});

test("renderReportItemHtml：IPO 卡带 data-stage、相对时距，且用 ipoMeta 而非 50 字截断", () => {
  const it = ipo({
    title_cn: "钶锐锶：IPO注册生效（拟科创板）",
    ipoStage: "stage-registered",
    date: mmdd(-3),
    ipoMeta: "保荐 国泰海通证券股份有限公司 ｜ 拟上市科创板 ｜ 受理 2025-06-27",
    summary: "注册地：广东深圳｜保荐：国泰海通证券股份有限公司｜受理：2025-06-27｜状态：IPO注册生效（拟科创板）｜更新：2026-09-07",
    officialUrl: "https://www.sse.com.cn/listing/renewal/ipo/",
    officialLabel: "上交所 · 审核项目动态",
  });
  const html = renderReportItemHtml(it, true, gdIpoStageOf(it));
  assert.match(html, /data-stage="stage-registered"/);
  assert.match(html, /3 天前/, "应带相对时距");
  assert.match(html, /受理 2025-06-27/, "应展示结构化 ipoMeta（保留受理日，不被 50 字截断吞掉）");
  assert.match(html, /交易所官方源|官方源：/, "应带官方源双链接");
  assert.match(html, /https:\/\/www\.sse\.com\.cn\/listing\/renewal\/ipo\//);
});

test("renderReportItemHtml：非 IPO 卡保持原样（无 data-stage、无官方源行）", () => {
  const it = ipo({ title_cn: "普通资讯", summary: "一句话摘要", ipoStage: undefined, officialUrl: undefined });
  const html = renderReportItemHtml(it, true);
  assert.match(html, /data-stage=""/);
  assert.doesNotMatch(html, /official-src/);
});

// —— 7. 企业级去重（P1-4） ——

test("gdIpoCandidates：uniqueCompany 时同企业只留商机价值最高的一条", () => {
  const items = [
    ipo({ title_cn: "某某科技：IPO已受理（拟创业板）", summary: "", ipoStage: "stage-reviewing", date: mmdd(0) }),
    ipo({ title_cn: "某某科技：IPO注册生效（拟创业板）", summary: "", ipoStage: "stage-registered", date: mmdd(-1) }),
  ];
  const all = gdIpoCandidates(items, undefined, 7, { uniqueCompany: false });
  assert.equal(all.length, 2, "完整列表保留同企业多阶段（进展视角）");
  const uniq = gdIpoCandidates(items, undefined, 7, { uniqueCompany: true });
  assert.equal(uniq.length, 1, "横滑/口播位去重后只剩 1 张");
  assert.match(uniq[0].title_cn, /注册生效/, "保留商机价值更高（注册发行 > 在审）的一条");
});

// —— 8. 入池口径：媒体补位（P1-3） ——

const ctx = { date: "2026-09-10", log: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as DailyContext;

function emptyReport(): DailyReport {
  return {
    date: "2026-09-10",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;
}

function article(over: Partial<ArticleInput> & { title: string }): ArticleInput {
  return {
    sourceId: "stcn",
    source: "证券时报",
    url: `https://example.com/${encodeURIComponent(over.title)}`,
    excerpt: "",
    category: "finance",
    tier: "T2",
    publishedAt: new Date(),
    ...over,
  } as ArticleInput;
}

test("buildGdIpo 媒体补位：媒体源报道的广东 IPO 事件（category=finance）也能入池", () => {
  const out = buildGdIpo(
    emptyReport(),
    [
      article({
        title: "粤芯半导体IPO注册获批",
        excerpt: "证监会同意广州粤芯半导体技术有限公司科创板IPO注册",
      }),
    ],
    ctx,
  );
  assert.equal(out.sections.ipo?.length, 1, "内容判定命中的媒体稿应补位进 IPO 板块");
  assert.deepEqual(out.sections.ipo![0].tags, ["粤"]);
});

test("buildGdIpo：已上市公司资本运作公告即便含广东地名也不入池", () => {
  const out = buildGdIpo(
    emptyReport(),
    [
      article({
        title: "广州某上市公司发布定增预案",
        excerpt: "该公司拟非公开发行股票募集资金，注册地广州",
      }),
    ],
    ctx,
  );
  assert.equal(out.sections.ipo?.length ?? 0, 0, "定增类公告不得进 IPO 板块");
});

// —— 9. 口播素材池：广东预过滤（P1-1，防外省企业进「广东IPO」口播） ——

test("buildIpoPool（经 buildTwoDayExecPool）：港交所全国递表（外省）不进广东 IPO 池", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const report = emptyReport();
  report.sections.ipo = [
    { ...ipo({ title_cn: "尚睿科技：IPO问询中（拟北交所）", tags: ["粤"] }), url: "gd-1" },
    { ...ipo({ title_cn: "杭州某科技：主板递表", tags: [], summary: "市场：主板｜递表日：2026-09-08" }), url: "cn-1" },
  ];
  const res = buildTwoDayExecPool({
    history: {},
    articles: [],
    report,
    today: new Date().toISOString().slice(0, 10),
  });
  const urls = res.ipo.map((i) => i.url);
  assert.ok(urls.includes("gd-1"), "广东条目应进池");
  assert.ok(!urls.includes("cn-1"), "外省条目不得进「广东IPO」口播素材池");
});

// —— 10. 同企业阶段进展条（P2-6：把 uniqueCompany:false 保留的多阶段素材渲染为推进过程） ——

test("renderIpoProgress：同企业多阶段 → 按日期升序连成进展条，且仅最新一条卡渲染", () => {
  const items = [
    ipo({ title_cn: "某某科技：IPO问询中（拟创业板）", date: mmdd(-5), ipoStage: "stage-reviewing" }),
    ipo({ title_cn: "某某科技：IPO注册生效（拟创业板）", date: mmdd(-1), ipoStage: "stage-registered" }),
    ipo({ title_cn: "另一家：IPO已受理（拟创业板）", date: mmdd(-2), ipoStage: "stage-reviewing" }),
  ];
  const early = renderIpoProgress(items[0], items);
  const latest = renderIpoProgress(items[1], items);
  const single = renderIpoProgress(items[2], items);
  assert.equal(early, "", "非最新一条不渲染（避免同一链条在每张卡上重复）");
  assert.equal(single, "", "单阶段企业不渲染进展条");
  assert.ok(latest.includes("ipo-progress"), "最新一条应渲染进展条");
  assert.ok(latest.indexOf("在审") < latest.indexOf("注册发行"), "链条按日期升序：在审 → 注册发行");
});

test("renderIpoProgress：同阶段多次更新合并为一步（保留最新日期）", () => {
  const items = [
    ipo({ title_cn: "某某科技：IPO已受理（拟创业板）", date: mmdd(-6), ipoStage: "stage-reviewing" }),
    ipo({ title_cn: "某某科技：IPO问询中（拟创业板）", date: mmdd(-4), ipoStage: "stage-reviewing" }),
    ipo({ title_cn: "某某科技：IPO注册生效（拟创业板）", date: mmdd(-1), ipoStage: "stage-registered" }),
  ];
  const html = renderIpoProgress(items[2], items);
  const steps = html.match(/ipo-progress-step(?![-])/g) ?? [];
  assert.equal(steps.length, 2, "在审两次更新合并为一步 → 共 2 步（在审 → 注册发行）");
  assert.ok(html.includes("ipo-progress-step--cur"), "最后一步标记为当前阶段");
});

test("renderIpoPanelHtml：进展条随卡片一并渲染（数据-stage 仍在，筛选不受影响）", () => {
  const items = [
    ipo({ title_cn: "某某科技：IPO问询中（拟创业板）", date: mmdd(-5), ipoStage: "stage-reviewing" }),
    ipo({ title_cn: "某某科技：IPO注册生效（拟创业板）", date: mmdd(-1), ipoStage: "stage-registered" }),
  ];
  const html = renderIpoPanelHtml(items);
  assert.ok(html.includes("ipo-progress"), "面板应含进展条");
  assert.ok(html.includes('data-stage="stage-registered"'), "卡片仍带 data-stage（阶段筛选依赖）");
});
