import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import fs from "node:fs";
import path from "node:path";
import type { MarketCard, StockRecap } from "../types";

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

/** 单条市场输入（标题 + 摘要 + 源链接）。 */
export interface StockItem {
  title: string;
  summary?: string;
  url?: string;
  source?: string;
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
- overview（涨跌概况，1-2 句）：概括该市场主要指数的涨跌方向与幅度（如"三大指数集体收跌""恒指涨1.2%"），以及最关键的 1 个驱动因素（美联储/地缘/重磅个股/政策）。若无明确指数涨跌数据，据输入条目客观描述盘面强弱（如"科技股领跌、能源走强""成交缩量、观望情绪浓"）。
- sectors（关键板块，3-5 个）：列出当日表现最强的 1-2 个板块与最弱的 1-2 个板块（如"半导体：英伟达财报后大涨""房地产：政策预期落空走弱"），每个板块一句话点明原因。板块名用中文（"半导体""新能源""金融""医药"），不要英文 ticker。
- spoken（口播稿，纯口语 ≤120 字）：把 overview+sectors 浓缩成主播语态的完整句，先讲涨跌概况再点关键板块，句号收尾、可直接朗读。
- spoken 语气对齐内部「今日必读」栏目风格：精炼、客观、陈述式（如"美股三大指数涨跌不一，科技股领涨""A股沪指收跌，贵金属逆市走强"），不铺陈、不抒情、不喊话。

严格要求：
- 只基于输入信息，不要编造指数点位/涨跌幅；若输入未提供具体数字，用"走强/走弱/涨跌互现/集体收跌"等定性描述，绝不臆造精确数字。
- 只做市场事实性概述，**严禁引申到银行零售/对公业务、投资建议、获客动作、风险提示等**（本卡是盘面复盘，不是商机分析）。
- 语言精炼、客观、面向资讯听众，不写空话套话。
- spoken 为纯文本：无 Markdown、无链接、无 emoji、无 # * | \` 等符号，可直接朗读。

输出 STRICTLY 一个 JSON 对象（无 markdown 代码块）：
{"us":{"overview":"...","sectors":["...","..."],"spoken":"..."},"aShare":{"overview":"...","sectors":["..."],"spoken":"..."},"hk":{"overview":"...","sectors":["..."],"spoken":"..."}}
注意：字符串内引号用单引号或中文引号，禁止裸双引号。若某一市场输入为空（无条目），该市场输出 {"overview":"","sectors":[],"spoken":""}。`;

function toPayloadItems(items: StockItem[]): Array<{ title: string; summary: string; source: string }> {
  return items.slice(0, 12).map((it) => ({
    title: it.title,
    summary: it.summary ?? "",
    source: it.source ?? "",
  }));
}

/** 从原始输入条目抽取可点击来源（去重、至多 3 条），供卡片「溯源」按钮使用。
 *  每源至多 2 条：保证交叉验证的两个源（如 A股=东财+新浪）在按钮上都可见，
 *  避免单个源条目多时把另一源挤掉。 */
function toSources(items: StockItem[]): { url: string; title: string }[] {
  const seen = new Set<string>();
  const perSource = new Map<string, number>();
  const out: { url: string; title: string }[] = [];
  for (const it of items) {
    const url = (it.url ?? "").trim();
    if (!url || seen.has(url)) continue;
    const src = (it.source ?? "未知").trim() || "未知";
    if ((perSource.get(src) ?? 0) >= 2) continue;
    seen.add(url);
    perSource.set(src, (perSource.get(src) ?? 0) + 1);
    out.push({ url, title: (it.title ?? "").trim() || url });
    if (out.length >= 3) break;
  }
  return out;
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

export async function generateStockRecap(input: StockRecapInput): Promise<StockRecap | null> {
  const payload = {
    date: input.date,
    us: toPayloadItems(input.us),
    aShare: toPayloadItems(input.aShare),
    hk: toPayloadItems(input.hk),
  };
  const userPrompt = [
    RULES,
    "",
    `当日股市条目（JSON）：`,
    JSON.stringify(payload),
    "",
    '请输出 {"us":{...},"aShare":{...},"hk":{...}}，三市场各含 overview(1-2句)/sectors(3-5个)/spoken(≤120字纯口语)。输入为空的市场输出空卡。',
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
    const recap: StockRecap = {
      us: normalizeCard(parsed.us),
      aShare: normalizeCard(parsed.aShare),
      hk: normalizeCard(parsed.hk),
    };
    // 附带真实来源链接（来源来自原始输入条目，非 LLM 臆造；SKIP_AI 复用 store 时一并带回）
    recap.us.sources = toSources(input.us);
    recap.aShare.sources = toSources(input.aShare);
    recap.hk.sources = toSources(input.hk);
    // 三卡全空（极少：三市场均无输入）→ 视为生成失败，页面不渲染该区
    const empty =
      !recap.us.overview && !recap.us.spoken && recap.us.sectors.length === 0 &&
      !recap.aShare.overview && !recap.aShare.spoken && recap.aShare.sectors.length === 0 &&
      !recap.hk.overview && !recap.hk.spoken && recap.hk.sectors.length === 0;
    if (empty) return null;
    return recap;
  } catch {
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
