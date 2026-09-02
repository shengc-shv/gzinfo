/**
 * 内容记忆与去重（Content Memory & De-duplication）
 * ============================================================================
 * 解决的问题：
 *   每日抓取的新闻源高度重复。同一事件（如「房贷期限从 30 年延长至 40 年」）
 *   会在未来数周持续产生大量报道。若连续多天口播同一新闻，行长会觉得系统
 *   不专业；但完全屏蔽后续报道，又会漏掉真实进展（如政策落地、细则出台、
 *   银行跟进、数据验证）。
 *
 * 设计要点：
 *   1. 事件级记忆：基于「事件指纹 + 主题标签」去重，而非文本完全匹配；
 *      记忆库持久化到 data/event-memory.json（随 CI 归档提交，跨运行生效）。
 *   2. 判定规则：量化「信息增量」，区分「新进展（progress）」与「重复表述（duplicate）」。
 *   3. 冷却与衰减：按事件类型给冷却期，冷却期随时间衰减；重大事件可打破冷却。
 *   4. 角度轮换：必须再次播报时，强制切换到未用过的切入角度。
 *   5. 板块差异化：hero / must_read / insights / risk 四板块参数互不相同。
 *   6. 兜底：候选全命中去重时分三级放宽，绝不产出空板块。
 *
 * 纯函数层（不碰 fs，便于单测）；持久化见 ./store.ts。
 */

import { eventFingerprint, dice, titleBigrams } from "../ingest/dedup-similar";
// 仅引入运行时函数；broadcast-time 对本文件只做 `import type`，无循环依赖
import { formatBroadcastAt } from "./broadcast-time";

// ---------------------------------------------------------------------------
// 1) 类型定义
// ---------------------------------------------------------------------------

/** 四个记忆板块（与口播/展示板块一一对应）。 */
export type MemorySection = "hero" | "must_read" | "insights" | "risk";

/**
 * 切入角度（去重后重播时必须轮换，避免表述雷同）。
 * 顺序即默认轮换顺序：从「政策本身」逐步推进到「客户该做什么」。
 */
export type EventAngle =
  | "政策变化"
  | "市场反应"
  | "受影响人群"
  | "数据验证"
  | "同业动作"
  | "客户行动";

/** 角度轮换顺序表（务必与 EventAngle 一致）。 */
export const ANGLE_ORDER: EventAngle[] = [
  "政策变化",
  "市场反应",
  "受影响人群",
  "数据验证",
  "同业动作",
  "客户行动",
];

/** 每个角度的写作指引（注入 LLM 提示词，让重播有明确的新视角）。 */
export const ANGLE_GUIDE: Record<EventAngle, string> = {
  政策变化: "只讲政策/规则本身变了什么、何时生效、适用范围，不评价影响",
  市场反应: "讲市场与机构的第一反应（股价、利率、报价、同业表态），少复述政策条文",
  受影响人群: "讲哪一类客户/客群被直接影响，他们的处境与需求发生了什么变化",
  数据验证: "用最新数据验证进展（规模、增速、占比、环比），用数字说话",
  同业动作: "讲同业/他行已经怎么做了（产品、定价、流程），突出竞争位次",
  客户行动: "讲分行与该客群当下可执行的动作（联系谁、推什么、什么时点）",
};

/** 事件类型 → 决定基础冷却期（重大政策类冷却更长）。 */
export type EventKind = "policy" | "enforcement" | "ipo" | "market" | "local" | "generic";

/** 判定结论。 */
export type MemoryVerdict =
  /** 记忆库中没有该事件 → 直接放行。 */
  | "new"
  /** 有实质新进展 → 放行（可不换角度）。 */
  | "progress"
  /** 增量有限、可重播，但**必须换角度**（板块拥挤时优先被降级）。 */
  | "refresh"
  /** 处于冷却期且增量不足以打破冷却 → 过滤。 */
  | "cooldown"
  /** 纯重复表述（无信息增量）→ 过滤。 */
  | "duplicate"
  /** 播报次数已达该板块上限且无重大进展 → 过滤。 */
  | "exhausted";

/** 单次判定结果（可解释：每条都带 reason，便于日志与回归测试）。 */
export interface MemoryDecision {
  section: MemorySection;
  /** 候选标题（日志/测试用）。 */
  title: string;
  verdict: MemoryVerdict;
  /** 是否放行（new/progress/refresh = 放行）。 */
  allow: boolean;
  /** 0-1 信息增量。 */
  novelty: number;
  /** 距上次播报天数；新事件为 undefined。 */
  daysSince?: number;
  /** 冷却期（天）；新事件为 undefined。 */
  cooldownDays?: number;
  /** 本次判定使用的增量门槛。 */
  threshold?: number;
  /** 匹配到的历史事件 id；新事件为 undefined。 */
  eventId?: string;
  /** 命中事件的历史播报次数（含本次前的累计）。 */
  broadcastCount?: number;
  /** refresh/progress 重播时强制要求切换到的角度。 */
  requiredAngle?: EventAngle;
  /** 人类可读原因。 */
  reason: string;
  /** 是否因「重大事件打破冷却」而放行。 */
  brokeCooldown?: boolean;
}

/** 单条播报留痕（同一事件保留最近若干条，用于增量计算与审计）。 */
export interface BroadcastSample {
  /** YYYY-MM-DD */
  date: string;
  section: MemorySection;
  title: string;
  url?: string;
  novelty?: number;
  angle?: EventAngle;
  /** 播报内容全文（标题 + 正文），用于**同日内**的信息增量计算。 */
  text?: string;
  /** 播报内容的事实锚点，用于**同日内**的信息增量计算。 */
  facts?: string[];
  /** 分行相关性分（0-100），透传给长期记忆以计算峰值分 peakScore（重大事件长期保留）。 */
  score?: number;
  /**
   * 播报时刻（ISO 8601 完整时间戳，带时区偏移，默认北京时间 +08:00）。
   *
   * 形如 `2026-09-02T23:39:47+08:00`。与 `date`（仅 YYYY-MM-DD）互补：
   * date 用于「哪天播的」的冷却计算，broadcastAt 用于「当天几点播的」的溯源，
   * 使以 9:00 为界区分**客户演示数据**与**测试/验证数据**成为可能，
   * 并支持按时间段查看、导出与清理（2026-09-02 需求）。
   *
   * 设为可选：历史记录无此字段时不影响任何既有读取逻辑（向后兼容）。
   */
  broadcastAt?: string;
}

/** 事件记忆条目。 */
export interface EventRecord {
  /** 稳定事件 id（首次创建时由锚点生成，后续不因措辞变化而改变）。 */
  id: string;
  /** 主题标签（如「住房金融」「利率流动性」），多值。 */
  topicTags: string[];
  /** 事件指纹锚点集合（关键词 + #数字锚点）。 */
  anchors: string[];
  /** 事件类型 → 冷却期。 */
  kind: EventKind;
  /** 首次播报日期 YYYY-MM-DD。 */
  firstBroadcastAt: string;
  /** 最近播报日期 YYYY-MM-DD。 */
  lastBroadcastAt: string;
  /** 累计播报次数。 */
  broadcastCount: number;
  /** 曾在哪些板块播报过。 */
  sections: MemorySection[];
  /** 已用过的切入角度（按顺序）。 */
  anglesUsed: EventAngle[];
  /** 最近播报留痕（上限 MAX_SAMPLES，FIFO）。 */
  samples: BroadcastSample[];
  /** 已播报过的内容原文（标题+摘要）集合，用于计算 bigram 增量。 */
  broadcastedTexts: string[];
  /** 已播报过的事实锚点（数字/机构/进展动词），用于计算事实增量。 */
  broadcastedFacts: string[];
  /** 历史最高分行相关性分（用于「重大事件打破冷却」）。 */
  peakScore: number;
}

/** 记忆库落盘结构。 */
export interface EventMemoryStore {
  version: 1;
  updatedAt?: string;
  /**
   * 长期记忆：**只含「昨天及更早」**的播报（今天的播报存在 today 里）。
   */
  events: Record<string, EventRecord>;
  /**
   * 当天播报暂存区（每次运行开始即清空重写）。
   *
   * 为什么要有这一层（幂等性关键）：
   * CI 一天会跑很多次（daily.yml 在北京 6-8 点每 15 分钟触发一次）。
   * 若第一次运行就把当天播报写进长期记忆，第二次运行时这些条目
   * daysSince=0，会被判定为「当日已播」而大面积过滤 → 同一天两次
   * 运行产出不一致，报告内容漂移。
   *
   * 因此当天播报只暂存在这里，**跨天时才结算进 events**（见 beginDay）。
   * 这样同一天无论跑多少次，判定输入都完全相同 → 结果稳定可复现。
   */
  today?: {
    date: string;
    entries: BroadcastSample[];
  };
}

/** 候选条目（由调用方从 exec 产出或两天池构造）。 */
export interface MemoryCandidate {
  title: string;
  /** 用于增量计算的正文（标题 + why/impact/摘要）。 */
  text?: string;
  url?: string;
  /** 分行相关性分（0-100），可选；用于打破冷却的重要性判定。 */
  score?: number;
  /** 是否命中评分器硬规则（如房贷40年）→ 可打破冷却。 */
  override?: boolean;
  /** 评分档位，可选。 */
  tier?: "must_read" | "insight" | "context" | "drop";
}

// ---------------------------------------------------------------------------
// 2) 板块差异化参数（要求 5）
// ---------------------------------------------------------------------------

/**
 * 四板块的重复容忍度与去重优先级（互不相同，可参数化覆盖）。
 *
 * 设计取向：
 *  - hero（今日定调）：一天只有一句话，重复最刺眼 → 最严格。
 *    不允许「换角度重播」式刷新（allowRefresh=false），必须有实质进展。
 *  - must_read（今日必读）：宏观信号，允许多次，但需进展或新角度。
 *  - insights（商机洞察）：商机本就需要持续跟进，容忍度更高。
 *  - risk（风险提示）：风险不因「说过」而消失，只要有新证据就要继续预警
 *    → 容忍度最高，但仍要求 evidence 有新事实（newFacts > 0）。
 *
 * dedupePriority：数值越小越先被保护（兜底放宽时，高优先级板块的候选
 * 先被释放）。cooldownScale：在事件基础冷却期上缩放。
 */
export interface SectionPolicy {
  /** 冷却期缩放系数（× 事件基础冷却期）。 */
  cooldownScale: number;
  /** 冷却结束后的基础增量门槛。 */
  noveltyBase: number;
  /** 门槛下限（衰减到此为止，防止时间久了无脑放行）。 */
  noveltyFloor: number;
  /** 冷却期内打破冷却所需的高增量门槛。 */
  noveltyToBreak: number;
  /** 同一事件在同一板块的累计播报上限（超出需 noveltyToBreak 才放行）。 */
  maxRepeat: number;
  /** 去重优先级（越小越优先保留）。 */
  dedupePriority: number;
  /** 是否允许「换角度重播」（refresh 级放行）。 */
  allowRefresh: boolean;
  /** 兜底时该板块的最低保底条数。 */
  minKeep: number;
}

export const SECTION_POLICY: Record<MemorySection, SectionPolicy> = {
  hero: {
    cooldownScale: 1.5,
    noveltyBase: 0.45,
    noveltyFloor: 0.22,
    noveltyToBreak: 0.6,
    maxRepeat: 2,
    dedupePriority: 1,
    allowRefresh: false,
    minKeep: 1,
  },
  must_read: {
    cooldownScale: 1.0,
    noveltyBase: 0.3,
    noveltyFloor: 0.12,
    noveltyToBreak: 0.45,
    maxRepeat: 3,
    dedupePriority: 2,
    allowRefresh: true,
    minKeep: 2,
  },
  insights: {
    cooldownScale: 0.7,
    noveltyBase: 0.22,
    noveltyFloor: 0.08,
    noveltyToBreak: 0.35,
    maxRepeat: 4,
    dedupePriority: 3,
    allowRefresh: true,
    minKeep: 1,
  },
  risk: {
    cooldownScale: 0.5,
    noveltyBase: 0.15,
    noveltyFloor: 0.05,
    noveltyToBreak: 0.25,
    maxRepeat: 5,
    dedupePriority: 4,
    allowRefresh: true,
    minKeep: 1,
  },
};

/** 事件类型 → 基础冷却期（天）。重大政策类最长。 */
export const BASE_COOLDOWN_DAYS: Record<EventKind, number> = {
  policy: 6,
  enforcement: 7,
  ipo: 5,
  market: 3,
  local: 5,
  generic: 4,
};

/** 冷却期上限（天）：无论重复多少次，不超过此值。 */
export const MAX_COOLDOWN_DAYS = 14;
/** 播报留痕保留条数。 */
const MAX_SAMPLES = 6;
/** 已播报文本保留条数（用于 bigram 增量计算）。 */
const MAX_TEXTS = 8;

// ---------------------------------------------------------------------------
// 3) 文本特征抽取
// ---------------------------------------------------------------------------

/** 归一化：只保留字母/数字（中文保留），小写化。 */
export function normText(s: string): string {
  return (s ?? "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

/** 候选文本（标题 + 正文），去空。 */
function candidateText(c: MemoryCandidate): string {
  return [c.title, c.text ?? ""].filter(Boolean).join(" ").trim();
}

/**
 * 事实锚点抽取（信息增量的主要判据）。
 *
 * 三类，分别加前缀区分：
 *  - `#数字锚点`：40年 / 1.5% / 5000元 / 38万亿 —— 政策力度、规模数据
 *  - `!进展动词`：受理 / 问询 / 过会 / 落地 / 处罚 / 下调 —— 事件所处阶段
 *  - `@主体机构`：央行 / 金融监管总局 / 广州 / 招行 —— 涉及主体
 *
 * 为什么用事实锚点而非纯文本相似度：同一事件的不同报道，措辞高度雷同
 * （Dice 常 > 0.8），但只有**数字/阶段/主体**的变化才构成真正的「新进展」。
 */
const NUM_RE =
  /\d+(?:\.\d+)?\s*(?:个百分点|万亿元|万亿|亿元|万元|(?:个)?基点|bp|BP|年|个月|月|日|%|％|元|倍|‰|家|户|笔)/g;

const STAGE_WORDS = [
  "受理", "问询", "过会", "提交注册", "注册生效", "辅导备案", "招股", "申购", "敲钟",
  "批复", "落地", "实施", "施行", "试点", "扩围", "首单", "出台", "印发", "发布",
  "约谈", "处罚", "罚款", "通报", "整改", "下调", "上调", "降息", "降准", "加息",
  "受理申请", "正式生效", "窗口指导",
];

const ORG_WORDS = [
  "央行", "人民银行", "金融监管总局", "金监总局", "国务院", "证监会", "发改委",
  "财政部", "住建部", "外汇局", "美联储", "交易所", "北交所", "科创板", "创业板",
  "广州", "广东", "南沙", "大湾区",
];

export function extractFacts(text: string): string[] {
  const t = text ?? "";
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(t))) out.add("#" + m[0].replace(/\s+/g, ""));
  for (const w of STAGE_WORDS) if (t.includes(w)) out.add("!" + w);
  for (const w of ORG_WORDS) if (t.includes(w)) out.add("@" + w);
  return [...out];
}

/** 主题标签规则表（锚点 → 标签），用于「同一主题」的软去重与主题记忆。 */
const THEME_RULES: Array<{ tag: string; kws: string[] }> = [
  {
    tag: "住房金融",
    kws: ["房贷", "按揭", "公积金", "购房", "楼市", "住房", "房抵", "存量房贷", "商品房", "抵押贷"],
  },
  { tag: "利率流动性", kws: ["LPR", "降息", "降准", "利率", "贴息", "存款"] },
  {
    tag: "监管合规",
    kws: ["罚", "处罚", "违规", "整改", "通报", "不良", "逾期", "违约", "爆雷", "约谈"],
  },
  {
    tag: "资本市场",
    kws: ["IPO", "上市", "过会", "注册", "招股", "申购", "敲钟", "北交所", "科创板", "创业板"],
  },
  { tag: "财富管理", kws: ["理财", "基金", "黄金", "保险", "资管", "信托", "债基", "ETF", "REITs"] },
  { tag: "私行客群", kws: ["私行", "高净值", "家族信托", "客群", "获客", "新客", "开户"] },
  { tag: "消费信贷", kws: ["消费贷", "经营贷", "小微", "普惠", "信用卡"] },
  { tag: "广州本地", kws: ["广州", "广东", "大湾区", "南沙", "粤"] },
  { tag: "科技金融", kws: ["科技金融", "数字人民币", "金融科技"] },
];

/** 主题标签抽取（可能为空数组）。 */
export function extractTopicTags(text: string): string[] {
  const t = text ?? "";
  const tags: string[] = [];
  for (const r of THEME_RULES) {
    if (r.kws.some((k) => t.includes(k))) tags.push(r.tag);
  }
  return tags;
}

/** 事件类型判定（顺序敏感：越具体越靠前）。 */
export function classifyKind(text: string): EventKind {
  const t = text ?? "";
  if (STAGE_WORDS.some((w) => ["受理", "问询", "过会", "注册", "辅导备案", "招股", "申购", "敲钟"].includes(w) && t.includes(w)))
    return "ipo";
  if (t.includes("IPO")) return "ipo";
  if (/(处罚|罚款|违规|整改|通报|约谈|不良|爆雷|违约)/.test(t)) return "enforcement";
  if (/(国务院|央行|人民银行|金融监管总局|金监总局|证监会|发改委|财政部|住建部|外汇局|政策|新规|办法|通知|意见|试点|施行|条例|细则)/.test(t))
    return "policy";
  if (/(广州|广东|南沙|大湾区)/.test(t)) return "local";
  if (/(股|指数|板块|涨|跌|行情|收评|资金|北向)/.test(t)) return "market";
  return "generic";
}

// ---------------------------------------------------------------------------
// 4) 事件指纹与匹配
// ---------------------------------------------------------------------------

/** 候选的事件锚点集合（复用展示层同一套指纹，保证口径一致）。 */
export function candidateAnchors(c: MemoryCandidate): string[] {
  return [...eventFingerprint(candidateText(c))];
}

/**
 * 生成稳定事件 id。
 *
 * 取锚点集合中「最具区分度」的若干锚点（数字锚点 > 关键词锚点），
 * 排序后拼接。首次创建后 id 不再改变——后续同事件报道即使新增锚点，
 * 也只是合并进 record.anchors，不改 id（否则记忆会断裂）。
 */
export function makeEventId(anchors: string[]): string {
  const nums = anchors.filter((a) => a.startsWith("#")).sort();
  const kws = anchors.filter((a) => !a.startsWith("#")).sort();
  const picked = [...nums.slice(0, 2), ...kws.slice(0, 3)];
  if (picked.length === 0) return "";
  return picked.join("|");
}

/** 两个锚点集合的 Jaccard 相似度。 */
function anchorJaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 两个标签数组的共享数量。 */
function sharedTags(a: string[], b: string[]): number {
  const B = new Set(b);
  let n = 0;
  for (const x of a) if (B.has(x)) n++;
  return n;
}

/**
 * 记录结构完整性校验（2026-09-02 复审修复·高优先级）。
 *
 * 背景：单条记录损坏（samples/anchors/topicTags 缺失或类型错误）会触发
 * `record.samples is not iterable`，异常冒泡到集成点 try/catch 后被
 * 「放行原产出」吞掉 → **整个记忆去重静默失效**，且因损坏记录被持续写回
 * 而**永不自愈**。用户只会感觉「又开始重复播报了」，日志仅一行 warn。
 *
 * 策略：损坏记录**逐条跳过**（不参与匹配），其余记录照常工作；
 * 配合 store.ts 落盘前清理，损坏记录不再写回 → 具备自愈能力。
 */
export function isUsableRecord(rec: unknown): rec is EventRecord {
  if (!rec || typeof rec !== "object") return false;
  const r = rec as Partial<EventRecord>;
  // 仅校验「会引发崩溃」的必填结构；数值/日期字段另行归一化，不因类型瑕疵丢弃整个事件
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    Array.isArray(r.samples) &&
    Array.isArray(r.anchors) &&
    Array.isArray(r.topicTags)
  );
}

/**
 * 矫正记录中的数值/日期字段类型，避免脏值污染计算。
 *
 * 为什么是「归一化」而非「丢弃」：peakScore 为字符串这类瑕疵只是局部脏值，
 * 整条事件丢弃会让它被遗忘（重复播报），代价大于收益；但若放任不管，
 * `Math.max("high", 0)` 会产出 NaN，进而让「重大事件双倍保留」判定恒假。
 */
export function normalizeRecord(rec: EventRecord): EventRecord {
  const out: EventRecord = { ...rec };
  if (!Number.isFinite(out.peakScore)) out.peakScore = 0;
  if (!Number.isFinite(out.broadcastCount) || (out.broadcastCount ?? 0) < 1) {
    out.broadcastCount = 1;
  }
  if (!Array.isArray(out.broadcastedTexts)) out.broadcastedTexts = [];
  if (!Array.isArray(out.broadcastedFacts)) out.broadcastedFacts = [];
  if (!Array.isArray(out.sections)) out.sections = [];
  if (!Array.isArray(out.anglesUsed)) out.anglesUsed = [];
  if (typeof out.lastBroadcastAt !== "string") {
    out.lastBroadcastAt = typeof out.firstBroadcastAt === "string" ? out.firstBroadcastAt : "";
  }
  if (typeof out.firstBroadcastAt !== "string") out.firstBroadcastAt = out.lastBroadcastAt;
  return out;
}

/** 剔除结构损坏的事件记录，并对保留记录做数值归一化（损坏者自愈式丢弃）。 */
export function sanitizeEvents(
  events: Record<string, EventRecord> | undefined | null,
): Record<string, EventRecord> {
  if (!events || typeof events !== "object" || Array.isArray(events)) return {};
  const out: Record<string, EventRecord> = {};
  for (const [id, rec] of Object.entries(events)) {
    if (isUsableRecord(rec)) out[id] = normalizeRecord(rec);
  }
  return out;
}

/** 与某条历史记录的最高标题 Dice（与最近若干条样本比）。 */
function bestTitleDice(title: string, record: EventRecord): number {
  const g = titleBigrams(title);
  let best = 0;
  // 防御：samples 非数组或元素异常时退化为 0，不抛错
  const samples = Array.isArray(record.samples) ? record.samples : [];
  for (const s of samples) {
    if (!s || typeof s.title !== "string") continue;
    const d = dice(g, titleBigrams(s.title));
    if (d > best) best = d;
  }
  return best;
}

/** 合并阈值：硬信号（锚点 Jaccard / 标题 Dice）达此值即视为同一事件。 */
const MATCH_THRESHOLD = 0.5;
/**
 * 硬信号软命中置信线：锚点/标题相似度落在区间 [HARD_CORROB, MATCH_THRESHOLD)
 * 且共享 ≥2 个主题标签时，才升格为合并（兜底「同一主题不同切入」的软重复）。
 */
const HARD_CORROB = 0.3;
/**
 * 标签软命中辅助值：仅共享 ≥2 个主题标签、无硬信号支撑时给出的相似度，
 * 低于合并阈 → 不单独触发合并，避免把不同事件（如「存量房贷利率下调」vs
 * 「公积金贷款额度上调」）按宽泛标签串味误并。
 */
const TAG_SOFT_BOOST = 0.35;
/** 历史无事实锚点时，newFactRatio 封顶值（防 novelty 虚高误判 progress）。 */
const NO_FACT_BASELINE_CAP = 0.5;

/**
 * 把「当天暂存区」的播报聚类成伪事件记录，供判定期统一匹配。
 *
 * 用途：同一次运行内的板块内去重（如 LLM 把同一事件拆成两条必读）——
 * 第二条必须能匹配到第一条，否则会出现「同一天、同一板块、同一事件两条」。
 */
function todayPseudoRecords(store: EventMemoryStore): Array<{ id: string; record: EventRecord }> {
  const entries = store.today?.entries ?? [];
  if (entries.length === 0) return [];
  const clusters: BroadcastSample[][] = [];
  const reps: string[][] = []; // 每簇代表条目的锚点集合
  for (const e of entries) {
    const text = e.text || e.title;
    const anchors = [...eventFingerprint(text)];
    let placed = false;
    for (let i = 0; i < clusters.length; i++) {
      const aj = anchorJaccard(anchors, reps[i]);
      const td = dice(titleBigrams(e.title), titleBigrams(clusters[i][0].title));
      if (aj >= MATCH_THRESHOLD || td >= MATCH_THRESHOLD) {
        clusters[i].push(e);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([e]);
      reps.push(anchors);
    }
  }
  return clusters.map((c, i) => {
    const texts = c.map((s) => s.text || s.title);
    const facts = [...new Set(c.flatMap((s) => s.facts ?? []))];
    const angles = [...new Set(c.map((s) => s.angle).filter(Boolean) as EventAngle[])];
    const first = c[0];
    const rec: EventRecord = {
      id: `today#${i}`,
      topicTags: [...new Set(c.flatMap((s) => extractTopicTags(s.text || s.title)))],
      anchors: [...new Set(c.flatMap((s) => [...eventFingerprint(s.text || s.title)]))],
      kind: classifyKind(texts.join(" ")),
      firstBroadcastAt: first.date,
      lastBroadcastAt: first.date,
      broadcastCount: 1,
      sections: [...new Set(c.map((s) => s.section))],
      anglesUsed: angles,
      samples: c,
      broadcastedTexts: texts,
      broadcastedFacts: facts,
      peakScore: 0,
    };
    return { id: rec.id, record: rec };
  });
}

/**
 * 在记忆库中查找与候选匹配的事件。
 *
 * 查找顺序：**当天暂存区优先 → 长期记忆**。
 * 当天优先是为了让「同一次运行内已播过」成为最强信号（板块内去重）。
 *
 * 匹配规则（硬信号优先，标签仅作辅助）：
 *  1. 锚点 Jaccard —— 抓「同事件不同措辞」（如「住房贷款…40年」vs「房贷…40年」）
 *  2. 标题 Dice    —— 抓「媒体改写通稿」这类措辞近似的重复
 *  3. 主题标签共享 ≥2 —— 弱辅助信号：仅当硬信号已具一定置信（≥ HARD_CORROB）时
 *     才抬到合并阈（兜底「同一主题不同切入」）；单独出现不触发合并，防误并。
 */
export function findMatchingEvent(
  cand: MemoryCandidate,
  store: EventMemoryStore,
): { id: string; record: EventRecord; similarity: number; source: "today" | "events" } | null {
  const anchors = candidateAnchors(cand);
  const tags = extractTopicTags(candidateText(cand));
  const url = cand.url;
  const score = (
    rec: EventRecord,
  ): number => {
    const samples = Array.isArray(rec.samples) ? rec.samples : [];
    if (url && samples.some((s) => s && s.url && s.url === url)) return 1;
    const aj = anchorJaccard(anchors, Array.isArray(rec.anchors) ? rec.anchors : []);
    const td = bestTitleDice(cand.title, rec);
    const st = sharedTags(tags, rec.topicTags);
    const hard = Math.max(aj, td);
    // 合并判定：
    //  - 硬信号达合并阈 → 直接合并；
    //  - 硬信号达 HARD_CORROB 且共享 ≥2 主题标签 → 软命中合并（同一主题不同切入兜底）；
    //  - 否则标签共享只给弱辅助值（TAG_SOFT_BOOST），不触发合并，防不同事件误并。
    if (hard >= MATCH_THRESHOLD) return hard;
    if (hard >= HARD_CORROB && st >= 2) return MATCH_THRESHOLD;
    return Math.max(hard, st >= 2 ? TAG_SOFT_BOOST : 0);
  };

  // 1) 当天暂存区（同一次运行内已播报）
  let bestToday: { id: string; record: EventRecord; similarity: number } | null = null;
  for (const p of todayPseudoRecords(store)) {
    const sim = score(p.record);
    if (sim >= MATCH_THRESHOLD && (!bestToday || sim > bestToday.similarity)) {
      bestToday = { id: p.id, record: p.record, similarity: sim };
    }
  }
  if (bestToday) return { ...bestToday, source: "today" };

  // 2) 长期记忆（昨天及更早）
  let best: { id: string; record: EventRecord; similarity: number } | null = null;
  for (const [id, rec] of Object.entries(store.events ?? {})) {
    // 损坏记录跳过（不使整体匹配失效）；落盘时会被 sanitizeEvents 清除 → 自愈
    if (!isUsableRecord(rec)) continue;
    const sim = score(rec);
    if (sim >= MATCH_THRESHOLD && (!best || sim > best.similarity)) {
      best = { id, record: rec, similarity: sim };
    }
  }
  return best ? { ...best, source: "events" } : null;
}

// ---------------------------------------------------------------------------
// 5) 信息增量的量化标准（要求 2）
// ---------------------------------------------------------------------------

export interface NoveltyResult {
  /** 0-1 综合信息增量。 */
  novelty: number;
  /** 新增事实锚点（相对历史已播报内容）。 */
  newFacts: string[];
  /** 新增 bigram 占比（0-1）：历史内容中未出现的二元组比例。 */
  newBigramRatio: number;
  /** 是否发生「阶段推进」（如 受理 → 过会、传闻 → 正式印发）。 */
  stageAdvance: boolean;
  /** 与历史内容的标题重复度（0-1，越高越雷同）。 */
  titleOverlap: number;
}

/**
 * 量化信息增量。
 *
 * 综合三项（加权）：
 *  - 新事实占比（权重 0.45）：数字/阶段/主体的新增 —— 最能代表「有进展」
 *  - 新 bigram 占比（权重 0.35）：表述层面的新增内容量
 *  - 阶段推进（权重 0.20）：事件生命周期往前走了一步
 * 最后按标题重复度做惩罚（措辞越雷同，增量越被压低）。
 *
 * 阈值语义（在 evaluateCandidate 中消费）：
 *  - ≥ 0.35 视为「有实质进展」
 *  - 0.15 ~ 0.35 视为「增量有限」（可重播但需换角度）
 *  - < 0.15 视为「重复表述」
 */
export function computeNovelty(cand: MemoryCandidate, record: EventRecord): NoveltyResult {
  const text = candidateText(cand);
  const facts = extractFacts(text);
  const histFacts = new Set(record.broadcastedFacts ?? []);
  const newFacts = facts.filter((f) => !histFacts.has(f));
  // 历史无事实锚点时：无基线可比对，「全部为新」不可置信——封顶到 NO_FACT_BASELINE_CAP
  // （默认 0.5），避免首播纯政策表述（抽不出事实）后，后续带事实报道的 novelty 被事实项拉满、
  // 误判 progress 放行。有基线时按真实新增占比计算（分母取 max(候选事实数, 历史事实数)）。
  const newFactRatio =
    facts.length === 0
      ? 0
      : Math.min(
          newFacts.length / Math.max(facts.length, histFacts.size, 1),
          histFacts.size === 0 ? NO_FACT_BASELINE_CAP : 1,
        );

  // bigram 增量
  const g = titleBigrams(normText(text));
  const histGrams = new Set<string>();
  for (const t of record.broadcastedTexts ?? []) {
    for (const x of titleBigrams(normText(t))) histGrams.add(x);
  }
  let novel = 0;
  for (const x of g) if (!histGrams.has(x)) novel++;
  const newBigramRatio = g.size === 0 ? 0 : novel / g.size;

  // 阶段推进：候选含进展动词，且该动词未在历史事实中出现
  const histStages = new Set([...(record.broadcastedFacts ?? [])].filter((f) => f.startsWith("!")));
  const candStages = facts.filter((f) => f.startsWith("!"));
  const stageAdvance = candStages.some((s) => !histStages.has(s));

  // 标题重复度惩罚
  const titleOverlap = bestTitleDice(cand.title, record);

  const raw =
    0.45 * clamp01(newFactRatio) + 0.35 * clamp01(newBigramRatio) + (stageAdvance ? 0.2 : 0);
  // 措辞高度雷同（Dice ≥ 0.6）时按超出部分线性压低，最低压到 55%
  const penalty = titleOverlap > 0.6 ? Math.min((titleOverlap - 0.6) / 0.4, 1) * 0.45 : 0;
  const novelty = clamp01(raw * (1 - penalty));

  return { novelty, newFacts, newBigramRatio, stageAdvance, titleOverlap };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// 6) 冷却期与衰减（要求 3）
// ---------------------------------------------------------------------------

/** YYYY-MM-DD 相差天数（b - a，纯字符串运算，规避时区）。 */
export function diffDays(a: string, b: string): number {
  const pa = a.split("-").map(Number);
  const pb = b.split("-").map(Number);
  const da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const db = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((db - da) / 86_400_000);
}

/**
 * 有效冷却期（天）。
 *
 * = 事件类型基础冷却期 × 板块缩放系数 × (1 + 0.5 × (播报次数 - 1))，上限 14 天。
 * 语义：同一件事说得越多，越要隔久一点才能再说（避免连日刷屏）。
 */
export function effectiveCooldownDays(
  record: EventRecord,
  section: MemorySection,
): number {
  const base = BASE_COOLDOWN_DAYS[record.kind] ?? BASE_COOLDOWN_DAYS.generic;
  const scale = SECTION_POLICY[section].cooldownScale;
  const repeat = Math.max(1, record.broadcastCount ?? 1);
  const grown = base * scale * (1 + 0.5 * (repeat - 1));
  return Math.min(Math.round(grown), MAX_COOLDOWN_DAYS);
}

/**
 * 衰减后的增量门槛。
 *
 * 冷却期内用 noveltyToBreak（高门槛，需足够进展才打破）；
 * 冷却结束后，门槛随「超出冷却期的天数」线性衰减，14 天后降到
 * noveltyBase 的 30%，但不低于板块下限 noveltyFloor
 * —— 即「时间越久，重播越容易被接受」，但绝不无脑放行。
 */
export function decayedThreshold(
  section: MemorySection,
  daysSince: number,
  cooldownDays: number,
): number {
  const p = SECTION_POLICY[section];
  if (daysSince < cooldownDays) return p.noveltyToBreak;
  const overdue = daysSince - cooldownDays;
  const relief = clamp01(overdue / 14);
  const relaxed = p.noveltyBase * (1 - 0.7 * relief);
  return Math.max(relaxed, p.noveltyFloor);
}

/**
 * 是否允许「打破冷却」（高重要性突发事件）。
 *
 * 三类放行：
 *  1. 命中评分器硬规则（override，如房贷40年这类必然置顶的条目）
 *  2. 档位 must_read 且相关性分 ≥ 80（重大事件）
 *  3. 风险板块：出现了新事实（风险不因「说过」而消失，有新证据就要继续预警）
 * 且统一要求 novelty ≥ 0.25 —— 纯重复不构成「突发」。
 */
export function canBreakCooldown(
  cand: MemoryCandidate,
  section: MemorySection,
  novelty: number,
  newFactsCount: number,
): boolean {
  if (novelty < 0.25) return false;
  if (cand.override === true) return true;
  if (cand.tier === "must_read" && (cand.score ?? 0) >= 80) return true;
  if (section === "risk" && newFactsCount > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 7) 角度轮换（要求 4）
// ---------------------------------------------------------------------------

/**
 * 选择下一个切入角度：优先取「尚未用过」的角度（按 ANGLE_ORDER）；
 * 全部用完后，从最早使用的角度重新开始第二轮（避免永久封死）。
 */
export function nextAngle(record: EventRecord): EventAngle {
  const used = new Set(record.anglesUsed ?? []);
  for (const a of ANGLE_ORDER) if (!used.has(a)) return a;
  // 全部用过 → 重新从最早使用的开始轮
  const first = (record.anglesUsed ?? [])[0];
  return first ?? ANGLE_ORDER[0];
}

// ---------------------------------------------------------------------------
// 8) 核心判定流程（要求 2/3/4）
// ---------------------------------------------------------------------------

/*
 * 完整判定流程（伪代码）：
 *
 *   function evaluateCandidate(cand, section, today, store):
 *     match = findMatchingEvent(cand, store)
 *     if match == null:
 *         return { verdict: "new", allow: true }              # 记忆库没有 → 放行
 *
 *     n = computeNovelty(cand, match.record)                  # 信息增量
 *     daysSince = today - record.lastBroadcastAt
 *     cooldown = effectiveCooldownDays(record, section)       # 类型 × 板块 × 次数
 *     policy   = SECTION_POLICY[section]
 *
 *     # ① 次数上限：同一板块说得太多，必须有重大进展才能再说
 *     sectionCount = 该事件在本板块的历史播报次数
 *     if sectionCount >= policy.maxRepeat and n.novelty < policy.noveltyToBreak:
 *         return { verdict: "exhausted", allow: false }
 *
 *     # ② 当日已播（跨板块共享）：定调与必读常常指向同一事件，
 *     #    这是合理呈现（一句话定调 + 展开说为什么重要），不按冷却处理；
 *     #    只要求有基本增量，否则判为同一天内的重复表述
 *     if daysSince == 0:
 *         if n.novelty >= policy.noveltyBase:
 *             return { verdict: "progress", allow: true, requiredAngle: nextAngle }
 *         if n.novelty >= policy.noveltyFloor and policy.allowRefresh:
 *             return { verdict: "refresh", allow: true, requiredAngle: nextAngle }
 *         return { verdict: "duplicate", allow: false }
 *
 *     # ③ 冷却期内：需打破冷却
 *     if daysSince < cooldown:
 *         if canBreakCooldown(cand, section, n.novelty, n.newFacts.length):
 *             return { verdict: "progress", allow: true, brokeCooldown: true }
 *         threshold = policy.noveltyToBreak
 *         if n.novelty >= threshold:
 *             return { verdict: "progress", allow: true }
 *         if n.novelty < policy.noveltyFloor:
 *             return { verdict: "duplicate", allow: false }
 *         return { verdict: "cooldown", allow: false }
 *
 *     # ④ 冷却已结束：门槛随时间衰减
 *     threshold = decayedThreshold(section, daysSince, cooldown)
 *     if n.novelty >= policy.noveltyBase:
 *         return { verdict: "progress", allow: true }         # 有实质进展
 *     if n.novelty >= threshold:
 *         if not policy.allowRefresh:
 *             return { verdict: "cooldown", allow: false }    # 定调不接受"换角度重播"
 *         return { verdict: "refresh", allow: true, requiredAngle: nextAngle(record) }
 *     if n.novelty < policy.noveltyFloor:
 *         return { verdict: "duplicate", allow: false }
 *     return { verdict: "cooldown", allow: false }
 */

export function evaluateCandidate(opts: {
  cand: MemoryCandidate;
  section: MemorySection;
  /** 今天 YYYY-MM-DD。 */
  today: string;
  store: EventMemoryStore;
}): MemoryDecision {
  const { cand, section, today, store } = opts;
  const policy = SECTION_POLICY[section];
  const match = findMatchingEvent(cand, store);

  if (!match) {
    return {
      section,
      title: cand.title,
      verdict: "new",
      allow: true,
      novelty: 1,
      reason: "记忆库中无匹配事件（新事件）",
    };
  }

  const rec = match.record;
  const n = computeNovelty(cand, rec);
  const daysSince = diffDays(rec.lastBroadcastAt, today);
  const cooldownDays = effectiveCooldownDays(rec, section);
  const sectionCount = (rec.samples ?? []).filter((s) => s.section === section).length;

  // ① 板块内播报次数上限
  if (sectionCount >= policy.maxRepeat && n.novelty < policy.noveltyToBreak) {
    return {
      section,
      title: cand.title,
      verdict: "exhausted",
      allow: false,
      novelty: n.novelty,
      daysSince,
      cooldownDays,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      reason: `该事件在本板块已播报 ${sectionCount} 次（上限 ${policy.maxRepeat}），增量 ${fmt(n.novelty)} 未达重大进展线 ${fmt(policy.noveltyToBreak)}`,
    };
  }

  // ② 当日已播（跨板块共享）：定调与必读指向同一事件属合理呈现
  //    （一句话定调 + 展开讲为什么重要），不按冷却处理，只要求基本增量。
  if (daysSince <= 0) {
    const angle = nextAngle(rec);
    if (n.novelty >= policy.noveltyBase) {
      return {
        section,
        title: cand.title,
        verdict: "progress",
        allow: true,
        novelty: n.novelty,
        daysSince: 0,
        cooldownDays,
        threshold: policy.noveltyBase,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        requiredAngle: angle,
        reason: `当日已播（跨板块），增量 ${fmt(n.novelty)} ≥ 基础线 ${fmt(policy.noveltyBase)} → 换角度「${angle}」呈现`,
      };
    }
    if (n.novelty >= policy.noveltyFloor && policy.allowRefresh) {
      return {
        section,
        title: cand.title,
        verdict: "refresh",
        allow: true,
        novelty: n.novelty,
        daysSince: 0,
        cooldownDays,
        threshold: policy.noveltyFloor,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        requiredAngle: angle,
        reason: `当日已播（跨板块），增量有限（${fmt(n.novelty)}）→ 强制换角度「${angle}」`,
      };
    }
    return {
      section,
      title: cand.title,
      verdict: "duplicate",
      allow: false,
      novelty: n.novelty,
      daysSince: 0,
      cooldownDays,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      reason: `当日已播且增量 ${fmt(n.novelty)} < 下限 ${fmt(policy.noveltyFloor)}（同一天内的重复表述）`,
    };
  }

  // ③ 冷却期内
  if (daysSince < cooldownDays) {
    if (canBreakCooldown(cand, section, n.novelty, n.newFacts.length)) {
      return {
        section,
        title: cand.title,
        verdict: "progress",
        allow: true,
        novelty: n.novelty,
        daysSince,
        cooldownDays,
        threshold: policy.noveltyToBreak,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        requiredAngle: nextAngle(rec),
        brokeCooldown: true,
        reason: `重大事件打破冷却（${daysSince}/${cooldownDays} 天，增量 ${fmt(n.novelty)}，新事实 ${n.newFacts.length} 项）`,
      };
    }
    if (n.novelty >= policy.noveltyToBreak) {
      return {
        section,
        title: cand.title,
        verdict: "progress",
        allow: true,
        novelty: n.novelty,
        daysSince,
        cooldownDays,
        threshold: policy.noveltyToBreak,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        requiredAngle: nextAngle(rec),
        reason: `冷却期内但增量 ${fmt(n.novelty)} ≥ 打破线 ${fmt(policy.noveltyToBreak)}（有实质进展）`,
      };
    }
    if (n.novelty < policy.noveltyFloor) {
      return {
        section,
        title: cand.title,
        verdict: "duplicate",
        allow: false,
        novelty: n.novelty,
        daysSince,
        cooldownDays,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        reason: `冷却期内（${daysSince}/${cooldownDays} 天）且增量 ${fmt(n.novelty)} < 下限 ${fmt(policy.noveltyFloor)}（重复表述）`,
      };
    }
    return {
      section,
      title: cand.title,
      verdict: "cooldown",
      allow: false,
      novelty: n.novelty,
      daysSince,
      cooldownDays,
      threshold: policy.noveltyToBreak,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      reason: `冷却期内（${daysSince}/${cooldownDays} 天），增量 ${fmt(n.novelty)} 不足以打破（需 ≥ ${fmt(policy.noveltyToBreak)}）`,
    };
  }

  // ③ 冷却已结束：门槛随时间衰减
  const threshold = decayedThreshold(section, daysSince, cooldownDays);
  if (n.novelty >= policy.noveltyBase) {
    return {
      section,
      title: cand.title,
      verdict: "progress",
      allow: true,
      novelty: n.novelty,
      daysSince,
      cooldownDays,
      threshold,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      requiredAngle: nextAngle(rec),
      reason: `冷却结束（${daysSince} 天）且增量 ${fmt(n.novelty)} ≥ 基础线 ${fmt(policy.noveltyBase)}（新进展）`,
    };
  }
  if (n.novelty >= threshold) {
    if (!policy.allowRefresh) {
      return {
        section,
        title: cand.title,
        verdict: "cooldown",
        allow: false,
        novelty: n.novelty,
        daysSince,
        cooldownDays,
        threshold,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        reason: `板块不接受「换角度重播」（增量 ${fmt(n.novelty)} 仅达刷新线 ${fmt(threshold)}，未达基础线 ${fmt(policy.noveltyBase)}）`,
      };
    }
    return {
      section,
      title: cand.title,
      verdict: "refresh",
      allow: true,
      novelty: n.novelty,
      daysSince,
      cooldownDays,
      threshold,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      requiredAngle: nextAngle(rec),
      reason: `冷却结束（${daysSince} 天）但增量有限（${fmt(n.novelty)} ≥ 衰减门槛 ${fmt(threshold)}）→ 强制换角度「${nextAngle(rec)}」`,
    };
  }
  if (n.novelty < policy.noveltyFloor) {
    return {
      section,
      title: cand.title,
      verdict: "duplicate",
      allow: false,
      novelty: n.novelty,
      daysSince,
      cooldownDays,
      threshold,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      reason: `增量 ${fmt(n.novelty)} < 下限 ${fmt(policy.noveltyFloor)}（重复表述）`,
    };
  }
  return {
    section,
    title: cand.title,
    verdict: "cooldown",
    allow: false,
    novelty: n.novelty,
    daysSince,
    cooldownDays,
    threshold,
    eventId: match.id,
    broadcastCount: rec.broadcastCount,
    reason: `增量 ${fmt(n.novelty)} < 衰减门槛 ${fmt(threshold)}（距上次 ${daysSince} 天）`,
  };
}

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// 9) 记忆写入（纯函数，返回新 store）
// ---------------------------------------------------------------------------

/**
 * 开启新的一天：先把「昨天及更早」的暂存播报结算进长期记忆，再清空当天暂存区。
 *
 * 必须在每次判定前调用一次。幂等的关键：
 *  - 同一天重复运行 → 暂存区被清空重写，长期记忆不变 → 判定结果完全一致；
 *  - 跨天 → 昨天的播报结算进长期记忆 → 冷却期开始生效。
 */
export function beginDay(store: EventMemoryStore, today: string): EventMemoryStore {
  let events = { ...(store.events ?? {}) };
  const prev = store.today;
  if (prev && prev.date && prev.date !== today && prev.entries.length > 0) {
    events = settleIntoEvents(events, prev.entries);
  }
  return {
    version: 1,
    updatedAt: today,
    events,
    today: { date: today, entries: [] },
  };
}

/** 把一批播报留痕结算进长期记忆（跨天时调用）。 */
function settleIntoEvents(
  events: Record<string, EventRecord>,
  entries: BroadcastSample[],
): Record<string, EventRecord> {
  let out = events;
  for (const s of entries) {
    const cand: MemoryCandidate = {
      title: s.title,
      text: s.text ?? "",
      ...(s.url ? { url: s.url } : {}),
      ...(s.score !== undefined ? { score: s.score } : {}),
    };
    out = upsertEvent(out, cand, s);
  }
  return out;
}

/** 把一条播报合并进长期记忆（存在则更新，不存在则新建）。 */
function upsertEvent(
  events: Record<string, EventRecord>,
  cand: MemoryCandidate,
  sample: BroadcastSample,
): Record<string, EventRecord> {
  const text = candidateText(cand);
  const anchors = candidateAnchors(cand);
  const tags = extractTopicTags(text);
  const facts = extractFacts(text);
  const angle = sample.angle;
  const match = findMatchingEvent(cand, { version: 1, events });
  const out = { ...events };

  const merge = (rec: EventRecord): EventRecord => {
    // 同一天的多次呈现（跨板块 / 换角度）不重复计数 —— broadcastCount 语义是
    // 「播报天数」，否则定调 + 必读 + 商机都指向同一事件会让冷却期无谓暴涨。
    const sameDay = rec.lastBroadcastAt === sample.date;
    return {
      ...rec,
      // 锚点/标签/事实取并集，让后续同类报道更容易匹配到本事件
      anchors: [...new Set([...rec.anchors, ...anchors])],
      topicTags: [...new Set([...rec.topicTags, ...tags])],
      broadcastedTexts: [...(rec.broadcastedTexts ?? []), text].slice(-MAX_TEXTS),
      broadcastedFacts: [...new Set([...(rec.broadcastedFacts ?? []), ...facts])],
      lastBroadcastAt: sample.date,
      broadcastCount: (rec.broadcastCount ?? 0) + (sameDay ? 0 : 1),
      sections: [...new Set([...(rec.sections ?? []), sample.section])],
      anglesUsed: angle ? [...new Set([...(rec.anglesUsed ?? []), angle])] : rec.anglesUsed ?? [],
      samples: [...(rec.samples ?? []), sample].slice(-MAX_SAMPLES),
      peakScore: Math.max(rec.peakScore ?? 0, cand.score ?? 0),
    };
  };

  if (match) {
    out[match.id] = merge(match.record);
    return out;
  }
  const id = makeEventId(anchors) || `ev-${hash(normText(cand.title))}`;
  out[id] = events[id]
    ? merge(events[id])
    : {
        id,
        topicTags: tags,
        anchors,
        kind: classifyKind(text),
        firstBroadcastAt: sample.date,
        lastBroadcastAt: sample.date,
        broadcastCount: 1,
        sections: [sample.section],
        anglesUsed: angle ? [angle] : [],
        samples: [sample],
        broadcastedTexts: [text],
        broadcastedFacts: facts,
        peakScore: cand.score ?? 0,
      };
  return out;
}

/**
 * 记录一次播报 → 写入**当天暂存区**（不直接进长期记忆，跨天才结算）。
 *
 * 为什么分两层：见 EventMemoryStore.today 的说明（保证同一天多次运行的幂等性）。
 * 存 text / facts 是为了让「同一次运行内」的第二条同事件报道也能算出信息增量
 * （例如 LLM 把同一事件拆成两条必读，第二条需要被识别为重复）。
 */
export function rememberBroadcast(
  store: EventMemoryStore,
  input: {
    cand: MemoryCandidate;
    section: MemorySection;
    date: string;
    angle?: EventAngle;
    novelty?: number;
  },
): EventMemoryStore {
  const { cand, section, date, angle, novelty } = input;
  const text = candidateText(cand);
  const sample: BroadcastSample = {
    date,
    section,
    title: cand.title,
    text,
    facts: extractFacts(text),
    // 播报时刻：播报与展示绑定、几乎同时产生，故以当前时刻（≈ 报告页面生成时刻）为准。
    // 用于以 9:00 为界区分客户演示数据与测试重跑数据，并支持按时间段筛选/清理。
    broadcastAt: formatBroadcastAt(),
  };
  if (cand.url) sample.url = cand.url;
  if (cand.score !== undefined) sample.score = cand.score;
  if (novelty !== undefined) sample.novelty = novelty;
  if (angle) sample.angle = angle;

  const prev = store.today && store.today.date === date ? store.today.entries : [];
  return {
    version: 1,
    updatedAt: date,
    events: store.events ?? {},
    today: { date, entries: [...prev, sample] },
  };
}

/** 简易字符串 hash（事件 id 兜底，无锚点时使用）。 */
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ---------------------------------------------------------------------------
// 10) 记忆库维护
// ---------------------------------------------------------------------------

/**
 * 清理过期事件。
 *
 * 与展示层 2 天窗口不同，记忆库必须活得久（否则「上周播过」无从知晓）；
 * 但也不能无限膨胀。保留策略：
 *  - 最近 retainDays（默认 45）天内播报过的保留；
 *  - 峰值分 ≥ 60 的重大事件额外延长到 retainDays × 2（重大政策值得长期记住）；
 *  - 总量超过 maxEvents（默认 400）时，按 lastBroadcastAt 淘汰最旧的。
 */
export function pruneMemory(
  store: EventMemoryStore,
  today: string,
  opts: { retainDays?: number; maxEvents?: number } = {},
): EventMemoryStore {
  const retainDays = opts.retainDays ?? 45;
  const maxEvents = opts.maxEvents ?? 400;
  // 落盘前统一清洗：损坏记录在此丢弃、数值/日期类型在此归一化。
  // pruneMemory 是写入前必经路径（store.ts:saveEventMemory），在此兜底可确保
  // 即使调用方传入被污染的 store，落盘内容也是干净的 → 自愈。
  const src = sanitizeEvents(store.events ?? {});
  const events: Record<string, EventRecord> = {};
  for (const [id, rec] of Object.entries(src)) {
    // 日期缺失/非法时按「今天」处理（宁可保留，不误删记忆）
    const lastAt = rec.lastBroadcastAt ? rec.lastBroadcastAt : today;
    const age = Number.isFinite(diffDays(lastAt, today)) ? diffDays(lastAt, today) : 0;
    const keepFor = (rec.peakScore ?? 0) >= 60 ? retainDays * 2 : retainDays;
    if (age <= keepFor) events[id] = rec;
  }
  const list = Object.entries(events).sort(
    (a, b) => (a[1].lastBroadcastAt < b[1].lastBroadcastAt ? -1 : 1),
  );
  if (list.length > maxEvents) {
    const trimmed: Record<string, EventRecord> = {};
    for (const [id, rec] of list.slice(list.length - maxEvents)) trimmed[id] = rec;
    return { version: 1, updatedAt: today, events: trimmed, ...(store.today ? { today: store.today } : {}) };
  }
  return { version: 1, updatedAt: today, events, ...(store.today ? { today: store.today } : {}) };
}

/** 空记忆库。 */
export function emptyMemory(): EventMemoryStore {
  return { version: 1, events: {} };
}

/**
 * 生成给 LLM 的「记忆提示」：近期已播报事件清单 + 若必须重播应切换的角度。
 * 只取最近 lookbackDays 天内播报过的事件，按最近播报时间倒序。
 */
export function buildMemoryBrief(
  store: EventMemoryStore,
  today: string,
  opts: { lookbackDays?: number; limit?: number } = {},
): Array<{
  title: string;
  lastBroadcast: string;
  daysSince: number;
  count: number;
  suggestedAngle: EventAngle;
  angleGuide: string;
}> {
  const lookback = opts.lookbackDays ?? 10;
  const limit = opts.limit ?? 8;
  const out: Array<{
    title: string;
    lastBroadcast: string;
    daysSince: number;
    count: number;
    suggestedAngle: EventAngle;
    angleGuide: string;
  }> = [];
  for (const rec of Object.values(store.events ?? {})) {
    if (!isUsableRecord(rec)) continue;
    const lastAt = typeof rec.lastBroadcastAt === "string" ? rec.lastBroadcastAt : today;
    const days = diffDays(lastAt, today);
    if (days < 0 || days > lookback) continue;
    const last = rec.samples.filter((s) => s && s.date === lastAt)[0]
      ?? rec.samples[rec.samples.length - 1];
    if (!last) continue;
    const angle = nextAngle(rec);
    out.push({
      title: last.title,
      lastBroadcast: rec.lastBroadcastAt,
      daysSince: days,
      count: rec.broadcastCount ?? 1,
      suggestedAngle: angle,
      angleGuide: ANGLE_GUIDE[angle],
    });
  }
  out.sort((a, b) => a.daysSince - b.daysSince);
  return out.slice(0, limit);
}

/**
 * 把记忆提示渲染成注入 LLM 提示词的文本块。
 *
 * 给模型的指令是「优先选新事件；若某事件确实仍是今天最值得说的，
 * 必须换一个切入角度」——而不是「禁止提及」。
 * 硬禁会让模型在只有旧事件可说时编造内容（历史教训：LLM 宁可编也不留空），
 * 因此保留「换角度重说」的合法出口。
 */
export function formatMemoryBrief(
  brief: Array<{
    title: string;
    lastBroadcast: string;
    daysSince: number;
    count: number;
    suggestedAngle: EventAngle;
    angleGuide: string;
  }>,
): string {
  if (brief.length === 0) return "";
  const lines = brief.map((b) => {
    const when = b.daysSince === 0 ? "今天已播报过" : `${b.daysSince} 天前播报过`;
    return `- 「${b.title.slice(0, 40)}」（${when}，累计 ${b.count} 次）→ 如需再讲，请改从「${b.suggestedAngle}」切入：${b.angleGuide}`;
  });
  return [
    "",
    "【内容记忆·去重约束】以下是近期已播报过的事件，行长已经听过：",
    ...lines,
    "- 优先选择上述之外的新事件；",
    "- 若某事件确实仍是今天最值得说的（如出现实质新进展），可以再讲，但**必须换成上面指定的切入角度**，用新事实、新数据或新主体展开，严禁换汤不换药地复述；",
    "- 严禁编造新事件来规避本约束。",
  ].join("\n");
}
