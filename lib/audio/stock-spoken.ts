/**
 * 股市口播稿确定性拼装（2026-09-03 用户需求）。
 *
 * 背景：原实现直接念 LLM 产出的 `MarketCard.spoken`（≤120 字），且被 audio.ts
 * 按 `stock/3 ≈ 66 字/市场` 二次截断 —— 卡片里已提炼好的细分板块要点
 * （涨跌表现 / 资金流向 / 异动原因）几乎全被砍掉，只剩一句大盘。
 *
 * 目标：把 `sectors`（卡片中提炼的细分板块要点）纳入股市口播，并按用户 5 条要求组织：
 *   1. 板块按重要性 + 市场关注度排序，只取有代表性、有信息增量的，不罗列堆砌；
 *   2. 叙述分三层：整体行情（overview）→ 结构分化（过渡句）→ 重点板块（排序后的 sectors）；
 *   3. 只留关键指标，口语化、可朗读；
 *   4. 总时长控制在 3:00~3:30（由 audio.ts 的剩余预算驱动，本模块只做字数适配）；
 *   5. 板块缺有效内容（空描述 / 空洞套话 / 与大盘重复）→ 跳过，不生硬补充。
 *
 * 为什么是确定性拼装而非继续让 LLM 写 spoken：
 *   - SKIP_AI 重跑复用 store.json，不调 LLM，只有确定性拼装能立即生效；
 *   - 「排序 / 过滤 / 跳过 / 预算分配」是规则问题，交给 LLM 无法保证稳定与可测。
 *   LLM 侧的 `spoken` 降级为兜底（overview 与 sectors 都缺时才用）。
 *
 * 2026-09-03 晚间用户要求（股市口播再压缩 ~30%）：
 *   每市场只详述「打分最高（信息量最大）」的 2 个板块，其余次要板块简化或略过。
 *   生产调用方 audio.ts 显式传 maxSectors: 2；本模块独立默认仍为 4
 *   （供单测/无外层传参时使用），不随生产需求改默认值——压缩意图留在调用边界表达。
 */

import type { MarketCard, StockRecap } from "../types";

/** 市场键（拼装顺序即口播顺序：A股 → 港股 → 美股）。 */
export type MarketKey = "aShare" | "hk" | "us";

/** 单市场口播选项。 */
export interface StockSpokenOptions {
  /** 本市场口播总字数预算（含大盘 + 过渡 + 板块）。由外层按总剩余额度分配。 */
  budget: number;
  /** 最多纳入几个板块（默认 4；生产调用 audio.ts 显式传 2，见文件头 2026-09-03 晚间说明）。 */
  maxSectors?: number;
  /** 单条板块文案字数上限（默认 40）。 */
  maxSectorChars?: number;
  /** 市场前缀（如「A股（北京时间9月2日 周三收盘）：」）字数，计入预算避免标签挤占正文。 */
  labelChars?: number;
}

/** 解析后的板块条目（"板块名：描述" → { name, desc }）。 */
export interface SectorLine {
  /** 板块名（可能为空：原文本无「：」分隔）。 */
  name: string;
  /** 板块描述（去掉板块名后的正文）。 */
  desc: string;
  /** 重要性 / 关注度得分（越高越优先）。 */
  score: number;
  /** 拼装后的口播分句（"板块名，描述"）。 */
  text: string;
}

/** 拼装结果（便于调用方打印日志 / 单测断言）。 */
export interface StockSpokenResult {
  /** 各市场口播正文（无有效内容则为空串）。 */
  texts: Record<MarketKey, string>;
  /** 各市场实际纳入的板块数（用于 CI 日志核对「板块要点是否进来了」）。 */
  sectorCounts: Record<MarketKey, number>;
  /** 三市场合计字数。 */
  chars: number;
}

// ——— 语义词典：全部服务于「有信息量 = 优先播」———

/** 空洞套话：描述不出任何板块事实，命中即丢弃（用户要求 5：缺有效内容则跳过）。 */
const FILLER_RE =
  /市场情绪|观望情绪|整体平稳|波澜不惊|交投清淡|多家公司|密集披露|集中披露|披露季|年报季|业绩集中|无重大变化|暂无明显|表现一般|涨跌互现，无/;
/** 资金流向：用户点名要的维度（主力/北水/净买入…），权重最高。 */
const FUND_RE =
  /主力|北向|南向|北水|南水|净买入|净流入|净卖出|净流出|大单|超大单|加仓|减仓|扫货|抢筹|资金|成交额|成交放大|放量|缩量/;
/** 强势方向。 */
const STRONG_RE =
  /领涨|大涨|暴涨|涨停|封板|逆市|逆势|走强|爆发|拉升|反弹|受益|提振|最强|创新高|净买入|净流入|加仓|扫货|上攻|冲高/;
/** 弱势方向。 */
const WEAK_RE =
  /领跌|大跌|暴跌|跌停|走弱|下挫|回调|承压|拖累|抛售|净卖出|净流出|减仓|创新低|杀跌|回落|下探/;
/** 异动原因 / 驱动因素（讲清「为什么」的板块优先）。 */
const CAUSE_RE =
  /受[^\s，。；]{0,14}(?:刺激|提振|带动|推动|影响|压制|施压|扰动|拖累|支撑)|因|由于|财报|业绩|政策|预期|供给|需求|地缘|降息|加息|关税|数据|订单|涨价|降价|扩产|减产|重组|并购/;
/** 纯展望 / 机构建议：有参考价值但不是当日盘面事实，降权（不直接丢弃）。 */
const OUTLOOK_RE = /建议(?:关注|配置|留意|布局)|可关注|后市|展望|中长期|值得期待|未来/;
/** 数字（涨跌幅 / 点位 / 金额），有具体数字的信息密度更高。 */
const NUM_RE = /\d/;
/** 这些结尾的板块名不需要再补「板块」二字（"科网股" → 不念"科网股板块"）。 */
const NO_SUFFIX_RE =
  /(板块|资金|股|链|概念|指数|债市|新股|期货|商品|货币|外汇|市场|盘|地产|医药|能源|消费|科技|关联|配置|动态|方面|情绪)$/;

/** 默认参数。 */
/**
 * 板块上限默认 4（2026-08-31 卡片板块 3-5 条，给口播留选择空间；实际条数由预算轮转决定）。
 * 2026-09-03 晚间起：生产调用（audio.ts）显式传 2（口播压缩 ~30%，每市场只详述最强 2 板块），
 * 本默认值保留 4 仅供单测/独立调用，避免把「压缩」写进模块语义。
 */
const DEFAULT_MAX_SECTORS = 4;
const DEFAULT_MAX_SECTOR_CHARS = 40;
/** 单条板块低于该字数视为「数据不足以支撑」→ 跳过（用户要求 5）。 */
const MIN_SECTOR_DESC_CHARS = 6;
/** 大盘概览字数上限（LLM 偶有啰嗦，截断保证板块有额度）。 */
const MAX_OVERVIEW_CHARS = 60;

/** 基础清洗：去 Markdown / 链接 / 易碎符号 / 列表前缀，与 audio.ts sanitize 同口径。 */
function clean(s: string): string {
  if (!s) return "";
  return s
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_`~>|]/g, "")
    .replace(/^\s*[-+•·\d.、]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 去掉句尾句号（拼装时统一补）。 */
function stripTrailingPeriod(s: string): string {
  return s.replace(/[。.!！？?；;、,，]+$/g, "").trim();
}

/** 在分隔点（，；、）处截断到 max 内，避免把半句话念出来。 */
function clipAtClause(s: string, max: number): string {
  if (s.length <= max || max <= 0) return s;
  const cut = s.slice(0, max);
  for (let i = cut.length - 1; i >= Math.floor(max * 0.5); i--) {
    if ("，；、".includes(cut[i])) return cut.slice(0, i);
  }
  return cut;
}

/** 中文 bigram 集合（用于重复度判断）。 */
function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s\p{P}\p{S}]/gu, "");
  const out = new Set<string>();
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Dice 相似度（0~1）：判断板块描述是否与大盘概览重复。 */
export function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * 解析 "板块名：描述" → { name, desc }。
 * 无分隔符时整段视为描述（name 为空）。返回 null 表示无有效内容。
 */
export function parseSectorLine(raw: string): { name: string; desc: string } | null {
  const s = clean(raw);
  if (!s) return null;
  const m = s.match(/^([^：:]{1,12})[：:]\s*(.+)$/);
  if (m) {
    const name = m[1].trim();
    const desc = stripTrailingPeriod(m[2].trim());
    if (!desc || desc.length < MIN_SECTOR_DESC_CHARS) return null;
    return { name, desc };
  }
  const desc = stripTrailingPeriod(s);
  if (desc.length < MIN_SECTOR_DESC_CHARS) return null;
  return { name: "", desc };
}

/**
 * 板块重要性 / 关注度打分（越高越优先播报）。
 *
 * 正向：资金流向(+3) > 涨跌方向(+2) / 具体数字(+2) / 异动原因(+2) > 描述充分(+1)
 * 负向：空洞套话(-100 直接淘汰) / 纯展望建议(-2)
 */
export function scoreSector(name: string, desc: string): number {
  if (FILLER_RE.test(desc)) return -100;
  let sc = 0;
  if (FUND_RE.test(desc)) sc += 3;
  if (STRONG_RE.test(desc)) sc += 2;
  if (WEAK_RE.test(desc)) sc += 2;
  if (CAUSE_RE.test(desc)) sc += 2;
  if (NUM_RE.test(desc)) sc += 2;
  if (desc.length >= 12) sc += 1;
  if (name) sc += 1;
  if (OUTLOOK_RE.test(desc)) sc -= 2;
  return sc;
}

/**
 * 板块筛选 + 排序：丢弃无效项，按重要性降序；同分保持卡片原顺序
 * （LLM 输出的 sectors 本身已大致按强弱排列，不无谓打乱）。
 */
export function selectSectors(
  sectors: string[],
  overview: string,
  maxSectors = DEFAULT_MAX_SECTORS,
  maxSectorChars = DEFAULT_MAX_SECTOR_CHARS,
): SectorLine[] {
  const out: SectorLine[] = [];
  const seen = new Set<string>();
  for (const raw of sectors ?? []) {
    const parsed = parseSectorLine(raw);
    if (!parsed) continue; // 空描述 / 太短 → 跳过（用户要求 5）
    const { name, desc } = parsed;
    const score = scoreSector(name, desc);
    if (score < 0) continue; // 空洞套话 → 跳过
    // 与大盘概览高度重复 → 跳过（用户要求 4：控制冗余重复）
    if (overview && similarity(desc, overview) >= 0.5) continue;
    const clipped = clipAtClause(desc, maxSectorChars);
    const label = name
      ? NO_SUFFIX_RE.test(name)
        ? name
        : `${name}板块`
      : "";
    // 名称已带「板块」二字时，描述里的「板块」就成了同句重复
    // （如"中资券商板块，板块普遍下跌" → "中资券商板块，普遍下跌"），念起来很别扭。
    let body = clipped;
    if (label.includes("板块")) body = body.replace(/板块/g, "");
    body = body.replace(/，\s*，/g, "，").replace(/^，|，$/g, "").trim();
    if (!body) continue; // 清完没内容 → 跳过（用户要求 5）
    const text = label ? `${label}，${body}` : body;
    const key = text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, desc: clipped, score, text });
  }
  // 降序稳定排序：Array.sort 在现代 V8 稳定，这里显式加 index 兜底
  out
    .map((x, i) => ({ x, i }))
    .sort((a, b) => b.x.score - a.x.score || a.i - b.i)
    .forEach((w, i) => {
      out[i] = w.x;
    });
  return out.slice(0, maxSectors);
}

/**
 * 过渡句候选池（结构分化层）。
 *
 * 为什么要多套表述：三个市场常常都是「有强有弱」，若固定用同一句，
 * A股/港股/美股连念三遍「板块上看，结构分化比较明显」非常刺耳。
 * 按市场顺序轮换变体，保证同一份稿子里过渡语不重复（用户要求 4：控制冗余重复）。
 */
const TRANSITIONS: Record<"both" | "strong" | "weak" | "neutral", string[]> = {
  both: ["板块上看，结构分化比较明显：", "结构上看，强弱分明：", "板块之间分化不小："],
  strong: ["强势方向集中在：", "领涨的主要是：", "涨得比较突出的是："],
  weak: ["拖累盘面的主要是：", "走弱的方向集中在：", "跌得多的主要是："],
  neutral: ["分板块看：", "板块层面：", "各板块情况是："],
};

/**
 * 过渡句：按选中板块的方向自动选择，让「大盘 → 板块」衔接自然。
 * - 有强有弱 → 强调分化；只有强的 → 领涨方向；只有弱的 → 拖累来源；都无 → 中性。
 * @param variant 变体序号（按市场顺序递增，避免三市场念同一句）
 */
export function pickTransition(lines: SectorLine[], variant = 0): string {
  const all = lines.map((l) => `${l.name} ${l.desc}`).join(" ");
  const hasStrong = STRONG_RE.test(all);
  const hasWeak = WEAK_RE.test(all);
  const kind: keyof typeof TRANSITIONS = hasStrong && hasWeak
    ? "both"
    : hasStrong
      ? "strong"
      : hasWeak
        ? "weak"
        : "neutral";
  const pool = TRANSITIONS[kind];
  return pool[Math.abs(variant) % pool.length];
}

/** 组装单市场口播：整体行情 → 结构分化 → 重点板块。 */
export function buildMarketSpoken(card: MarketCard, opts: StockSpokenOptions): string {
  const maxSectors = opts.maxSectors ?? DEFAULT_MAX_SECTORS;
  const maxSectorChars = opts.maxSectorChars ?? DEFAULT_MAX_SECTOR_CHARS;
  const labelChars = opts.labelChars ?? 0;
  const budget = Math.max(0, opts.budget - labelChars);

  const overview = stripTrailingPeriod(clipAtClause(clean(card.overview ?? ""), MAX_OVERVIEW_CHARS));
  if (!overview) return ""; // 无大盘信息 → 整段跳过（由外层决定兜底）

  const lines = selectSectors(card.sectors ?? [], overview, maxSectors, maxSectorChars);
  // 预算不够念完大盘 → 截断大盘（大盘是骨架，不能整段丢）
  if (budget < overview.length) {
    const clipped = clipAtClause(overview, Math.max(8, budget - 1));
    return clipped ? `${clipped}。` : "";
  }
  if (!lines.length) return `${overview}。`;

  const transition = pickTransition(lines);
  // 固定开销：大盘后的「。」+ 过渡句 + 结尾「。」+ 板块间「；」
  let remaining = budget - overview.length - 1 - transition.length - 1;
  const picked: string[] = [];
  for (const line of lines) {
    const cost = line.text.length + (picked.length ? 1 : 0); // 1 = 「；」
    if (cost > remaining) break; // 放不下就停，不硬塞（用户要求 4：控制冗余）
    picked.push(line.text);
    remaining -= cost;
  }
  if (!picked.length) return `${overview}。`;
  return `${overview}。${transition}${picked.join("；")}。`;
}

// ——— 跨市场预算分配 ———

interface MarketSlot {
  key: MarketKey;
  /** 大盘句（已清洗、去尾句号）。 */
  overview: string;
  /** 板块候选（已排序、已格式化）。 */
  lines: SectorLine[];
  /** 过渡句。 */
  transition: string;
  /** 本槽已选中的板块。 */
  picked: string[];
  /** 是否有可渲染内容（overview 非空即可）。 */
  hasContent: boolean;
  /** 市场前缀字数（"A股（北京时间…收盘）："），计入预算。 */
  labelChars: number;
}

/** 口播顺序：A股 → 港股 → 美股（与报告页 tab 及听众熟悉度一致）。 */
const MARKET_ORDER: MarketKey[] = ["aShare", "hk", "us"];

/**
 * 三市场口播拼装（跨市场自适应预算）。
 *
 * 分配策略：先保证每个市场的大盘句（最低保障），再用剩余额度按
 * 「A股 → 港股 → 美股」轮转逐条发放板块 —— 本地优先，且内容丰富的市场
 * 自然多吃额度，避免平均分配导致 A 股塞不下、美股浪费预算。
 */
export function buildStockSpoken(
  recap: StockRecap | null | undefined,
  opts: {
    budget: number;
    maxSectors?: number;
    maxSectorChars?: number;
    /** 各市场前缀字数（"A股（北京时间…收盘）："），计入预算，避免标签挤占正文额度。 */
    labelChars?: Partial<Record<MarketKey, number>>;
  },
): StockSpokenResult {
  const maxSectors = opts.maxSectors ?? DEFAULT_MAX_SECTORS;
  const maxSectorChars = opts.maxSectorChars ?? DEFAULT_MAX_SECTOR_CHARS;
  const total = Math.max(0, opts.budget);
  const texts: Record<MarketKey, string> = { aShare: "", hk: "", us: "" };
  const sectorCounts: Record<MarketKey, number> = { aShare: 0, hk: 0, us: 0 };
  if (!recap) return { texts, sectorCounts, chars: 0 };

  const slots: MarketSlot[] = [];
  let variant = 0;
  for (const key of MARKET_ORDER) {
    const card = recap[key];
    const overview = stripTrailingPeriod(
      clipAtClause(clean(card?.overview ?? ""), MAX_OVERVIEW_CHARS),
    );
    if (!overview) continue;
    const lines = selectSectors(card?.sectors ?? [], overview, maxSectors, maxSectorChars);
    slots.push({
      key,
      overview,
      lines,
      // 变体按「有内容市场」的顺序递增，保证三个市场的过渡语互不相同
      transition: lines.length ? pickTransition(lines, variant) : "",
      picked: [],
      hasContent: true,
      labelChars: opts.labelChars?.[key] ?? 0,
    });
    if (lines.length) variant++;
  }
  if (!slots.length) return { texts, sectorCounts, chars: 0 };

  // ① 大盘骨架：先扣掉每个市场的 overview + 标点 + 市场前缀
  let used = 0;
  const baseCost = (s: MarketSlot) => s.overview.length + 1 + s.labelChars; // 「。」+ 前缀
  for (const s of slots) used += baseCost(s);

  // 预算连三个大盘都放不下 → 按比例收缩大盘，只播整体行情
  if (used > total) {
    const texts2: Record<MarketKey, string> = { aShare: "", hk: "", us: "" };
    for (const s of slots) {
      // 按各市场「前缀+大盘」占比分摊；扣掉前缀后至少留 8 字给大盘本体
      const share = Math.max(8, Math.floor((total * baseCost(s)) / used) - 1 - s.labelChars);
      texts2[s.key] = `${clipAtClause(s.overview, share)}。`;
    }
    const chars2 = Object.values(texts2).reduce((n, t) => n + t.length, 0);
    return { texts: texts2, sectorCounts, chars: chars2 };
  }

  // ② 过渡句开销（只有选中了板块才需要）
  let free = total - used;
  for (const s of slots) {
    if (!s.lines.length) continue;
    const cost = s.transition.length + 1; // 结尾「。」
    if (cost > free) {
      s.lines = []; // 连过渡都放不下 → 该市场只念大盘
    } else {
      free -= cost;
    }
  }

  // ③ 轮转发放板块：A股 → 港股 → 美股，每条板块谁先谁得
  let progressed = true;
  while (free > 0 && progressed) {
    progressed = false;
    for (const s of slots) {
      if (!s.lines.length) continue;
      const line = s.lines[0];
      const cost = line.text.length + (s.picked.length ? 1 : 0); // 1 = 「；」
      if (cost > free) continue;
      s.picked.push(line.text);
      s.lines.shift();
      free -= cost;
      progressed = true;
    }
  }

  // ④ 组装
  for (const s of slots) {
    sectorCounts[s.key] = s.picked.length;
    texts[s.key] = s.picked.length
      ? `${s.overview}。${s.transition}${s.picked.join("；")}。`
      : `${s.overview}。`;
  }
  const chars = Object.values(texts).reduce((n, t) => n + t.length, 0);
  return { texts, sectorCounts, chars };
}
