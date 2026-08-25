/**
 * 渲染 i18n（M3-C 拆分自 lib/output/render.ts）：
 * 文案表 TEXTS_ZH/TEXTS_EN、STR 解析、子类目顺序与标签。
 */
import { REPORT_LOCALE } from "../../sources/registry";
import type { Category } from "../../sources/types";

// ----- i18n -----

const TEXTS_ZH = {
  siteTitle: "每日简报",
  catTech: "技术动态",
  catFinance: "宏观政策",
  catPolitics: "时政观察",
  catTrading: "市场行情",
  catGdIpo: "广东地区IPO",
  catIpo: "IPO/新股",
  catCommunity: "社区讨论",
  subAiNews: "AI 媒体",
  subTrendingPapers: "热门论文",
  subXViral: "X 推文",
  subBlogWeekly: "博客周刊",
  subCnCommunity: "中文社区",
  subCnTech: "国内技术",
  subOverseasTech: "国外技术",
  subOverseasCommunity: "海外社区",
  subFinanceNews: "国际财经",
  subFinanceCn: "国内财经",
  subFinanceCommunity: "社区讨论",
  subWorld: "国际要闻",
  bandOfficial: "官方 / 政府一手来源",
  bandMedia: "媒体 / 智库解读",
  subOverseasNews: "海外科技",
  subOverseas: "海外",
  emptySource: "该源今日无内容。",
  emptyCategory: "该分类今日无内容。",
  emptyGroup: "该组今日无数据。",
  timeToday: "当天",
  timePast7: "过去7天",
  footer: "内容均来自原媒体，本站仅作摘要整理与回链。",
  summaryLabelNews: "AI分析",
  summaryLabelIntro: "AI分析",
  tradingMarketOverview: "市场总览",
  tradingTodayFocus: "今日关注",
  tradingAllAssets: "全部资产",
  tradingRiskCaveat: "风险提示",
  widgetCryptoFearGreed: "加密恐慌贪婪",
  widgetCryptoCap: "加密总市值",
  widgetBtcDom: "BTC 主导率",
  widgetVolume24h: "24h 成交量",
  widgetActiveCoins: "活跃币",
  ticker5d: "5 日",
  tickerVs52wHigh: "距 52w 高",
  tickerTrend: "趋势",
  tickerMacd: "MACD / 信号",
  signalToday: "今天",
  signalDaysAgoSuffix: "天前",
  trendBullish: "多头",
  trendBearish: "空头",
  trendNeutral: "中性",
  mdTodayOverview: "今日总览",
  mdEditorNote: "编辑短评",
  mdTodayKeywords: "今日关键词",
  mdImportance: "重要度",
  archiveLink: "← 历史归档",
  execInsightsShow: "条商机洞察",
  execInsightsHide: "收起商机洞察",
};


const TEXTS_EN: typeof TEXTS_ZH = {
  siteTitle: "Daily Brief",
  catTech: "Tech",
  catFinance: "Finance",
  catPolitics: "World",
  catTrading: "Markets",
  catGdIpo: "Guangdong IPO",
  catIpo: "IPO / New Listings",
  catCommunity: "Community",
  subAiNews: "AI Media",
  subTrendingPapers: "Trending Papers",
  subXViral: "X Viral",
  subBlogWeekly: "Blog Weekly",
  subCnCommunity: "Chinese Community",
  subCnTech: "Chinese Tech",
  subOverseasTech: "Overseas Tech",
  subOverseasCommunity: "Overseas Community",
  subFinanceNews: "Finance News",
  subFinanceCn: "Finance China",
  subFinanceCommunity: "Community",
  subWorld: "World News",
  bandOfficial: "Official / Government sources",
  bandMedia: "Media / Think-tank",
  subOverseasNews: "Overseas Tech",
  subOverseas: "Overseas",
  emptySource: "No content from this source today.",
  emptyCategory: "No content in this category today.",
  emptyGroup: "No data for this group today.",
  timeToday: "Today",
  timePast7: "Past 7d",
  footer:
    "Content sourced from original publishers; this site provides summary and backlinks only.",
  summaryLabelNews: "Summary",
  summaryLabelIntro: "Summary",
  tradingMarketOverview: "Market Overview",
  tradingTodayFocus: "Today's Focus",
  tradingAllAssets: "All Assets",
  tradingRiskCaveat: "Risk Disclaimer",
  widgetCryptoFearGreed: "Crypto Fear/Greed",
  widgetCryptoCap: "Crypto Market Cap",
  widgetBtcDom: "BTC Dominance",
  widgetVolume24h: "24h Volume",
  widgetActiveCoins: "Active coins",
  ticker5d: "5d",
  tickerVs52wHigh: "vs 52w High",
  tickerTrend: "Trend",
  tickerMacd: "MACD / Signal",
  signalToday: "today",
  signalDaysAgoSuffix: "d ago",
  trendBullish: "Bullish",
  trendBearish: "Bearish",
  trendNeutral: "Neutral",
  mdTodayOverview: "Today's Overview",
  mdEditorNote: "Editor's Note",
  mdTodayKeywords: "Keywords",
  mdImportance: "Importance",
  archiveLink: "← Archive",
  execInsightsShow: "business insights",
  execInsightsHide: "Hide insights",
};


const STR = REPORT_LOCALE === "en" ? TEXTS_EN : TEXTS_ZH;

const SUBCATEGORY_ORDER: Partial<Record<Category, string[]>> = {
  // cn-community + overseas-community are listed last so the L1 "community"
  // panel (rendered separately via TECH_COMMUNITY_SUBS) can extract them.
  // Within the "tech" L1 panel itself, COMMUNITY_SUBS is filtered out.
  // Locale filtering at registry level decides which actually appears:
  // zh mode keeps cn-community (V2EX / LinuxDo); en mode keeps
  // overseas-community (Hacker News / r/stocks).
  // 技术动态：国内技术 / 国外技术（2026-08-20 清理：去掉 AI媒体/热门论文/X 推文子类）
  tech: ["cn-tech", "overseas-tech"],
  // 宏观政策：国家政策 / 国内财经(综合) / 广州政策 / 国际
  // （2026-08-21 用户：全国财富/信贷/私行 移出宏观政策，并入广州商机面板区分全国/广州）
  finance: ["cn-policy", "cn-finance", "gz-policy", "news"],
  'gd-ipo': ["stage-listed", "stage-registered", "stage-reviewing", "stage-tutoring"],
  // 参考区·全国IPO/新股：全部交易所+辅导（非广州辖区的广东企业也归此）
  ipo: ["sse", "szse", "bse", "hkex", "ipo-tutoring", "overseas"],
  // 广州商机：合并为单一「广州能参考的商机」流（2026-08-21 用户：不再按业务线/
  // 本地全国分层，面板内仅按「官方政府 / 媒体智库」两类 tab 展现）
  gz: ["gz-all"],
  politics: ["world"],
  // 昨日股市（2026-08-25 新增）：A股 / 美股 / 港股 三个市场分组
  stocks: ["a-share", "us", "hk"],
};

const SUBCATEGORY_LABELS: Record<string, string> = {
  "github-trending": "GitHub Trending",
  "trending-papers": STR.subTrendingPapers,
  "cn-community": STR.subCnCommunity,
  "overseas-community": STR.subOverseasCommunity,
  "ai-news": STR.subAiNews,
  "cn-tech": STR.subCnTech,
  "overseas-tech": STR.subOverseasTech,
  "x-viral": STR.subXViral,
  "blog-weekly": STR.subBlogWeekly,
  news: STR.subFinanceNews,
  "cn-finance": STR.subFinanceCn,
  "cn-wealth": "全国财富",
  "cn-credit": "全国零售信贷",
  "cn-private": "全国私行",
  "cn-policy": "国家政策",
  "gz-policy": "广州政策",
  world: STR.subWorld,
  // 广东地区IPO 的 6 个二级标签（地域→市场 分发；预备上市统一进 IPO辅导）
  szse: "深交所",
  sse: "上交所",
  bse: "北交所",
  hkex: "港交所",
  "ipo-tutoring": "IPO辅导",
  // 昨日股市三个市场分组（2026-08-25 新增）
  "a-share": "A股",
  us: "美股",
  hk: "港股",
  overseas: "境外",
  // 广东地区IPO 按「上市进度」分栏（任务二：看已上市 / 准备IPO 两类，找股份行广州分行商机）
  "stage-listed": "已上市·新股",
  "stage-registered": "注册生效·过会",
  "stage-reviewing": "在审·已受理",
  "stage-tutoring": "辅导备案·Pre-IPO",
  // 广州商机（合并流：广州可参考的商机，官方/媒体两 tab）
  "gz-all": "广州商机",
};

export { STR, SUBCATEGORY_ORDER, SUBCATEGORY_LABELS, TEXTS_ZH, TEXTS_EN };
