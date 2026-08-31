/**
 * buildTwoDayExecPool 单元测试（2026-08-23 2 天窗口需求）。
 * 验证：今/昨两天窗口内的 finance|gz 高信号条目被纳入，前天与无关/无摘要被排除，
 * 且时区（REPORT_TZ=Asia/Shanghai）下日期键比对正确。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTwoDayExecPool, dateKeyOf, type ExecPoolHistoryEntry } from "../lib/ai/exec-pool";
import type { DailyReport } from "../lib/types";

const TODAY = "2026-08-23";
const YEST = "2026-08-22";
const BEFORE = "2026-08-21";

function mkReportItem(url: string, title_cn: string, summary: string) {
  return {
    url,
    title_cn,
    title_orig: "",
    source: "源",
    source_type: "media" as const,
    date: "08/23",
    summary,
    importance: 2 as const,
    rank: 1,
    tags: [],
    locale: "national" as const,
  };
}

function mkReport(): DailyReport {
  return {
    date: TODAY,
    hero_line: "",
    must_read: [],
    insights: [],
    sections: {
      gz_local: [mkReportItem("tg", "今日广州业务", "今日广州某业务动态摘要。")],
      biz_insight: [],
      policy_market: [mkReportItem("tf", "今日宏观政策", "今日某宏观政策摘要。")],
      tech: [],
      ipo: [],
    },
  };
}

function mkHistory(): Record<string, ExecPoolHistoryEntry> {
  return {
    // 昨日 finance，相关+有摘要 → 应纳入
    yf: { publishedAt: `${YEST}T20:00:00+08:00`, category: "finance", ai_relevant: true, summary: "昨日宏观政策摘要。", title: "昨日宏观", url: "yf" },
    // 昨日 gz，相关+有摘要 → 应纳入
    yg: { publishedAt: `${YEST}T19:00:00+08:00`, category: "gz", ai_relevant: true, summary: "昨日广州业务摘要。", title: "昨日广州", url: "yg" },
    // 前天 finance → 超窗口，排除
    of: { publishedAt: `${BEFORE}T10:00:00+08:00`, category: "finance", ai_relevant: true, summary: "前天宏观摘要。", title: "前天宏观", url: "of" },
    // 昨日但不相关 → 排除
    nr: { publishedAt: `${YEST}T18:00:00+08:00`, category: "finance", ai_relevant: false, summary: "无关摘要。", url: "nr" },
    // 昨日相关但无摘要 → 排除
    ns: { publishedAt: `${YEST}T17:00:00+08:00`, category: "gz", ai_relevant: true, summary: "", title: "无摘要", url: "ns" },
  };
}

const articles = [
  { url: "tf", publishedAt: `${TODAY}T09:00:00+08:00`, category: "finance" },
  { url: "tg", publishedAt: `${TODAY}T09:30:00+08:00`, category: "gz" },
];

test("2天窗口：纳入今+昨，排除前天/无关/无摘要", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const res = buildTwoDayExecPool({ history: mkHistory(), articles, report: mkReport(), today: TODAY });
  const finUrls = res.finance.map((i) => i.url).sort();
  const gzUrls = res.gz.map((i) => i.url).sort();
  // finance：今日 tf + 昨日 yf，排除前天 of、无关 nr
  assert.deepEqual(finUrls, ["tf", "yf"]);
  // gz：今日 tg + 昨日 yg，排除无摘要 ns
  assert.deepEqual(gzUrls, ["tg", "yg"]);
});

test("2天窗口：前天条目整体排除", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const res = buildTwoDayExecPool({ history: mkHistory(), articles, report: mkReport(), today: TODAY });
  const all = [...res.finance, ...res.gz].map((i) => i.url);
  assert.ok(!all.includes("of"), "前天条目不应纳入");
  assert.ok(!all.includes("nr"), "不相关条目不应纳入");
  assert.ok(!all.includes("ns"), "无摘要条目不应纳入");
});

test("时区：UTC 凌晨时间戳在 Asia/Shanghai 下日期键正确", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  // 2026-08-22T16:00:00Z = 上海 2026-08-23 00:00 → 应归今天
  assert.equal(dateKeyOf("2026-08-22T16:00:00Z", "Asia/Shanghai"), "2026-08-23");
  // 2026-08-23T00:30:00Z = 上海 2026-08-23 08:30 → 今天
  assert.equal(dateKeyOf("2026-08-23T00:30:00Z", "Asia/Shanghai"), "2026-08-23");
  // 无效日期返回 undefined
  assert.equal(dateKeyOf("not-a-date", "Asia/Shanghai"), undefined);
});

/**
 * 广东 IPO 池（2026-08-31 新增）。
 * 背景：exec 提示词有 guangdong_ipo 槽位且要求「无则 null、不要编造」，但 ipo 入参
 * 从未被传入 → LLM 恒回 null，口播只能靠 audio.ts 确定性兜底。本测试锁住该通路。
 * 要点：IPO 用 7 天窗口（在审企业更新稀疏），且绝不并入 finance/gz 池。
 */
test("IPO 池：7 天窗口，且不被并入 finance/gz", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const DAY = 86_400_000;
  const report = mkReport();
  report.sections.ipo = [
    mkReportItem("ipo-a", "尚睿科技：IPO问询中（拟北交所）", "注册地：广东｜更新：2026-08-27"),
  ];
  const arts = [
    {
      url: "ipo-a",
      publishedAt: new Date(Date.now() - 3 * DAY), // 与 sections 同 url → 不重复
      category: "gd-ipo",
      title: "尚睿科技：IPO问询中（拟北交所）",
      summary: "注册地：广东",
    },
    {
      url: "ipo-b",
      publishedAt: new Date(Date.now() - 5 * DAY), // 5 天前：超 2 天但仍在 7 天内 → 应纳入
      category: "gd-ipo",
      title: "腾信精密：IPO已受理（拟北交所）",
      excerpt: "注册地：广东｜保荐：国泰海通",
    },
    {
      url: "ipo-c",
      publishedAt: new Date(Date.now() - 9 * DAY), // 9 天前：超 7 天 → 排除
      category: "gd-ipo",
      title: "某旧企业：IPO过会（拟创业板）",
      excerpt: "注册地：广东",
    },
  ];
  const res = buildTwoDayExecPool({
    history: mkHistory(),
    articles: arts,
    report,
    today: TODAY,
  });
  const ipoUrls = res.ipo.map((i) => i.url).sort();
  assert.deepEqual(ipoUrls, ["ipo-a", "ipo-b"], "7 天窗口内的 gd-ipo 都应纳入，9 天前排除");

  // 关键：IPO 绝不能污染必读/商机池
  const finGz = [...res.finance, ...res.gz].map((i) => i.url);
  assert.ok(!finGz.includes("ipo-a") && !finGz.includes("ipo-b"), "IPO 条目不得进入 finance/gz 池");
  // 原有的 finance/gz 结果不受影响
  assert.deepEqual(res.finance.map((i) => i.url).sort(), ["tf", "yf"]);
  assert.deepEqual(res.gz.map((i) => i.url).sort(), ["tg", "yg"]);
});

test("IPO 池：无 IPO 条目时返回空数组（不报错）", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const res = buildTwoDayExecPool({
    history: mkHistory(),
    articles,
    report: mkReport(),
    today: TODAY,
  });
  assert.deepEqual(res.ipo, []);
});

test("无 publishedAt 的条目被跳过", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const hist: Record<string, ExecPoolHistoryEntry> = {
    noDate: { category: "finance", ai_relevant: true, summary: "有摘要但无日期", title: "无日期", url: "noDate" },
  };
  const res = buildTwoDayExecPool({ history: hist, articles: [], report: mkReport(), today: TODAY });
  assert.equal(res.finance.length, 1, "今日 report.sections 仍贡献 tf");
  assert.ok(!res.finance.map((i) => i.url).includes("noDate"));
});
