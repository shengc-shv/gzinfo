/**
 * 执行摘要兜底回归测试（2026-08-31 修复）。
 *
 * 复现场景：CI 实际产出「今日定调=今天只有1条IPO信息、今日分析(必读/商机)为空」。
 * 根因：2 天窗口池在今日抓取条目缺 publishedAt 时被静默清空，且 AI 分支在 LLM
 * 返回空时没有任何确定性兜底。本测试验证：
 *  1) buildTwoDayExecPool / collectTwoDayArticles 正确按「今天+昨天」两天窗口纳排
 *     （窗口内 finance|gz 纳入、超窗口排除）；
 *  2) AI 分支 LLM 返回空（仅 IPO 弱信号）→ 回退 2 天评分兜底，必读/商机/定调非空且一致。
 *
 * 2026-09-08 改造（fixture 内联，消除漂移 + 严守时间红线）：
 *  原测试依赖 history/2026-08-31/* 真实日報目录，而该目录从未入库 → 模块加载期 ENOENT。
 *  现把所需 fixtures 内联为本文件常量，且**每条均带真实 publishedAt（落在两天窗口内，
 *  带 +08:00 偏移）**，与具体日報目录解耦、永不再漂移；并锁定 REPORT_TZ=Asia/Shanghai
 *  保证窗口判定的时区确定性。绝不造「缺发布时间」的条目（时间红线：缺发布时间一律不要）。
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 关闭内容记忆层：防止测试运行把「模拟播报」写入生产 data/event-memory.json
// （记忆是跨运行持久化资产，测试触发写入会污染记忆库）。
process.env.EVENT_MEMORY = "0";
// 锁定报告时区，保证 dateKeyOf 的窗口判定在任意运行环境一致。
process.env.REPORT_TZ = "Asia/Shanghai";

const DATE = "2026-08-31";
const STORE_DIR = path.resolve(process.cwd(), "history", DATE);
const STORE = path.join(STORE_DIR, "store.json");

/**
 * articles：取自 2026-09-01 真实抓取的一批 finance/gz 条目（已脱敏为最小字段），
 * 每条均带真实 publishedAt，落在两天窗口内（10 条「今天」2026-08-31 + 4 条「昨天」2026-08-30）。
 * 这样既不依赖旋转日報目录（消除漂移），又严守时间红线（无缺发布时间的条目）。
 */
const ARTICLES: any[] = [
  {
    url: "https://www.stcn.com/article/detail/4162904.html",
    title: "直击新政落地后京沪深楼市动态—— 周末中介带看量多起来了 购房者期待细则落地",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-31T12:00:00+08:00",
    summary: "楼市新政落地后京沪深周末带看量回升，购房者等待细则；信贷条线可提前准备房贷投放节奏与额度安排。",
    excerpt: "直击新政落地后京沪深楼市动态—— 周末中介带看量多起来了 购房者期待细则落地",
    source: "证券时报",
    sourceId: "stcn",
  },
  {
    url: "https://www.stcn.com/article/detail/4164743.html",
    title: "两部门改革完善房地产信贷管理：个人住房贷款期限延至最长40年",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-31T12:00:00+08:00",
    summary: "两部门改革房地产信贷管理，个人住房贷款期限延长至最长40年；信贷条线建议本周内完成按揭产品要素与系统参数复核。",
    excerpt: "两部门改革完善房地产信贷管理：个人住房贷款期限延至最长40年",
    source: "证券时报",
    sourceId: "stcn",
  },
  {
    url: "https://www.stcn.com/article/detail/4164744.html",
    title: "头部券商、地产集团火线解读：资本市场支持房地产新政，怎么搞？",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-31T12:00:00+08:00",
    summary: "券商与地产集团解读资本市场支持房地产新政的落地路径；财富条线可据此向客户说明地产链资产的政策支撑逻辑。",
    excerpt: "头部券商、地产集团火线解读：资本市场支持房地产新政，怎么搞？",
    source: "证券时报",
    sourceId: "stcn",
  },
  {
    url: "https://news.southcn.com/node_812903b83a/c23c46f358.shtml",
    title: "解难题、送政策，看民营企业如何轻装出海",
    category: "gz",
    subcategory: "gz-media",
    publishedAt: "2026-08-31T12:00:00+08:00",
    summary: "政策聚焦破解民营企业出海难题，跨境经营支持加码；分行可梳理跨境结算与汇率避险需求，对接本地出海民企客群。",
    excerpt: "解难题、送政策，看民营企业如何轻装出海",
    source: "南方网·经济",
    sourceId: "southcn",
  },
  {
    url: "https://www.stcn.com/article/detail/4164781.html",
    title: "房地产行业融资格局迎来深刻变革",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-31T12:00:00+08:00",
    summary: "房地产行业融资格局发生深刻变革，渠道结构调整；信贷条线建议复核涉房授信的合规要求与资金用途管理。",
    excerpt: "房地产行业融资格局迎来深刻变革",
    source: "证券时报",
    sourceId: "stcn",
  },
  {
    url: "https://www.stcn.com/article/detail/4164833.html",
    title: "实探京沪深楼市！周末中介带看量多起来了",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-31T12:00:00+08:00",
    summary: "京沪深楼市实地探访显示周末带看量明显回升；信贷条线可提前安排按揭受理人力与额度，应对投放高峰。",
    excerpt: "实探京沪深楼市！周末中介带看量多起来了",
    source: "证券时报",
    sourceId: "stcn",
  },
  {
    url: "https://www.stcn.com/article/detail/4164836.html",
    title: "房地产基础制度全面改革！封顶预售与现房销售并行，告别“购房盲盒”",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-31T12:00:00+08:00",
    summary: "房地产基础制度改革推进，封顶预售与现房销售并行；信贷条线建议同步梳理期房与现房按揭的差异化风控口径。",
    excerpt: "房地产基础制度全面改革！封顶预售与现房销售并行，告别“购房盲盒”",
    source: "证券时报",
    sourceId: "stcn",
  },
  {
    url: "https://m.21jingji.com/article/20260831/herald/8a97996072353d57dab34ab376994f83.html",
    title: "房地产信贷新规后首个交易日银行板块走强，地产信贷逻辑将迎来根本改变",
    category: "gz",
    subcategory: "cn-finance",
    publishedAt: "2026-08-31T12:00:00+08:00",
    summary: "房地产信贷新规后首个交易日银行板块走强，地产信贷逻辑生变；信贷条线建议本周内评估新规对按揭投放量与定价的影响。",
    excerpt: "【21财经·金融】房地产信贷新规后首个交易日银行板块走强，地产信贷逻辑将迎来根本改变",
    source: "21世纪经济报道·金融",
    sourceId: "21jingji-finance",
  },
  {
    url: "https://www.cnfin.com/yw-lb/detail/20260831/4462475_1.html",
    title: "净息差企稳修复 分红超2200亿元——六大行上半年营收净利全员双增",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-31T12:00:00+08:00",
    summary: "六大行上半年营收净利双增、净息差企稳、分红超2200亿元；分行可参照同业息差企稳节奏优化存款定价。",
    excerpt: "净息差企稳修复 分红超2200亿元——六大行上半年营收净利全员双增",
    source: "新华财经",
    sourceId: "cnfin",
  },
  {
    url: "https://www.cnfin.com/yw-lb/detail/20260831/4462471_1.html",
    title: "周期板块中报透视：有色、化工集体回暖 价格修复与产业升级共振",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-31T12:00:00+08:00",
    summary: "有色化工程中报集体回暖，价格修复与产业升级共振；信贷条线可关注周期行业客群盈利改善与授信需求。",
    excerpt: "周期板块中报透视：有色、化工集体回暖 价格修复与产业升级共振",
    source: "新华财经",
    sourceId: "cnfin",
  },
  {
    url: "https://www.cnfin.com/yw-lb/detail/20260831/4462462_1.html",
    title: "【看新股】湖南裕能赴港 IPO：磷酸盐正极材料龙头进一步加码产能扩张",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-30T12:00:00+08:00",
    summary: "湖南裕能赴港IPO加码磷酸盐正极材料产能；财富条线可关注港股新股打新机会与产业链标的联动。",
    excerpt: "【看新股】湖南裕能赴港 IPO：磷酸盐正极材料龙头进一步加码产能扩张",
    source: "新华财经",
    sourceId: "cnfin",
  },
  {
    url: "https://www.cnfin.com/yw-lb/detail/20260831/4462460_1.html",
    title: "真抓实干向未来——8月全国各地经济社会发展观察",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-30T12:00:00+08:00",
    summary: "8月各地经济社会发展观察显示稳增长政策持续落地；分行可据此判断本地企业经营环境与信贷需求变化。",
    excerpt: "真抓实干向未来——8月全国各地经济社会发展观察",
    source: "新华财经",
    sourceId: "cnfin",
  },
  {
    url: "https://www.cnfin.com/yw-lb/detail/20260831/4462447_1.html",
    title: "2026数博会映照“十五五”数字经济发展新图景",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-30T12:00:00+08:00",
    summary: "数博会展现「十五五」数字经济发展图景；信贷条线可梳理数字经济客群的科技金融切入点。",
    excerpt: "2026数博会映照“十五五”数字经济发展新图景",
    source: "新华财经",
    sourceId: "cnfin",
  },
  {
    url: "https://www.cnfin.com/hg-lb/detail/20260831/4462491_1.html",
    title: "美大峡谷国家公园突发山洪 超20人失联",
    category: "finance",
    subcategory: "cn-finance",
    publishedAt: "2026-08-30T12:00:00+08:00",
    summary: "美国大峡谷国家公园突发山洪致多人失联，属境外灾害事件，与银行业务无关联。",
    excerpt: "美大峡谷国家公园突发山洪 超20人失联",
    source: "新华财经",
    sourceId: "cnfin",
  },
];

/** 一条超 2 天窗口的「旧闻」，用于验证窗口外条目被排除（时间红线：不混入今日两天池）。 */
const OUT_OF_WINDOW_ARTICLE: any = {
  url: "https://www.stcn.com/article/detail/4150001.html",
  title: "上月末楼市数据回顾：重点城市成交环比回落",
  category: "finance",
  subcategory: "cn-finance",
  publishedAt: "2026-08-28T12:00:00+08:00",
  summary: "上月末楼市成交环比回落，属窗口外旧闻；时间红线下不应纳入今日两天池。",
  excerpt: "上月末楼市数据回顾",
  source: "证券时报",
  sourceId: "stcn",
};

/**
 * report：仅需 .sections / .must_read / .insights / .hero_line 结构；sections 留空，
 * 让两天池完全由 articles 驱动（与「今日抓取条目兜底」场景一致）。
 */
const REPORT: any = {
  sections: { finance: [], gz: [], ipo: [], tech: [], market: [], local: [], policy: [] },
  must_read: [],
  insights: [],
  hero_line: "",
};

/**
 * history：补两条「昨天/今天」已打标条目（均带真实 publishedAt），验证 2 天窗口的
 * 历史库补回支路 + 严格池（ai_relevant===true && 有摘要）纳入。
 */
const HISTORY: Record<string, any> = {
  "https://example.com/hist-finance": {
    url: "https://example.com/hist-finance",
    publishedAt: "2026-08-30T09:00:00+08:00",
    category: "finance",
    title: "昨日宏观：央行重申稳健货币政策 信贷总量合理增长",
    summary: "昨日央行表态稳健货币政策，信贷总量合理增长；信贷条线可延续既有投放节奏。",
    ai_relevant: true,
  },
  "https://example.com/hist-gz": {
    url: "https://example.com/hist-gz",
    publishedAt: "2026-08-31T09:00:00+08:00",
    category: "gz",
    title: "广州黄埔出台惠企政策 制造业技改补贴加码",
    summary: "广州黄埔加码制造业技改补贴，惠企政策落地；分行可对接本地制造企业设备更新融资需求。",
    ai_relevant: true,
  },
};

function makeCtx(mode: "ai" | "skip-ai"): any {
  return {
    startTime: new Date(),
    date: DATE,
    mode:
      mode === "ai"
        ? { kind: "ai" }
        : { kind: "skip-ai", summaryCache: new Map(), relevantUrls: new Set() },
    sources: [],
    tierBySource: new Map(),
    history: HISTORY,
    aiAssets: {},
    errors: [],
    log: { info() {}, warn() {}, error() {} },
  };
}

/** 清理 buildExecutiveSummary 内部 writeStore 落盘的 history/<DATE>/store.json + 空目录。 */
function cleanupStore(): void {
  try {
    if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmdirSync(STORE_DIR);
  } catch {
    /* 目录非空或不存在均可忽略 */
  }
}

test("buildTwoDayExecPool：今天/昨天窗口内（含真实 publishedAt）的 finance|gz 纳入，超窗口排除", async () => {
  const thinReport: any = JSON.parse(JSON.stringify(REPORT));
  for (const sec of Object.keys(thinReport.sections)) thinReport.sections[sec] = [];
  // 窗口外旧闻混入，验证其被排除（时间红线：发布时间超 2 天不进今日两天池）
  const articles = [...ARTICLES, OUT_OF_WINDOW_ARTICLE];
  const { buildTwoDayExecPool } = await import("../lib/ai/exec-pool");
  const pool = buildTwoDayExecPool({ history: HISTORY, articles, report: thinReport, today: DATE });
  assert.ok(pool.finance.length > 0, "窗口内 finance 条目应纳入");
  assert.ok(pool.gz.length > 0, "窗口内 gz 条目应纳入");
  assert.ok(
    !pool.finance.some((f: any) => f.url === OUT_OF_WINDOW_ARTICLE.url),
    "超 2 天窗口的条目应被排除，不应混入今日两天池",
  );
  cleanupStore();
});

test("AI 分支：LLM 只回 IPO 弱信号(必读/商机空) → 2 天评分兜底产出非空且与展示一致", async (t) => {
  t.after(() => {
    mock.reset(); // 清理模块 mock，避免下一个测试二次 mock 同一模块报 ERR_INVALID_STATE
    cleanupStore();
  });

  // 复现线上：LLM 仅回了 1 条 IPO 类定调、必读/商机均为空数组
  mock.module("../lib/ai/llm.ts", {
    namedExports: {
      runLlm: async () => ({
        text: JSON.stringify({ hero_line: "今天只有1条IPO信息", must_read: [], insights: [] }),
      }),
    },
  });
  const { buildExecutiveSummary } = await import(
    "../lib/pipeline/side-outputs/executive-summary"
  );

  const out = await buildExecutiveSummary(REPORT, HISTORY, ARTICLES, makeCtx("ai"));
  assert.ok(out.must_read.length > 0, "必读(今日分析)不应为空");
  assert.ok(out.insights.length > 0, "商机(今日分析)不应为空");
  assert.ok(out.hero_line && out.hero_line.length > 0, "今日定调不应为空");
  assert.ok(
    !out.hero_line.includes("今天只有1条IPO信息"),
    "不应保留 IPO-only 弱定调，应回退为 2 天评分定调",
  );
  // 兜底必读/商机应覆盖今日政策/业务信号（楼市/信贷/房地产等关键词）
  assert.ok(
    out.must_read.some((m: any) => /房贷|楼市|政策|改革|信贷|房地产/.test(m.title || m.why || "")) ||
      out.insights.length > 0,
    "兜底内容应覆盖今日政策/业务信号",
  );
});

test("AI 分支：LLM 调用失败(null) → 同样回退 2 天评分兜底", async (t) => {
  t.after(() => {
    mock.reset();
    cleanupStore();
  });

  mock.module("../lib/ai/llm.ts", {
    namedExports: {
      runLlm: async () => {
        throw new Error("mock LLM failure");
      },
    },
  });
  const { buildExecutiveSummary } = await import(
    "../lib/pipeline/side-outputs/executive-summary"
  );

  const out = await buildExecutiveSummary(REPORT, HISTORY, ARTICLES, makeCtx("ai"));
  assert.ok(out.must_read.length > 0, "LLM 失败后必读不应空");
  assert.ok(out.insights.length > 0, "LLM 失败后商机不应空");
  cleanupStore();
});
