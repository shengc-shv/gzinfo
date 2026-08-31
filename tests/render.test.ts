/**
 * renderHtml 快照/结构测试（zh 默认 locale）：
 * 结构存在性 / 关键 CSS class / 关键文本 / 空数据兜底 / 日期。
 * 新管线 schema：renderHtml(report, date) 消费 report.sections（ReportItem[]）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../lib/output/render";
import { renderRawCategoryPanel, formatDate, isDateOnly, sortByTierAndTime, type SubGroup } from "../lib/output/render/cards";
import type { DailyReport, ArticleInput, ReportItem } from "../lib/types";
import { toMatchSnapshot } from "./snapshot";

const report = (): DailyReport => ({
  date: "",
  hero_line: "",
  must_read: [],
  insights: [],
  sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
});

const withSection = (key: keyof DailyReport["sections"], items: ReportItem[]): DailyReport => ({
  date: "",
  hero_line: "",
  must_read: [],
  insights: [],
  sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [], [key]: items },
});

const mkItem = (over: Partial<ReportItem> = {}): ReportItem => ({
  url: "https://x/u1",
  title_cn: "广州房贷利率下调",
  source: "测试源",
  source_type: "media",
  date: "08/19",
  summary: "AI 摘要",
  importance: 2,
  rank: 1,
  tags: [],
  locale: "national",
  ...over,
});

const item = (
  url: string,
  title: string,
  category: ArticleInput["category"],
): ArticleInput => ({
  sourceId: "test-src",
  source: "测试源",
  title,
  url,
  excerpt: "摘要内容",
  summary: "AI 摘要",
  category,
  publishedAt: new Date("2026-08-19T08:00:00Z"),
  fetchedToday: true, // 当天条目，渲染进 finance 面板的"当天" tab
});

test("renderHtml: 基础结构存在性（html/style/script/zh locale）", () => {
  const html = renderHtml(report(), "2026-08-19");
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("</html>"));
  assert.ok(html.includes("<style>"));
  assert.ok(html.includes("<script"));
  assert.ok(html.includes('lang="zh-CN"'), "zh 默认 locale 应输出 lang=zh-CN");
});

test("renderHtml: 文章卡片渲染关键 CSS class 与文本", () => {
  const html = renderHtml(withSection("policy_market", [mkItem()]), "2026-08-19");
  assert.ok(html.includes('class="brief"'), "卡片容器 class");
  assert.ok(html.includes("<h3><a"), "标题 class");
  assert.ok(html.includes("广州房贷利率下调"), "文章标题文本");
  assert.ok(html.includes("https://x/u1"), "文章链接");
  assert.ok(html.includes("AI 摘要"), "摘要文本");
});

test("renderHtml: 空数据兜底不抛错", () => {
  const html = renderHtml(report(), "2026-08-19");
  assert.ok(html.includes("</html>"));
});

test("renderHtml: 日期出现在标题", () => {
  const html = renderHtml(report(), "2026-08-19");
  assert.ok(html.includes("2026-08-19"));
});

test("renderHtml: CSS class 清单快照（防渲染回归）", () => {
  const html = renderHtml(
    withSection("policy_market", [
      mkItem({ source_type: "official", importance: 3, tags: ["政银"] }),
      mkItem({ url: "https://x/u2", title_cn: "另一则消息" }),
    ]),
    "2026-08-19",
  );
  const classes = new Set<string>();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
  toMatchSnapshot("render-zh-class-inventory", [...classes].sort().join("\n"));
});

test("renderHtml: 来源徽章按 source_type 区分（src-badge，2026-08-21 重构去 tier-badge）", () => {
  // 媒体 → src-media（不再渲染旧 tier-badge）
  assert.ok(!renderHtml(withSection("policy_market", [mkItem({ source_type: "media" })]), "2026-08-19").includes("tier-badge"));
  // 官方 → src-official + 官方 文案
  const html = renderHtml(withSection("policy_market", [mkItem({ source_type: "official" })]), "2026-08-19");
  assert.ok(html.includes('class="src-badge src-official"'), "应渲染 官方 徽章");
  assert.ok(html.includes(">官方<"), "应渲染 官方 徽章文案");
});

test("技术动态 sub-tab 计数与内容口径一致：只算最近 2 天（统一展示窗口）", () => {
  // 两个子组触发 sub-tabs 渲染；每组混入 5 天前的旧条目（超窗口，不计入）
  const now = new Date();
  const oldDate = new Date(now.getTime() - 5 * 86_400_000).toISOString();
  const subs: SubGroup[] = [
    {
      id: "cn-tech",
      name: "技术动态",
      sources: [
        {
          sourceId: "test-src",
          sourceName: "测试源",
          items: [
            { ...item("https://x/a", "今天的技术新闻", "tech"), publishedAt: now },
            { ...item("https://x/b", "5天前的技术新闻", "tech"), publishedAt: new Date(oldDate) },
          ],
        },
      ],
    },
    {
      id: "ai-news",
      name: "AI 动态",
      sources: [
        {
          sourceId: "test-src",
          sourceName: "测试源",
          items: [
            { ...item("https://x/c", "今天 AI 动态", "tech"), publishedAt: now },
            { ...item("https://x/d", "5天前 AI 动态", "tech"), publishedAt: new Date(oldDate) },
            { ...item("https://x/e", "5天前 AI 动态2", "tech"), publishedAt: new Date(oldDate) },
          ],
        },
      ],
    },
  ];
  const html = renderRawCategoryPanel("tech", subs, "2026-08-19");
  // 计数应只统计最近 2 天：cn-tech=1、ai-news=1（而非全量 2/3）
  assert.ok(html.includes('data-sub="cn-tech" data-cat="tech">技术动态<span class="count">1</span>'), "cn-tech 计数应只算最近 2 天 1 条");
  assert.ok(html.includes('data-sub="ai-news" data-cat="tech">AI 动态<span class="count">1</span>'), "ai-news 计数应只算最近 2 天 1 条");
  assert.ok(!html.includes('<span class="count">3</span>'), "不应把超窗口条目计入 tab 计数");
});

test("财经面板「国家政策」sub-tab 计数同口径：只算最近 2 天", () => {
  // 用户场景：finance 面板 cn-policy 子组，2 条超窗口旧文 + 1 条 2 天内
  const now = new Date();
  const oldDate = new Date(now.getTime() - 5 * 86_400_000).toISOString();
  const subs: SubGroup[] = [
    {
      id: "cn-policy",
      name: "国家政策",
      sources: [
        {
          sourceId: "test-src",
          sourceName: "测试源",
          items: [
            { ...item("https://x/p1", "最近的宏观政策", "finance"), publishedAt: now },
            { ...item("https://x/p2", "5天前宏观政策1", "finance"), publishedAt: new Date(oldDate) },
            { ...item("https://x/p3", "5天前宏观政策2", "finance"), publishedAt: new Date(oldDate) },
          ],
        },
      ],
    },
    {
      id: "news",
      name: "要闻",
      sources: [
        {
          sourceId: "test-src",
          sourceName: "测试源",
          items: [{ ...item("https://x/n1", "最近要闻", "finance"), publishedAt: now }],
        },
      ],
    },
  ];
  const html = renderRawCategoryPanel("finance", subs, "2026-08-19");
  // cn-policy 计数应为最近 2 天 1 条（而非全量 3 条）
  assert.ok(html.includes('data-sub="cn-policy" data-cat="finance">国家政策<span class="count">1</span>'), "cn-policy 计数应只算最近 2 天 1 条");
  assert.ok(!html.includes('<span class="count">3</span>'), "不应把超窗口条目计入 cn-policy 计数");
});

test("filterRecentDays: 无发布时间 → 丢弃（时间红线，不回退 fetchedAt，不计入窗口）", () => {
  const now = new Date();
  const day = 86_400_000;
  const subs: SubGroup[] = [
    {
      id: "cn-tech",
      name: "技术动态",
      sources: [
        {
          sourceId: "test-src",
          sourceName: "测试源",
          items: [
            // 无 publishedAt：采集于 1 小时前 → 时间红线丢弃
            { ...item("https://x/f1", "无发布时间·今天采集", "tech"), publishedAt: undefined, fetchedAt: new Date(now.getTime() - 3_600_000) },
            // 有发布时间：发布 2 小时前 → 保留
            { ...item("https://x/p1", "有发布时间·2小时前", "tech"), publishedAt: new Date(now.getTime() - 2 * 3_600_000) },
            // 无 publishedAt：采集于 5 天前 → 时间红线丢弃
            { ...item("https://x/f2", "无发布时间·5天前采集", "tech"), publishedAt: undefined, fetchedAt: new Date(now.getTime() - 5 * day) },
          ],
        },
      ],
    },
    // 第二子组触发 sub-tabs 渲染（单子组走单面板分支不渲染计数）
    {
      id: "ai-news",
      name: "AI 动态",
      sources: [
        {
          sourceId: "test-src",
          sourceName: "测试源",
          items: [{ ...item("https://x/a1", "AI 动态条目", "tech"), publishedAt: now }],
        },
      ],
    },
  ];
  const html = renderRawCategoryPanel("tech", subs, "2026-08-19");
  // 仅「有发布时间·2小时前」计入窗口（2 条无发布时间按时间红线丢弃）
  assert.ok(html.includes('data-sub="cn-tech" data-cat="tech">技术动态<span class="count">1</span>'), "无发布时间条目不计入窗口（时间红线丢弃）");
  assert.ok(html.indexOf("无发布时间·今天采集") === -1, "无发布时间条目不渲染");
  assert.ok(html.indexOf("无发布时间·5天前采集") === -1, "无发布时间条目不渲染");
});

test("formatDate: 只有日期（UTC零点/北京零点）→ 展示日期；有真实时分 → 展示时分", () => {
  // 国内爬虫源形态：UTC 零点 → 只有日期 → YYYY-MM-DD
  const utcZero = new Date("2026-08-21T00:00:00.000Z");
  assert.equal(isDateOnly(utcZero), true, "UTC 零点应判定只有日期");
  assert.equal(formatDate(utcZero), "2026-08-21");
  // ftchinese 形态：北京零点（UTC 前日 16:00）→ 只有日期
  const bjZero = new Date("2026-08-19T16:00:00.000Z");
  assert.equal(isDateOnly(bjZero), true, "北京零点应判定只有日期");
  // 有真实时分 → 展示 MM/DD HH:mm（zh-CN）
  const withTime = new Date("2026-08-20T04:39:58.000Z");
  assert.equal(isDateOnly(withTime), false, "真实时分不应判定只有日期");
  const fmt = formatDate(withTime);
  assert.match(fmt, /^\d{2}\/\d{2} \d{2}:\d{2}$/, `formatDate 应输出 MM/DD HH:mm，实际 ${fmt}`);
});

test("sortByTierAndTime: tier 权威等级 + 时间排序，只有日期沉底", () => {
  const mk = (title: string, publishedAt: Date | undefined, tier?: string): ArticleInput => ({
    sourceId: "s",
    source: "源",
    title,
    url: "https://x/" + title,
    excerpt: "",
    summary: "",
    category: "finance",
    publishedAt,
    tier: tier as ArticleInput["tier"],
  });
  const withTimeT2 = mk("媒体·有时分", new Date("2026-08-20T10:00:00.000Z"), "T2");
  const withTimeT1 = mk("官方·有时分", new Date("2026-08-20T09:00:00.000Z"), "T1");
  const dateOnlyT1 = mk("官方·只有日期", new Date("2026-08-20T00:00:00.000Z"), "T1");
  const noDate = mk("无日期", undefined);
  const sorted = sortByTierAndTime([noDate, dateOnlyT1, withTimeT2, withTimeT1]);
  assert.deepEqual(
    sorted.map((a) => a.title),
    ["官方·有时分", "媒体·有时分", "官方·只有日期", "无日期"],
    "排序：有时分按 tier(官方>媒体) → 只有日期沉底 → 无日期最底",
  );
});

test("子标签合并输出：无 L3 信息源 tabs（只到子标签）", () => {
  // 模拟 groupRaw 合并流输出（2026-08-21 起所有子标签均构造成单 _merged source）
  const now = new Date();
  const subs: SubGroup[] = [
    {
      id: "cn-policy",
      name: "国家政策",
      sources: [
        {
          sourceId: "_merged",
          sourceName: "国家政策",
          merged: true,
          items: [
            { ...item("https://x/p1", "国务院政策文件", "finance"), publishedAt: now, tier: "T1", source: "国务院" },
            { ...item("https://x/p2", "央视解读政策", "finance"), publishedAt: now, tier: "T1.5", source: "央视" },
            { ...item("https://x/p3", "新浪报道政策", "finance"), publishedAt: now, tier: "T2", source: "新浪" },
          ],
        },
      ],
    },
  ];
  const html = renderRawCategoryPanel("finance", subs, "2026-08-19");
  assert.ok(!html.includes("source-tab"), "不再渲染 L3 信息源 tabs");
  assert.ok(html.includes("国务院政策文件") && html.includes("央视解读政策") && html.includes("新浪报道政策"), "多源条目合并为单一时间流");
  // merged 流 → 卡片展示来源小字
  assert.ok(html.includes("国务院") && html.includes("央视") && html.includes("新浪"), "来源降级为卡片上的来源标识");
});

// ---------- 面板级筛选条：业务线动态渲染（2026-08-23）----------
import { renderFilterBarForPanel } from "../lib/output/render";

function mkDeptItem(tags: string[]): ReportItem {
  return {
    url: "https://t/" + tags.join("-"),
    title_cn: "测试条目",
    title_orig: "",
    source: "测试源",
    source_type: "media",
    date: "08/23",
    summary: "摘要",
    importance: 2,
    rank: 1,
    tags,
    locale: "national",
  };
}

test("筛选条：板块无任何部门标签 → 业务线维度不渲染，仅来源维度", () => {
  const html = renderFilterBarForPanel([mkDeptItem([]), mkDeptItem(["科技金融"])]);
  assert.ok(html.includes("来源"), "来源维度保留");
  assert.ok(html.includes("业务线"), "有「其他」数据时业务线维度渲染");
  assert.ok(html.includes(">其他<"), "无部门标签卡片 → 渲染其他");
  assert.ok(!html.includes(">客群<"), "客群无数据不渲染");
  assert.ok(!html.includes(">私行<"), "私行无数据不渲染");
  assert.ok(!html.includes(">财富<"), "财富无数据不渲染");
  assert.ok(!html.includes(">信贷<"), "信贷无数据不渲染");
});

test("筛选条：仅客群+无标签 → 只渲染 客群/其他，不渲染 私行/财富/信贷", () => {
  const html = renderFilterBarForPanel([mkDeptItem(["客群"]), mkDeptItem([])]);
  assert.ok(html.includes(">客群<"), "客群有数据则渲染");
  assert.ok(html.includes(">其他<"), "无标签卡片存在则渲染其他");
  assert.ok(!html.includes(">私行<"), "私行无数据不渲染");
  assert.ok(!html.includes(">财富<"), "财富无数据不渲染");
  assert.ok(!html.includes(">信贷<"), "信贷无数据不渲染");
});

test("筛选条：客群/财富/信贷 有数据 → 全部渲染且顺序固定，无标签则加其他", () => {
  const html = renderFilterBarForPanel([
    mkDeptItem(["信贷"]),
    mkDeptItem(["财富"]),
    mkDeptItem(["客群"]),
    mkDeptItem(["科技金融"]),
  ]);
  const gTitle = html.indexOf(">客群<");
  const pTitle = html.indexOf(">私行<");
  const wTitle = html.indexOf(">财富<");
  const cTitle = html.indexOf(">信贷<");
  assert.ok(gTitle >= 0 && wTitle >= 0 && cTitle >= 0, "客群/财富/信贷渲染");
  assert.ok(pTitle < 0, "私行无数据不渲染");
  assert.ok(gTitle < wTitle && wTitle < cTitle, "顺序固定：客群→财富→信贷");
  assert.ok(html.includes(">其他<"), "含非部门标签卡片则渲染其他");
});
