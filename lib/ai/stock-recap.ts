import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import fs from "node:fs";
import path from "node:path";
import type { MarketCard, StockRecap } from "../types";
import type { IndexQuote, QuoteResult } from "../sources/quote-api";

/**
 * 「股市解读」AI 层（2026-08-25 用户确认实施）
 *
 * 每天一次 LLM 调用，基于当日「美股 / A股 / 港股」三组原始新闻条目，
 * 产出 3 张复盘卡（每卡 = 涨跌概况 overview + 关键板块 sectors），
 * 并附每卡口播稿 spoken（纯口语，可直接朗读）。
 *
 * 设计红线（用户 2026-08-25 拍板）：
 *  - 只做市场事实性概述，**严禁引申到银行零售/对公业务、投资建议、获客动作**；
 *  - 因要转口播，三卡内容须口播友好（spoken 纯文本、无 Markdown/链接/emoji）；
 *  - 指数点位/涨跌幅只基于输入，缺失则用定性描述，绝不臆造精确数字。
 *
 * 持久化与 lib/ai/executive-summary.ts 同机制：归档到 history/<date>/store.json
 * 的 stock_recap 字段（与 executive 共存于同一文件），SKIP_AI 重跑/发布复用零 LLM。
 */

/** 单条市场输入（标题 + 摘要 + 源链接 + 发布日期）。 */
export interface StockItem {
  title: string;
  summary?: string;
  url?: string;
  source?: string;
  /** 发布日期 YYYY-MM-DD（A股/港股=爬虫标注；美股=RSS pubDate 归一化） */
  publishedAt?: string;
}

export interface StockRecapInput {
  /** 报告日期 YYYY-MM-DD */
  date: string;
  /** 美股原始条目（cnbc-top / investing-news 等） */
  us: StockItem[];
  /** A股原始条目（东方财富爬虫） */
  aShare: StockItem[];
  /** 港股原始条目（新浪港股 / 披露易） */
  hk: StockItem[];
}

const SYSTEM_PROMPT =
  "你是证券市场播报编辑。基于当日美股/A股/港股三组新闻条目，分别为三个市场生成「股市解读」复盘卡，面向资讯听众，客观、精炼、口播友好。严格按用户要求输出 JSON。";

const RULES = `你是证券市场播报编辑。系统面向分行内部资讯听众（非投资建议），核心诉求：用最短篇幅讲清「昨天市场怎么走、什么板块强/弱」。

基于输入的「美股 / A股 / 港股」三组新闻条目（每组是原始标题+摘要，可能为空），分别为三个市场生成一张「股市解读」卡，每张卡含：
- overview（大盘一句话总结，单句 ≤35字）：概括该市场主要指数的涨跌方向与幅度（如"三大指数集体收跌""恒指涨1.2%"），以及最关键的 1 个驱动因素（美联储/地缘/重磅个股/政策）。若无明确指数涨跌数据，据输入条目客观描述盘面强弱（如"科技股领跌、能源走弱"）。严禁写成多句、严禁与 sectors 重复。
- **港股 overview 必须锚定权威收评（2026-08-29 用户要求）**：若输入港股条目中含「收评/综述/复盘」类（标题含"恒指收评""港股收评""港股市场综述"等），overview 须直接提炼该收评的大盘结论（恒指/恒科涨跌 + 收评给出的核心驱动），不得凭零散个股新闻另起炉灶；若无收评类条目，则据恒指/恒科指数点位与板块客观描述。
- **港股禁止空洞套话（2026-08-31 用户要求）**：港股 overview/sectors/spoken 严禁「多家公司披露年报」「密集披露」「多股披露业绩」「年报季扎堆」等无信息量表述——输入尾部可能附有披露类栏目标题，仅作参考，**不得照抄或汇总成套话**。必须写具体数据：指数收盘点位与涨跌幅优先引用「当日指数收盘」块（如"恒指收报18234点，跌0.62%"），缺指数则写具体板块/个股动态（如"内房股走弱，龙湖跌3%""南向资金净流入78亿"），宁短勿空。
- sectors（关键板块，3-5 个）：列出当日表现最强的 1-2 个板块与最弱的 1-2 个板块（如"半导体：英伟达财报后大涨""房地产：政策预期落空走弱"），每个板块一句话点明原因。板块名用中文（"半导体""新能源""金融""医药"），不要英文 ticker。
- **sectors 必须可直接转口播（2026-09-03 用户要求：股市口播会把这些要点逐条念出来）**，因此每条按「重要性 + 市场关注度」降序排列：
  ① 优先写**资金流向**（主力/北向/南向净买入净流出、大单、加仓扫货）与**领涨领跌方向**（领涨/领跌/涨停/逆市/拖累）；
  ② 每条必须点明**异动原因**（财报/政策/地缘/供需/利率/事件驱动），只说"走强/走弱"而讲不出原因的不写；
  ③ 只留关键指标（涨跌幅、点位、金额），一句话不超过 40 字，不要堆砌多个数字和专业术语；
  ④ **缺乏有效内容或数据不足以支撑的板块直接不写**，宁缺毋滥——不得用"值得关注""有望""市场情绪回暖"等空话凑数；
  ⑤ 板块名避免与 overview 已说过的内容重复（overview 提到过的最强板块，sectors 里换角度展开或不再单列）。
- spoken（口播稿，纯口语 ≤120 字）：把 overview+sectors 浓缩成主播语态的完整句，先讲涨跌概况再点关键板块，句号收尾、可直接朗读。
- spoken 语气对齐内部「今日必读」栏目风格：精炼、客观、陈述式（如"美股三大指数涨跌不一，科技股领涨""A股沪指收跌，贵金属逆市走强"），不铺陈、不抒情、不喊话。

严格要求：
- **有输入必须出卡，绝不空卡**（2026-08-26 港股空卡修复）：即使新闻条目为 0，只要系统给定了"市场输入"（美股 / A股 / 港股 任一组非空），该市场就必须产出非空卡；条目稀薄时据指数点位（若有）+ 板块印象补足一句话，宁可短不可空。
- 只基于输入信息，不要编造指数点位/涨跌幅；若输入未提供具体数字，用"走强/走弱/涨跌互现/集体收跌"等定性描述，绝不臆造精确数字。
- 只做市场事实性概述，**严禁引申到银行零售/对公业务、投资建议、获客动作、风险提示等**（本卡是盘面复盘，不是商机分析）。
- 语言精炼、客观、面向资讯听众，不写空话套话。
- **信息密度硬要求（2026-08-31 用户要求，三市场通用）**：overview/sectors 必须承载具体信息（指数涨跌数字 / 具体板块 / 具体公司 / 具体事件），严禁「多家公司披露…」「密集披露」「市场整体平稳」「情绪谨慎观望」等任何无信息量套话；有指数数据必须引用，无指数数据也必须落到具体板块/个股层面，不得用空泛表述充数。
- spoken 为纯文本：无 Markdown、无链接、无 emoji、无 # * | \` 等符号，可直接朗读。

输出 STRICTLY 一个 JSON 对象（无 markdown 代码块）：
{"us":{"overview":"...","sectors":["...","..."],"spoken":"..."},"aShare":{"overview":"...","sectors":["..."],"spoken":"..."},"hk":{"overview":"...","sectors":["..."],"spoken":"..."}}
注意：字符串内引号用单引号或中文引号，禁止裸双引号。**三市场都禁止空卡**（overview/sectors/spoken 至少 overview 非空）；有指数点位就据指数写一句话，无指数则用"盘面涨跌互现/走强/走弱"等定性描述。`;

function toPayloadItems(items: StockItem[]): Array<{ title: string; summary: string; source: string }> {
  return items.slice(0, 12).map((it) => ({
    title: it.title,
    summary: it.summary ?? "",
    source: it.source ?? "",
  }));
}

/** 公告流源（无恒指/板块等综合盘面数据，不能充当股市解读主源或交叉验证源，仅作补充）。
 *  2026-08-25 用户拍板：披露易是公司级公告流，不应出现在卡脚 source/crossCheck 主位。 */
const ANNOUNCEMENT_SOURCES = ["港交所披露易"];

/**
 * 港股条目排序（2026-08-31 用户：港股口播充斥「多家公司披露年报」「密集披露」等空话，
 * 与美股/A股质量差距明显）。排序目标：让 LLM 优先看到有信息量的条目——
 * ① 收评/综述/复盘/大势研判类（大盘综合报道，信息密度最高）→ 最前；
 * ② 具体公司/板块/资金动态类 → 其次；
 * ③ 空泛披露类（标题命中「多家/密集/多股/集体/陆续/扎堆/披露季/年报季」等栏目级套话）
 *    与公告流（港交所披露易，公司级英文公告）→ 压到最后。
 * 同类内按 publishedAt 降序（最新在前）。仅排序不删除，避免丢信息。
 */
const HK_BLURB_RE = /多家|密集|多股|集体|陆续|批量|扎堆|相继|纷纷|披露季|年报季|业绩集中|集中披露/;
export function rankHkStockItems(items: StockItem[]): StockItem[] {
  const score = (it: StockItem): number => {
    const t = it.title ?? "";
    const s = it.source ?? "";
    if (HK_RECAP_RE.test(t)) return 3; // 收评/综述/复盘类：大盘综合报道优先
    if (HK_BLURB_RE.test(t) || ANNOUNCEMENT_SOURCES.includes(s)) return 1; // 空泛披露/公告流压后
    return 2; // 具体公司/板块/资金动态
  };
  return [...items]
    .map((it) => ({ it, sc: score(it) }))
    .sort(
      (a, b) => b.sc - a.sc || (b.it.publishedAt ?? "").localeCompare(a.it.publishedAt ?? ""),
    )
    .map((x) => x.it);
}

/** 卡脚小字备注：来源网站（新闻综合主源）+ 交叉验证网站（指数核验源）+ 数据时间（条目最新日期）。
 *  - source：取首个「非公告流」源（真正贡献盘面解读素材的综合新闻源，如港股=新浪港股）；
 *  - crossCheck：统一取指数核验源 indexChannel（= 新浪行情 API，恒指/道指等点位由它独立核验）；
 *  - 全部取自真实字段，非 LLM 生成。 */
function buildMeta(
  items: StockItem[],
  indexChannel?: string,
): { source: string; date: string; crossCheck: string } {
  const allSrcs = [...new Set(items.map((i) => (i.source ?? "").trim()).filter(Boolean))];
  const newsSrcs = allSrcs.filter((s) => !ANNOUNCEMENT_SOURCES.includes(s));
  const dates = items
    .map((i) => i.publishedAt ?? "")
    .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort()
    .reverse();
  return {
    // 优先取新闻综合主源；若该市场只有公告流（极端），fallback 取首个源，避免空白
    source: newsSrcs[0] ?? allSrcs[0] ?? "",
    // 交叉验证 = 指数核验源（新浪行情）；无行情兜底时退回「第二个新闻源」保持旧行为
    crossCheck: indexChannel ?? newsSrcs[1] ?? allSrcs[1] ?? "",
    date: dates[0] ?? "",
  };
}

function normalizeCard(parsed: unknown): MarketCard {
  const p = (parsed ?? {}) as Partial<MarketCard>;
  const overview = typeof p.overview === "string" ? p.overview.trim() : "";
  const sectors = Array.isArray(p.sectors)
    ? p.sectors.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()).slice(0, 5)
    : [];
  const spoken = typeof p.spoken === "string" && p.spoken.trim() ? p.spoken.trim() : undefined;
  return { overview, sectors, spoken };
}

/**
 * 港股大盘解读权威源：从输入港股条目中挑「收评/综述/复盘」类（标题命中 RECAP 关键词、
 * 且有 url）最新一条，作为 HK 卡「直接看原报告」入口；并作为 LLM 生成 overview 的基准。
 * 2026-08-29 用户：港股大盘解读应锚定新浪财经等权威收评，而非凭零散个股新闻拼凑。
 */
const HK_RECAP_RE = /收评|综述|盘点|盘后|复盘|收市|收盘点评|港股收评|市场总结|港股分析|大势研判/;
export function findHkRecapReport(items: StockItem[]): { title: string; url: string } | undefined {
  const cands = items
    .filter((it) => it.url && HK_RECAP_RE.test(it.title))
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  const best = cands[0];
  return best ? { title: best.title, url: best.url } : undefined;
}

/**
 * 收评兜底（2026-08-26 港股空卡修复）：
 *   LLM 仍返回空卡（罕见，但可能因输入极少 / 模型抽风）→ 用指数点位合成最小复盘，
 *   保证「有输入必出卡，绝不空卡」。
 *   - 若 LLM 已给出非空 overview/spoken → 不覆盖（保留 LLM 质量）
 *   - 若 LLM 给出空 → 用 quotes 合成："{name}收报{value}点（{changePct}）。" 拼成单句
 *   - 若 LLM 给出空 + 无 quotes → 返回 undefined（无法兜底，仍按"全空"视为生成失败）
 */
function synthesizeFallbackCardInternal(
  llmCard: MarketCard,
  quotes: IndexQuote[] | undefined,
): MarketCard | undefined {
  if (llmCard.overview || llmCard.spoken) return llmCard;  // LLM 给了就不覆盖
  if (!quotes || quotes.length === 0) return undefined;
  const lines = quotes.map((q) => {
    const valueStr = q.value ?? "";
    const pctStr = q.changePct ? `（${q.changePct}）` : "";
    return `${q.name}收报${valueStr}点${pctStr}`;
  });
  const sentence = lines.join("；") + "。";
  return { overview: sentence, sectors: [], spoken: sentence };
}

/** 导出供 side-outputs/stock-recap.ts 复用：对 selectStockRecap 返回的空卡**始终**用指数兜底 */
export function synthesizeFallbackCard(
  llmCard: MarketCard,
  quotes: IndexQuote[] | undefined,
): MarketCard | undefined {
  return synthesizeFallbackCardInternal(llmCard, quotes);
}

/**
 * 无 AI 产物时的最小复盘合成（2026-09-01 修：股市板块初始化失败根因）。
 * - SKIP_AI 当日首次运行无 store.json（persisted=undefined）→ selectStockRecap 返回 null；
 * - AI 模式下 generateStockRecap 内 LLM 失败也返回 null。
 * 两者均导致股市解读区整区不渲染。本函数用已成功拉取的行情指数合成最小复盘三卡
 * （overview=指数点位+涨跌幅，纯事实，无投资建议），保证「收盘点位+涨跌幅」筹码
 * 在 SKIP_AI 无缓存 / AI 失败两种场景下都展示完整。
 * 若某市场无指数（quotes 数组空），该卡为空卡（overview=""）——由渲染层显示「暂无数据」，
 * 不再整区跳过。
 */
export function synthesizeRecapFromQuotes(quotes: QuoteResult): StockRecap {
  const emptyCard = (): MarketCard => ({ overview: "", sectors: [] });
  return {
    us: synthesizeFallbackCard(emptyCard(), quotes.quotes.us) ?? emptyCard(),
    aShare: synthesizeFallbackCard(emptyCard(), quotes.quotes.aShare) ?? emptyCard(),
    hk: synthesizeFallbackCard(emptyCard(), quotes.quotes.hk) ?? emptyCard(),
    quoteChannel: quotes.channel,
    quoteDate: quotes.date,
  };
}

export async function generateStockRecap(
  input: StockRecapInput,
  quotes?: QuoteResult | null,
): Promise<StockRecap | null> {
  // 港股输入先排序（收评优先、空泛披露/公告流压后），保证 slice(0,12) 后 LLM 优先看到有信息量的条目
  const payload = {
    date: input.date,
    us: toPayloadItems(input.us),
    aShare: toPayloadItems(input.aShare),
    hk: toPayloadItems(rankHkStockItems(input.hk)),
  };
  // 当日指数收盘（权威行情核验）注入 prompt：LLM 写大盘涨跌有据可依，
  // 不再只能凭新闻标题猜（2026-08-31 用户：港股空话多因缺具体数据）。
  const indexLines: string[] = [];
  if (quotes) {
    const groups: Array<[string, IndexQuote[]]> = [
      ["A股", quotes.quotes.aShare],
      ["港股", quotes.quotes.hk],
      ["美股", quotes.quotes.us],
    ];
    for (const [label, qs] of groups) {
      if (qs.length) {
        indexLines.push(
          `${label}：${qs.map((q) => `${q.name} ${q.value}点${q.changePct ? `（${q.changePct}）` : ""}`).join("、")}`,
        );
      }
    }
  }
  const userPrompt = [
    RULES,
    "",
    `当日股市条目（JSON）：`,
    JSON.stringify(payload),
    "",
    `当日指数收盘（权威行情核验，写各市场大盘涨跌时优先引用；未列出的市场表示本轮未取到指数）：`,
    ...(indexLines.length ? indexLines : ["（本轮未取到指数数据，只能据新闻条目定性描述）"]),
    "",
    '请输出 {"us":{...},"aShare":{...},"hk":{...}}，三市场各含 overview(单句大盘总结≤35字)/sectors(3-5个)/spoken(≤120字纯口语)。输入为空的市场输出空卡。',
  ].join("\n");
  try {
    const { text } = await runLlm(
      { systemPrompt: SYSTEM_PROMPT, userPrompt, timeoutMs: 180_000 },
      { stage: "stock-recap" },
    );
    const cleaned = extractJson(text);
    let parsed: { us?: unknown; aShare?: unknown; hk?: unknown };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const jsonrepair = (await import("jsonrepair")).jsonrepair;
      parsed = JSON.parse(jsonrepair(cleaned));
    }
    const llmCards: StockRecap = {
      us: normalizeCard(parsed.us),
      aShare: normalizeCard(parsed.aShare),
      hk: normalizeCard(parsed.hk),
    };
    // 收评兜底（2026-08-26 港股空卡修复）：LLM 仍空 → 用指数点位合成最小复盘
    const recap: StockRecap = {
      us: synthesizeFallbackCard(llmCards.us, quotes?.quotes.us) ?? llmCards.us,
      aShare: synthesizeFallbackCard(llmCards.aShare, quotes?.quotes.aShare) ?? llmCards.aShare,
      hk: synthesizeFallbackCard(llmCards.hk, quotes?.quotes.hk) ?? llmCards.hk,
    };
    // 附带卡脚小字备注（来源网站/交叉验证网站/数据时间取自输入条目真实字段，非 LLM 臆造；SKIP_AI 复用 store 时一并带回）
    // crossCheck 统一为指数核验源「新浪行情」（quotes.channel），披露易等公告流不进主位
    recap.us.meta = buildMeta(input.us, quotes?.channel);
    recap.aShare.meta = buildMeta(input.aShare, quotes?.channel);
    recap.hk.meta = buildMeta(input.hk, quotes?.channel);
    // 港股大盘解读权威源：锚定新浪财经等收评/总结报告（卡内展示「直接看原报告」入口）
    recap.hk.sourceReport = findHkRecapReport(input.hk);
    // 行情指数（新浪行情 API，非 LLM）：挂到三卡 + 顶层来源/取值日，随 store 持久化、SKIP_AI 复用
    if (quotes) {
      recap.aShare.indices = quotes.quotes.aShare;
      recap.hk.indices = quotes.quotes.hk;
      recap.us.indices = quotes.quotes.us;
      recap.quoteChannel = quotes.channel;
      recap.quoteDate = quotes.date;
    }
    // 三卡全空（极少：三市场均无输入且无 quotes）→ 视为生成失败，页面不渲染该区
    const empty =
      !recap.us.overview && !recap.us.spoken && recap.us.sectors.length === 0 &&
      !recap.aShare.overview && !recap.aShare.spoken && recap.aShare.sectors.length === 0 &&
      !recap.hk.overview && !recap.hk.spoken && recap.hk.sectors.length === 0;
    if (empty) return null;
    return recap;
  } catch (e) {
    // 2026-09-03 修复（#133 实锤）：原来 catch{} 静默吞错——LLM 失败后股市区退化为纯指数
    // 合成口播（0 板块/时长不合格），CI 日志却无任何 [llm]/[recap] 失败行，无法定位根因。
    // 此处补一条带 stage + 错误摘要的 warn（runLlm 内部已有 3 次指数退避重试，不在此叠加）。
    const msg = (e as Error)?.message ?? String(e);
    console.warn(
      `[recap] stock-recap 生成失败，回退行情指数合成最小复盘三卡: ${msg.slice(0, 200)}`,
    );
    return null;
  }
}

/**
 * 读改写 history/<date>/store.json：保留 executive 等既有字段，写入 stock_recap。
 * 与 executive-summary.writeStore 互补——两者都对该文件做 read-modify-write，
 * 调用顺序无关（谁先谁后都不会覆盖对方的字段）。
 */
export function writeStockRecap(date: string, recap: StockRecap, opts: { baseDir?: string } = {}): void {
  try {
    const dir = path.resolve(opts.baseDir ?? process.cwd(), "history", date);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "store.json");
    let obj: Record<string, unknown> = { date, updatedAt: new Date().toISOString() };
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        if (raw && typeof raw === "object") obj = raw as Record<string, unknown>;
      } catch {
        // 损坏则覆盖重建
      }
    }
    obj.date = date;
    obj.updatedAt = new Date().toISOString();
    obj.stock_recap = recap;
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // 归档失败不打断主流程
  }
}

/** 读取 history/<date>/store.json 的 stock_recap 字段；缺失或损坏返回 undefined。 */
export function loadStockRecap(date: string, opts: { baseDir?: string } = {}): StockRecap | undefined {
  const p = path.resolve(opts.baseDir ?? process.cwd(), "history", date, "store.json");
  try {
    if (!fs.existsSync(p)) return undefined;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const r = raw?.stock_recap;
    if (r && r.us && r.aShare && r.hk) return r as StockRecap;
  } catch {
    // 忽略损坏
  }
  return undefined;
}

/**
 * 解析当日股市复盘（与 selectExecutiveSummary 同语义）：
 * - SKIP_AI：仅复用持久化资产（history/<date>/store.json 的 stock_recap），绝不调 LLM。
 * - forceRegen：忽略已存在归档，强制调 generate。
 * - 正常（无 forceRegen）：优先复用持久化，缺失才回退 generate。
 */
export async function selectStockRecap(opts: {
  skipAi: boolean;
  persisted: StockRecap | undefined;
  generate: () => Promise<StockRecap | null>;
  forceRegen?: boolean;
}): Promise<StockRecap | null> {
  if (opts.skipAi) return opts.persisted ?? null;
  if (opts.forceRegen) return await opts.generate();
  return opts.persisted ?? (await opts.generate());
}
