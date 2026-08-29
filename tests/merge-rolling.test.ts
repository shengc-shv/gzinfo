/**
 * mergeRollingIntoReport（近 7 天历史并入渲染）功能测试。
 * 验证（2026-08-21 用户诉求）：
 *  - 历史符合要求条目（AI 相关、有摘要/可摘录）并入对应板块
 *  - 与今日成稿 URL 去重（今日优先）
 *  - ai_relevant===false 的历史条目不并入；ai_relevant===null（未打标）的历史条目需过分行相关性门槛（tier!=="drop"）才并入（2026-08-29 方案③ 放宽）
 *  - 有摘要用摘要、无则摘录 excerpt 前 90 字
 *  - source_type 按 tier 推断（T1/T1.5 → official）
 *  - subcategory 映射为中文部门 tag（财富/信贷/私行/客群，无 gz-* 原始字段）
 *  - 历史条目按发布时间倒序追加在今日条目之后
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeRollingIntoReport } from "../lib/output/render";
import type { ArticleInput, DailyReport, ReportItem } from "../lib/types";
import type { SourceTier } from "../lib/sources/tiers";

const emptyReport: DailyReport = {
  date: "2026-08-21",
  hero_line: "今日定调：中行算力贷在穗抢跑落地。",
  must_read: [],
  insights: [],
  sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
};

function mkArticle(partial: Partial<Omit<ArticleInput, "url">> & { url: string }): ArticleInput {
  const { url, ...rest } = partial;
  return {
    sourceId: "test-src",
    title: url,
    url,
    category: "finance",
    source: "测试源",
    excerpt: "原文摘录内容，用于无摘要时兜底。",
    publishedAt: new Date("2026-08-21T02:00:00+08:00"),
    relevant: true, // 默认 AI 判相关；测试 false/None 时显式覆盖
    ...rest,
  };
}

const tierMap = new Map<string, SourceTier | undefined>([
  ["gov-src", "T1"],
  ["media-src", "T2"],
]);

test("历史相关条目并入对应板块（category→section）", () => {
  const report = {
    ...emptyReport,
    sections: { ...emptyReport.sections, biz_insight: [] as ReportItem[] },
  };
  const rolling: ArticleInput[] = [
    mkArticle({ url: "https://h/1", title: "广州公积金新政解读", category: "gz", summary: "历史摘要：公积金新政影响住房金融。", sourceId: "gov-src" }),
    mkArticle({ url: "https://h/2", title: "央行降准", category: "finance", summary: "历史摘要：央行降准0.5%。", sourceId: "gov-src" }),
    mkArticle({ url: "https://h/3", title: "AI芯片突破", category: "tech", excerpt: "科技前沿摘录内容。", sourceId: "media-src" }),
    mkArticle({ url: "https://h/4", title: "某司IPO过会", category: "ipo", summary: "历史摘要：某司深交所过会。", sourceId: "gov-src" }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  assert.equal(report.sections.gz_local.length, 1);
  assert.equal(report.sections.policy_market.length, 1);
  assert.equal(report.sections.tech.length, 1);
  assert.equal(report.sections.ipo.length, 1);
  assert.equal(report.sections.gz_local[0].summary, "历史摘要：公积金新政影响住房金融。");
});

test("与今日成稿 URL 去重（今日优先）", () => {
  const report = {
    ...emptyReport,
    sections: {
      ...emptyReport.sections,
      policy_market: [
        {
          url: "https://h/2",
          title_cn: "央行降准（今日成稿）",
          source: "央行",
          source_type: "official" as const,
          date: "08/21",
          summary: "今日摘要",
          importance: 3 as const,
          rank: 1,
          tags: [],
          locale: "national" as const,
        },
      ],
    },
  };
  const rolling: ArticleInput[] = [
    mkArticle({ url: "https://h/2", title: "央行降准", category: "finance", summary: "历史摘要", sourceId: "gov-src" }),
    mkArticle({ url: "https://h/9", title: "LPR下调", category: "finance", summary: "历史摘要：LPR下调。", sourceId: "gov-src" }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  assert.equal(report.sections.policy_market.length, 2);
  assert.equal(report.sections.policy_market[0].title_cn, "央行降准（今日成稿）"); // 今日在前
  assert.equal(report.sections.policy_market[1].title_cn, "LPR下调"); // 历史追加在后
  assert.equal(report.sections.policy_market[0].rank, 1);
  assert.equal(report.sections.policy_market[1].rank, 2);
});

test("并入门槛三态（2026-08-29 方案③）：false 硬排除 / true 无条件并 / 未打标需过分行相关性门槛", () => {
  const report = { ...emptyReport, sections: { ...emptyReport.sections, policy_market: [] as ReportItem[], biz_insight: [] as ReportItem[] } };
  const rolling: ArticleInput[] = [
    // 1) ai_relevant===false → 硬排除（与放宽前一致，始终是硬门槛）
    mkArticle({ url: "https://h/x", title: "某娱乐新闻", category: "finance", summary: "无关内容", sourceId: "media-src", relevant: false }),
    // 2) ai_relevant===true → 无条件并入；自身评分再低（本例 drop 21）也不再过评分器。
    //    板块按内容判定：无广州锚/政策词 → 业务启示（2026-08-29 无状态源红线）
    mkArticle({ url: "https://h/y", title: "同业动态观察", category: "finance", summary: "相关摘要", sourceId: "media-src", relevant: true }),
    // 3) 未打标 + 业务相关（消费贷贴息，评分 must_read 74 / 业务线[信贷]）→ 并入
    mkArticle({
      url: "https://h/z",
      title: "六大行“升级”两类贷款贴息安排",
      category: "finance",
      summary: "提额扩面，消费贷与经营贷贴息",
      sourceId: "media-src",
      relevant: undefined as unknown as boolean,
    }),
    // 4) 未打标 + 噪声（个股财报，评分 drop 21）→ 挡住，守 08-21「宁缺毋滥」
    mkArticle({
      url: "https://h/w",
      title: "九毛九上半年营收下降13.2%",
      category: "finance",
      summary: "主品牌主动闭店阶段基本结束",
      sourceId: "media-src",
      relevant: undefined as unknown as boolean,
    }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  const urls = report.sections.policy_market.map((i) => i.url).sort();
  assert.deepEqual(urls, ["https://h/z"], "true 无条件并入 + 未打标相关并入；false 与未打标噪声均排除");
  // 无状态源红线：板块按内容判定——「同业动态观察」无政策/市场词 → 业务启示（不再 category 驱动）
  const bizUrls = report.sections.biz_insight.map((i) => i.url);
  assert.ok(bizUrls.includes("https://h/y"), "无政策/市场内容词的条目 → 业务启示（内容判定）");
});

test("退化卡片守卫（2026-08-29）：有效摘要与标题完全相同则跳过", () => {
  // 注意：category=finance 映射到 policy_market（不是 biz_insight）
  const report = { ...emptyReport, sections: { ...emptyReport.sections, policy_market: [] as ReportItem[] } };
  const rolling: ArticleInput[] = [
    // excerpt 被 fallback 回退成 title（见 lib/ingest/merge.ts）→ 摘要=标题，零信息增量 → 跳过
    mkArticle({
      url: "https://h/deg1",
      title: "银行业禁业惩戒的闭环正在形成",
      category: "finance",
      excerpt: "银行业禁业惩戒的闭环正在形成",
      sourceId: "media-src",
    }),
    // 有真实摘要（与标题不同）→ 正常并入
    mkArticle({
      url: "https://h/ok1",
      title: "六大行“升级”两类贷款贴息安排",
      category: "finance",
      summary: "提额扩面，消费贷与经营贷贴息，分行应跟进",
      sourceId: "media-src",
    }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  const urls = report.sections.policy_market.map((i) => i.url);
  assert.ok(!urls.includes("https://h/deg1"), "摘要=标题的退化卡片应跳过");
  assert.ok(urls.includes("https://h/ok1"), "有真实摘要的条目应正常并入");
});

test("退化卡片守卫：摘要为「【标签】+标题」复读也要跳过（标签前缀不可绕过守卫）", () => {
  const report = { ...emptyReport, sections: { ...emptyReport.sections, policy_market: [] as ReportItem[] } };
  // 历史库实况：未打标条目 summary 为空、excerpt 是「【财富管理】+原标题」占位，
  // 渲染时 summary 回退用 excerpt → 若不剥离标签前缀比较，这类复读卡片会绕过守卫。
  const title = "深夜，利空突袭，黄金直线跳水！美联储主席沃什释放鹰派信号";
  const rolling: ArticleInput[] = [
    mkArticle({
      url: "https://h/tag1",
      title,
      category: "finance",
      summary: "",
      excerpt: `【财富管理】${title}`,
      sourceId: "media-src",
    }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  const urls = report.sections.policy_market.map((i) => i.url);
  assert.ok(
    !urls.includes("https://h/tag1"),
    "「【标签】+标题」的复读摘要应被守卫拦下（剥离前缀后与标题相同）",
  );
});

test("无摘要时摘录 excerpt 前 90 字；无摘要且无正文则跳过", () => {
  const report = { ...emptyReport, sections: { ...emptyReport.sections, tech: [] as ReportItem[] } };
  const rolling: ArticleInput[] = [
    mkArticle({ url: "https://h/t1", title: "技术前沿A", category: "tech", excerpt: "很长的一段技术摘录内容，".repeat(20), sourceId: "media-src" }),
    mkArticle({ url: "https://h/t2", title: "技术前沿B", category: "tech", excerpt: "", summary: "", sourceId: "media-src" }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  const t1 = report.sections.tech.find((i) => i.url === "https://h/t1");
  assert.ok(t1, "t1 应并入");
  assert.equal(t1.summary.length, 90);
  assert.equal(t1.summary, "很长的一段技术摘录内容，".repeat(20).slice(0, 90));
});

test("source_type 按 tier 推断（T1→official / T2→media）", () => {
  const report = { ...emptyReport, sections: { ...emptyReport.sections, policy_market: [] as ReportItem[] } };
  const rolling: ArticleInput[] = [
    mkArticle({ url: "https://h/o", title: "央行发布房贷新政", category: "finance", summary: "官方摘要", sourceId: "gov-src" }),
    mkArticle({ url: "https://h/m", title: "媒体报道房贷新政", category: "finance", summary: "媒体摘要", sourceId: "media-src" }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  const official = report.sections.policy_market.find((i) => i.url === "https://h/o");
  const media = report.sections.policy_market.find((i) => i.url === "https://h/m");
  assert.ok(official, "official 应并入");
  assert.ok(media, "media 应并入");
  assert.equal(official.source_type, "official");
  assert.equal(media.source_type, "media");
});

test("业务线 tag 由标题内容判定（2026-08-29 无状态源红线：不再由 subcategory 定义）", () => {
  const report = { ...emptyReport, sections: { ...emptyReport.sections, gz_local: [] as ReportItem[] } };
  const rolling: ArticleInput[] = [
    mkArticle({
      url: "https://h/w",
      title: "广州财富管理新规出台",
      category: "gz",
      subcategory: "gz-wealth",
      subcategories: ["gz-wealth", "gz-private"],
      summary: "财富摘要",
      sourceId: "media-src",
    }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  const item = report.sections.gz_local[0];
  assert.ok(item, "gz 条目应并入");
  // 标题含「财富」→ 财富标签（内容判定）；subcategory gz-private 不再贡献「私行」
  assert.deepEqual(item.tags, ["财富"]);
  assert.ok(!JSON.stringify(item).includes("gz-wealth"), "不应外露 gz-* 原始字段");
});

test("历史条目按发布时间倒序追加", () => {
  const report = {
    ...emptyReport,
    sections: {
      ...emptyReport.sections,
      policy_market: [
        {
          url: "https://today/1",
          title_cn: "今日条目",
          source: "央行",
          source_type: "official" as const,
          date: "08/21",
          summary: "今日摘要",
          importance: 3 as const,
          rank: 1,
          tags: [],
          locale: "national" as const,
        },
      ],
    },
  };
  const rolling: ArticleInput[] = [
    mkArticle({ url: "https://h/old", title: "较早政策", category: "finance", summary: "较早摘要", sourceId: "gov-src", publishedAt: new Date("2026-08-19T02:00:00+08:00") }),
    mkArticle({ url: "https://h/new", title: "较新政策", category: "finance", summary: "较新摘要", sourceId: "gov-src", publishedAt: new Date("2026-08-20T02:00:00+08:00") }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  const titles = report.sections.policy_market.map((i) => i.title_cn);
  assert.deepEqual(titles, ["今日条目", "较新政策", "较早政策"]);
});

test("category=gz 严格过滤：标题含广州锚→gz_local；外地地名→policy_market；其余→业务启示", () => {
  const report = { ...emptyReport, sections: { ...emptyReport.sections, gz_local: [] as ReportItem[], biz_insight: [] as ReportItem[], policy_market: [] as ReportItem[] } };
  const rolling: ArticleInput[] = [
    // 真广州（标题含海珠 + 金融业务语义，2026-08-29 起要求业务相关性门槛）→ gz_local
    mkArticle({ url: "https://h/gz1", title: "广州海珠区发布金融业词元八条", category: "gz", summary: "海珠区金融政策", sourceId: "gov-src" }),
    // 外地地名（上海）→ policy_market（全国政策），即使摘要提「广州」也不进 gz_local
    mkArticle({ url: "https://h/sh", title: "上海优化个人住房信贷政策", category: "gz", summary: "上海政策，分行应跟踪广州房贷", sourceId: "media-src" }),
    // 无锚（黄金理财）→ 业务启示
    mkArticle({ url: "https://h/gold", title: "多只固收+黄金理财产品净值修复", category: "gz", summary: "黄金理财全国新闻", sourceId: "media-src" }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  assert.equal(report.sections.gz_local.length, 1);
  assert.equal(report.sections.gz_local[0].url, "https://h/gz1");
  assert.equal(report.sections.policy_market.length, 1);
  assert.equal(report.sections.policy_market[0].url, "https://h/sh");
  assert.equal(report.sections.biz_insight.length, 1);
  assert.equal(report.sections.biz_insight[0].url, "https://h/gold");
});

test("finance 类但标题含广州锚（如广州市政府批复）→ gz_local", () => {
  const report = { ...emptyReport, sections: { ...emptyReport.sections, gz_local: [] as ReportItem[], policy_market: [] as ReportItem[] } };
  const rolling: ArticleInput[] = [
    mkArticle({ url: "https://h/gz2", title: "广州市人民政府关于海珠区城市更新项目资金的批复", category: "finance", summary: "市政府批复", sourceId: "gov-src" }),
    mkArticle({ url: "https://h/pol", title: "央行宣布降准", category: "finance", summary: "全国政策", sourceId: "gov-src" }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  assert.equal(report.sections.gz_local.length, 1);
  assert.equal(report.sections.gz_local[0].url, "https://h/gz2");
  assert.equal(report.sections.policy_market.length, 1);
  assert.equal(report.sections.policy_market[0].url, "https://h/pol");
});

test("已上市公司资本运作公告（审核问询/定增）不进 IPO 板块（2026-08-23 分流）", () => {
  const report = { ...emptyReport, sections: { ...emptyReport.sections, ipo: [] as ReportItem[] } };
  const rolling: ArticleInput[] = [
    // 诺思兰德式：北交所已上市公司定增审核问询函 → 资本运作，不进 IPO 动态
    mkArticle({
      url: "https://www.bse.cn/disclosure/2026/2026-08-21/63bf157c9fef4af5b5a28f2b7be812cf.pdf",
      title: "诺思兰德 (920047)",
      category: "ipo",
      sourceId: "bse",
      excerpt: "北交所公告 | [临时公告]诺思兰德:关于收到北京证券交易所《关于北京诺思兰德生物技术股份有限公司向特定对象发行股票申请文件的审核问询函》的公告",
      summary: "北交所广东企业诺思兰德相关公告，广东企业资本市场活动参考。", // 模板错误摘要（R3 兜底应降级）
    }),
    // 真 IPO 流程（受理/过会）→ 仍进 IPO 板块
    mkArticle({
      url: "https://h/ipo1",
      title: "长江存储科创板IPO获受理，拟募资330亿",
      category: "ipo",
      sourceId: "bse",
      excerpt: "上交所受理长江存储科创板IPO申请。",
      summary: "长江存储科创板IPO已受理。",
    }),
  ];
  mergeRollingIntoReport(report, rolling, tierMap);
  assert.equal(report.sections.ipo.length, 1, "仅真 IPO 流程条目保留");
  assert.ok(report.sections.ipo[0].url.includes("ipo1"), "诺思兰德式资本运作公告应被分流");
  // R3 兜底：诺思兰德若误入，摘要也不该是「广东企业」模板（此处已被分流，直接断言无模板残留）
  const all = JSON.stringify(report.sections);
  assert.ok(!all.includes("广东企业"), "模板错误摘要不应进报告");
});
