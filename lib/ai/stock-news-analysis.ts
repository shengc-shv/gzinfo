import fs from "node:fs";
import path from "node:path";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import type { StockNewsItem } from "../types";

/**
 * 股市消息清单 AI 分析（2026-08-25 用户：与其它板块同逻辑，预分析由 WorkBuddy、线上由 LLM）。
 *
 * 对底部「股市动态」面板的原始三市场新闻逐条做中性事实归纳：
 * - summary：1-2 句中文事实摘要（发生了什么、关键数字/公司/事件）；
 * - tags：2-4 个主题标签（财报/半导体/能源/政策/中概股/AI…），**不打业务线标签**；
 * - importance：1-3（按市场影响度）。
 *
 * ⚠️ 红线（沿用 stock-recap 口径）：纯市场事实，**严禁投资建议、严禁引申到
 * 零售/私行/财富/信贷等银行业务 actionable 结论**——股市板块只做信息呈现，不做业务引申。
 */

const SYSTEM_PROMPT = `你是财经新闻编辑。下面是一批「昨日股市」原始新闻条目（A股/港股/美股）。
请为每条做中文事实归纳，输出一个 JSON 数组，顺序与输入一一对应。
每条对象字段：
- i: 输入条目序号（原样返回）
- summary: 1-2 句中性事实摘要（发生了什么、关键数字/公司/事件），基于标题与来源事实，禁止编造
- tags: 2-4 个主题标签（如 财报/半导体/能源/政策/中概股/AI/医药/地产），不要「客群/私行/财富/信贷」等业务线标签
- importance: 1-3（按市场影响度，3=重大）

红线：只做事实呈现，禁止投资建议（不写"建议买入/观望"）、禁止引申到银行业务 actionable 结论。`;

export async function analyzeStockNews(items: StockNewsItem[]): Promise<StockNewsItem[]> {
  if (!items.length) return items;
  const payload = items.map((it, i) => ({
    i,
    market: it.market,
    title: it.title_cn || it.title_orig || "",
    source: it.source || "",
    date: it.date || "",
  }));
  const userPrompt = [
    "股市新闻条目（JSON）：",
    JSON.stringify(payload),
    "",
    '请输出 JSON 数组，每项 {i, summary, tags, importance}。',
  ].join("\n");
  try {
    const { text } = await runLlm(
      { systemPrompt: SYSTEM_PROMPT, userPrompt, timeoutMs: 180_000 },
      { stage: "stock-news" },
    );
    const cleaned = extractJson(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const jsonrepair = (await import("jsonrepair")).jsonrepair;
      parsed = JSON.parse(jsonrepair(cleaned));
    }
    if (!Array.isArray(parsed)) return items;
    const byI = new Map<number, { summary?: string; tags?: unknown; importance?: unknown }>();
    for (const x of parsed as Array<Record<string, unknown>>) {
      const idx = typeof x?.i === "number" ? x.i : -1;
      if (idx >= 0) byI.set(idx, x);
    }
    return items.map((it, i) => {
      const a = byI.get(i);
      if (!a) return it;
      const summary = typeof a.summary === "string" && a.summary.trim() ? a.summary.trim() : it.summary;
      const tags = Array.isArray(a.tags)
        ? a.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 4)
        : it.tags;
      const impRaw =
        typeof a.importance === "number" && a.importance >= 1 && a.importance <= 3 ? a.importance : it.importance;
      const importance = (impRaw >= 3 ? 3 : impRaw <= 1 ? 1 : impRaw) as 1 | 2 | 3;
      return { ...it, summary, tags, importance };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[stock-news] ⚠️ AI 归纳失败，回退原始摘要（继续）: ${msg}`);
    return items;
  }
}

/** 读改写 history/<date>/store.json：写入 stock_news（AI 归纳结果），随 SKIP_AI 复用。 */
export function writeStockNews(date: string, items: StockNewsItem[], opts: { baseDir?: string } = {}): void {
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
    obj.stock_news = items;
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // 归档失败不打断主流程
  }
}

/** 读取 history/<date>/store.json 的 stock_news；缺失/损坏返回 undefined。 */
export function loadStockNews(date: string, opts: { baseDir?: string } = {}): StockNewsItem[] | undefined {
  const p = path.resolve(opts.baseDir ?? process.cwd(), "history", date, "store.json");
  try {
    if (!fs.existsSync(p)) return undefined;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const arr = raw?.stock_news;
    if (Array.isArray(arr) && arr.length > 0) return arr as StockNewsItem[];
  } catch {
    // 忽略损坏
  }
  return undefined;
}
