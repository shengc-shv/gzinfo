/**
 * 分行相关性评分层（branch-relevance score）
 * ============================================================================
 * 设计目标：让「以广州招行广州分行为客户」成为结构化的硬约束，
 * 而不是只靠 LLM 临场发挥（现状：select-top.ts 直接「保持 AI 给的原始顺序」，
 * 客户相关性排序 100% 委托给模型，无评分/无测试/无兜底）。
 *
 * 特征：
 *  - 纯函数、确定性、可单测；
 *  - 可解释：每条结果带 signals[]，说明加分/判级来源（调试与可信度）；
 *  - 不依赖 LLM 标签（tags / importance）—— 仅从原始字段
 *    (title / category / subcategory / sourceId / summary) 计算，
 *    因此在 SKIP_AI（无 AI 富化）下也能独立工作，
 *    可作为 must_read / insights 排序的「护栏 + 喂料」。
 *
 * 业务线词表对齐 prompts.ts:35 与 select-top.ts:19（行长5分钟核心 = 财富/私行/客群/信贷）。
 *
 * 接入说明：本模块是「评分器」，不修改任何管线文件。要把分数真正喂进
 * 必读排序，需要改动 lib/ai/exec-pool.ts / pipeline.ts 等（属用户红线保护的 7 文件，
 * 需用户另行授权）。本层可先作为回归护栏 + 人工抽检工具使用。
 */

export type Tier = "must_read" | "insight" | "context" | "drop";
export type Vertical = "must_read" | "insight" | "risk" | "context" | "drop";

export interface BranchRelevance {
  /** 0-100 综合相关性分（越高越该给分行看） */
  score: number;
  /** 优先级档位 */
  tier: Tier;
  /** 落位建议：risk = 威胁/合规向（进风险卡），其余同 tier */
  vertical: Vertical;
  /** 命中的业务线（按权重降序，取前 3） */
  businessLines: string[];
  /** 发布/发文方权威度 0-1 */
  authority: number;
  /** 可行动性 0-1（政策/风险行动 > 数据解读 > 软资讯） */
  actionability: number;
  /** 地域贴近度 0-1（广州/南沙 > 广东 > 全国/国际） */
  locality: number;
  /** 是否风险/合规向 */
  risk: boolean;
  /** 外埠区域性银行（他省城商行/农商行）→ 仅「参考」意义，不进必读（2026-08-29 用户） */
  foreignRegional?: boolean;
  /** 可解释性：每条加分 / 判级来源 */
  signals: string[];
  /** 若硬规则触发，记录原因（否则 undefined） */
  override?: string;
}

export interface ScorableArticle {
  title: string;
  category?: string;
  subcategory?: string;
  sourceId?: string;
  summary?: string;
  url?: string;
  tags?: string[];
  locale?: string;
}

// ---------------------------------------------------------------------------
// 1) 业务线词表（权重 = 对分行的核心程度；行长5分钟核心线权重最高）
// ---------------------------------------------------------------------------
interface LineRule {
  line: string;
  weight: number;
  kws: string[];
}

const BUSINESS_LINES: LineRule[] = [
  // 信贷 = 房贷 / 消费贷 / 小微贷 三类（2026-08-29 用户拍板：住房金融属信贷子集，不再单列一条线）
  { line: "信贷", weight: 1.0, kws: ["房贷", "按揭", "抵押贷", "个贷", "住房金融", "房地产信贷", "楼市", "购房", "房抵", "存量房贷", "信托", "房地产", "地产", "消费贷", "小微贷", "小微金融", "小微", "普惠", "经营贷", "信贷", "贷款", "授信", "放贷", "利率", "降息", "降准", "LPR"] },
  { line: "客群", weight: 0.9, kws: ["客群", "零售", "获客", "新客", "拓客", "拉新", "开户", "客户增长", "客户数", "客户经营", "客群经营", "零售转型", "收单", "收单商户", "商户拓展", "社零", "居民消费", "消费回暖", "居民收入", "人口", "就业", "薪资", "工资", "县域", "下沉"] },
  { line: "财富", weight: 0.9, kws: ["财富", "理财", "基金", "保险", "黄金", "存款", "资管", "AUM", "贵金属", "债基"] },
  { line: "私行", weight: 0.9, kws: ["私行", "家族", "高净值", "企业主", "家族信托", "家族办公室"] },
  { line: "信用卡", weight: 0.7, kws: ["信用卡", "借记卡", "刷卡"] },
  { line: "代发", weight: 0.7, kws: ["代发", "代发工资", "工资代发"] },
  { line: "养老", weight: 0.6, kws: ["养老", "养老金融", "个人养老金"] },
  { line: "监管合规", weight: 0.85, kws: ["罚", "处罚", "违规", "整改", "通报", "不良", "逾期", "催收", "风险敞口", "压降", "踩雷", "爆雷"] },
  { line: "竞对动态", weight: 0.7, kws: ["竞对", "他行", "工行", "建行", "中行", "农行", "邮储", "兴业", "平安银行", "中信", "民生", "光大", "华夏", "浦发", "国有大行", "股份行"] },
  { line: "政银合作", weight: 0.6, kws: ["政银", "政务", "银政", "财政补贴"] },
  { line: "科技金融", weight: 0.6, kws: ["科技金融", "数字人民币", "金融科技", "数字银行"] },
  { line: "跨境", weight: 0.5, kws: ["跨境", "外汇", "结售汇", "出海", "离岸"] },
];

/** 行长5分钟核心线（select-top.ts:19 DEPT_TAGS；2026-08-29 起住房金融并入信贷） */
const CORE_LINES = ["信贷", "客群", "财富", "私行"];

/**
 * 外埠区域性银行（他省城商行 / 农商行）：对广州分行只有「参考」意义，没有「借鉴」意义。
 * 2026-08-29 用户：客户是广州的股份行领导，其他区域的银行（如江苏银行）不具本地执行关联，
 * 不该与广州本地或全国性银行的信号同分、更不该占必读名额。
 * 注：国有大行与全国性股份行（工建中农交邮储、招商中信兴业浦发民生光大平安华夏广发浙商等）
 * 在广州同城竞争，属全国性信号，不降权。
 */
const FOREIGN_REGIONAL_BANK_RE =
  /江苏银行|宁波银行|南京银行|杭州银行|北京银行|上海银行|成都银行|长沙银行|青岛银行|重庆银行|郑州银行|西安银行|苏州银行|齐鲁银行|兰州银行|厦门银行|贵阳银行|江西银行|九江银行|中原银行|河北银行|徽商银行|盛京银行|大连银行|哈尔滨银行|天津银行|威海银行|日照银行|潍坊银行|烟台银行|东营银行|济宁银行|德州银行|枣庄银行|莱商银行|临商银行|湖北银行|汉口银行|无锡银行|常熟银行|张家港行|江阴银行|苏农银行|紫金银行|渝农商行|沪农商行|青农商行|瑞丰银行/;

// ---------------------------------------------------------------------------
// 2) 权威度：谁发布的（央行/金监总局/国务院 > 省市政府 > 协会/银行 > 媒体 > 未知）
// ---------------------------------------------------------------------------
const TOP_ISSUER_RE =
  /央行|人民银行|国家金融监督管理总局|金融监管总局|金监总局|国务院|财政部|发改委|国资委|住建部|证监会|外汇局|美联储/;
const HIGH_ISSUER_RE = /省(政府|委|厅|金融监管局)|市(政府|委)|银保监|金融监管局/;
const ORG_ISSUER_RE = /协会|总行|银行业/;

function issuerScore(text: string): number {
  if (TOP_ISSUER_RE.test(text)) return 0.95;
  if (HIGH_ISSUER_RE.test(text)) return 0.8;
  if (ORG_ISSUER_RE.test(text)) return 0.6;
  return 0;
}

/** 源 id → 权威度（媒体只是转述，权威度低于发文方） */
const SOURCE_AUTHORITY: Record<string, number> = {
  "govcn-policy": 0.95,
  govcn: 0.95,
  pbc: 0.95,
  cnfin: 0.6,
  stcn: 0.6,
  "21jingji-finance": 0.55,
  "sina-finance": 0.5,
  "sina-bank": 0.5,
  guancha: 0.5,
  "eastmoney-a": 0.5,
  "eastmoney-hk": 0.5,
};

function sourceScore(sourceId?: string, subcategory?: string): number {
  let s = SOURCE_AUTHORITY[sourceId ?? ""] ?? 0.42;
  if (subcategory === "cn-policy" || subcategory === "govcn-policy") s = Math.max(s, 0.9);
  if (subcategory === "cn-finance") s = Math.max(s, 0.6);
  return s;
}

// ---------------------------------------------------------------------------
// 3) 可行动性：这条能不能让分行「做点什么」
// ---------------------------------------------------------------------------
const POLICY_ACTION_RE =
  /新规|发文|意见|办法|通知|印发|出台|发布|延长|下调|上调|降息|降准|贴息|重组|宽松|收紧|扩容|提额|试点|调整|落地|实施|监管/;
const RISK_ACTION_RE = /罚|处罚|违规|整改|通报|不良|逾期|违约|风险敞口/;
const DATA_CONTEXT_RE = /数据|统计|同比|环比|回落|增长|下跌|大涨|大跌|震荡|分析|解读|回顾|展望|波动/;
// 软资讯：获奖/榜单/出口 之外，重点是**银行自家营销活动与 PR 通告**
// （2026-08-29 用户：「工银财富季」这类活动启动通告对广州分行无执行关联，不配进必读）。
// 这类标题不含可执行的政策/市场信号，可行动性压到最低档，避免挤占条线名额。
const SOFT_RE =
  /获奖|榜单|排名|论坛|峰会|出口|签约|发布产品|活动正式启动|活动启动|启动仪式|开业|庆典|公益|赞助|冠名|招募|报名|年会|发布会|购物节|品牌日|财富季|营销|宣传周|直播|启幕|来袭/;

function actionabilityScore(text: string): { score: number; type: string } {
  if (POLICY_ACTION_RE.test(text)) return { score: 0.9, type: "policy_action" };
  if (RISK_ACTION_RE.test(text)) return { score: 0.85, type: "risk_action" };
  if (DATA_CONTEXT_RE.test(text)) return { score: 0.4, type: "data_context" };
  if (SOFT_RE.test(text)) return { score: 0.2, type: "soft" };
  return { score: 0.5, type: "default" };
}

// ---------------------------------------------------------------------------
// 4) 地域贴近度：广州/南沙 > 广东/大湾区 > 全国/国际
// ---------------------------------------------------------------------------
const GZ_RE = /广州|穗|天河|海珠|琶洲|南沙|番禺|越秀|黄埔|花都|增城|从化|白云/;
const GD_RE = /广东|大湾区|珠三角/;

function localityScore(text: string, locale?: string): number {
  if (GZ_RE.test(text)) return 1.0;
  if (GD_RE.test(text)) return 0.9;
  if (locale === "gz") return 0.9;
  return 0;
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------
export function scoreBranchRelevance(article: ScorableArticle): BranchRelevance {
  const text = [article.title, article.summary ?? "", article.subcategory ?? ""].join(" ");
  // 地域判定**只看标题与子分类**，绝不含 summary：
  // 我们自己生成的摘要几乎每条都写「对广州分行…有影响」，若纳入会把"广州"注入每一条，
  // 使地域维度彻底失真（2026-08-29 实测：江苏银行因摘要含广州被误判为本地）。
  const locText = [article.title, article.subcategory ?? ""].join(" ");
  const signals: string[] = [];

  // 业务线匹配
  const matched = BUSINESS_LINES.filter((r) => r.kws.some((kw) => text.includes(kw)))
    .map((r) => ({ line: r.line, weight: r.weight }))
    .sort((a, b) => b.weight - a.weight);
  const lineW = matched[0]?.weight ?? 0;
  const businessLines = matched.slice(0, 3).map((m) => m.line);
  if (matched.length) signals.push(`业务线[${businessLines.join("/")}] 权重${lineW}`);

  // 权威度
  const authW = Math.max(issuerScore(text), sourceScore(article.sourceId, article.subcategory));
  if (authW >= 0.95) signals.push("权威发文方(央行/金监总局/国务院级) +0.95");
  else if (authW >= 0.8) signals.push("地方政府/监管局级 +0.8");
  else if (authW >= 0.6) signals.push("权威媒体/政策源 +0.6");

  // 可行动性（国家核心监管「发文/出政策」本身即强行动信号；讲话/数据不构成）
  const baseAct = actionabilityScore(text);
  const issuerTop = issuerScore(text) >= 0.95;
  const actW =
    issuerTop && baseAct.type === "policy_action" ? Math.max(baseAct.score, 0.8) : baseAct.score;
  if (baseAct.type === "policy_action") signals.push("政策/新规动作 +0.9");
  else if (baseAct.type === "risk_action") signals.push("风险/违规动作 +0.85");
  else if (baseAct.type === "data_context") signals.push("数据解读(非动作) +0.4");
  else if (baseAct.type === "soft") signals.push("软资讯(获奖/出口等) +0.2");

  // 地域
  const locW = localityScore(locText, article.locale);
  if (locW >= 1.0) signals.push("广州本地 +1.0");
  else if (locW >= 0.9) signals.push("广东/大湾区 +0.9");

  // 综合分
  const base = Math.round(
    100 * (0.45 * lineW + 0.25 * authW + 0.2 * actW + 0.1 * locW),
  );
  // 外埠区域性银行（他省城商行/农商行）→ 仅参考意义，降权；本地(广州/广东)语境下不降
  const foreignRegional = FOREIGN_REGIONAL_BANK_RE.test(text) && locW < 0.9;
  const score = foreignRegional ? Math.round(base * 0.72) : base;
  if (foreignRegional) signals.push("外埠区域性银行（仅参考意义）降权 0.72");

  // 风险向判定
  let risk = matched.some((m) => m.line === "监管合规") || baseAct.type === "risk_action";

  let override: string | undefined;
  let tier: Tier;

  // 硬规则 A：国家核心监管政策 + 直击分行核心业务 → 必读置顶（房贷40年型）
  if (issuerTop && matched.some((m) => CORE_LINES.includes(m.line)) && actW >= 0.7) {
    override = "国家核心监管政策直击分行核心业务(信贷含房贷/消费贷/小微贷·财富·私行·客群) → 必读置顶";
    tier = "must_read";
    risk = false; // 政策机会向，非威胁
    signals.push("【硬规则A触发】必读置顶");
  }
  // 硬规则 B：广州本地监管/合规事件 → 必读(风险向)
  else if (locW >= 0.9 && matched.some((m) => m.line === "监管合规")) {
    override = "广州本地监管/合规事件 → 必读(风险向)";
    tier = "must_read";
    risk = true;
    signals.push("【硬规则B触发】风险必读");
  }
  // 常规档位：必读需「可行动」(actW>=0.6)，否则封顶为 insight（避免纯市场数据占必读位）
  else {
    const actionable = actW >= 0.6;
    if (score >= 68 && actionable) tier = "must_read";
    else if (score >= 45) tier = "insight";
    else if (score >= 25) tier = "context";
    else tier = "drop";
  }

  // 营销活动 / PR 通告（soft）对分行无执行关联 → 最高只到 context，不进必读与商机
  // （2026-08-29 用户：「工银财富季」这类活动启动通告对广州分行无逻辑/执行关联，不配进必读）
  if (baseAct.type === "soft" && (tier === "must_read" || tier === "insight")) {
    tier = "context";
    signals.push("营销/活动类通告 → 不进必读与商机");
  }
  // 外埠区域性银行：只作参考，不占必读名额（可进商机当参考）
  if (foreignRegional && tier === "must_read") {
    tier = "insight";
    signals.push("外埠区域性银行 → 仅参考意义，不进必读");
  }

  const finalScore = override ? Math.max(score, tier === "must_read" ? 84 : score) : score;

  const vertical: Vertical = risk
    ? "risk"
    : tier === "must_read"
      ? "must_read"
      : tier === "insight"
        ? "insight"
        : tier === "context"
          ? "context"
          : "drop";

  return {
    score: finalScore,
    tier,
    vertical,
    businessLines,
    authority: authW,
    actionability: actW,
    locality: locW,
    risk,
    ...(foreignRegional ? { foreignRegional: true } : {}),
    signals,
    override,
  };
}

// ---------------------------------------------------------------------------
// 批量排序（供人工抽检 / 接入管线）
// ---------------------------------------------------------------------------
export interface RankedArticle {
  article: ScorableArticle;
  relevance: BranchRelevance;
}

export function rankByRelevance(articles: ScorableArticle[]): RankedArticle[] {
  return articles
    .map((a) => ({ article: a, relevance: scoreBranchRelevance(a) }))
    .sort((x, y) => {
      if (y.relevance.score !== x.relevance.score) return y.relevance.score - x.relevance.score;
      return y.relevance.authority - x.relevance.authority;
    });
}
