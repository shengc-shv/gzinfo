/**
 * Pass 2 — AI 总编辑成稿（文档第 6 节）。
 *
 * 必须单次调用拿到全量保留条目（去重与 importance 全局分布无法在分批下完成）。
 * 输入条目含 raw_text（证据校验需要，上下文过长是二次截断到 600 字）。
 * AI 只新增 summary + importance；url/title_cn/title_orig/source/source_type/
 * date/tags/locale/locale_evidence 及板块归属照抄 kept（PASS1 判定）。
 *
 * 返回后由管线调用 _ensure_schema + finalize_ranks，再跑 13 条校验。
 */
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { ALLOWED_TAGS, SECTIONS } from "./validator";
import { buildPass2User, PASS2_SYSTEM } from "./prompts";
import { rollUpTags } from "../classify/tag-rollup";
import { type LlmRunner } from "./pass1";
import type {
  DailyReport,
  ReportItem,
  ReportSectionKey,
} from "../types";

/** Pass 2 输入条目回传（含 AI 在 PASS1 已判定的字段，供其照抄）。 */
const PASS2_INPUT_TRUNCATE = 600;

const defaultRunner: LlmRunner = (systemPrompt, userPrompt) =>
  runLlm(
    {
      systemPrompt,
      userPrompt,
      timeoutMs: 240_000,
      model: process.env.PASS2_MODEL?.trim() || undefined,
    },
    { stage: "pass2" },
  ).then((r) => r.text);

function normalizeImportance(i: unknown): 1 | 2 | 3 {
  return i === 3 || i === 1 ? i : 2;
}
function normalizeTags(t: unknown): string[] {
  if (!Array.isArray(t)) return [];
  const allowed = new Set<string>(ALLOWED_TAGS);
  return Array.from(new Set(t.filter((x) => allowed.has(String(x))))).slice(0, 6);
}

function assembleItem(kept: KeptLookup, ai: any): ReportItem {
  const base = kept.base;
  return {
    url: base.url,
    title_cn: (ai?.title_cn || base.title_cn || "").trim() || base.title_cn,
    title_orig: ai?.title_orig ?? base.title_orig,
    source: base.source,
    source_type: base.source_type,
    date: base.date,
    summary: (ai?.summary || "").trim(),
    importance: normalizeImportance(ai?.importance),
    rank: 0,
    tags: rollUpTags({ tags: normalizeTags(ai?.tags ?? base.tags) }),
    locale: base.locale,
    locale_evidence: base.locale_evidence,
  };
}

interface KeptLookup {
  base: import("./pass1").Pass1Item;
}

/**
 * 运行 Pass 2：单次调用产出终稿。返回已补全 schema 但未 rank 的报告
 * （rank 由管线 finalizeRanks 生成）。
 */
export async function runPass2(
  kept: import("./pass1").Pass1Item[],
  runner: LlmRunner = defaultRunner,
  feedback?: string,
): Promise<DailyReport> {
  const byUrl = new Map(kept.map((k) => [k.url, k]));
  const payload = kept.map((k) => ({
    url: k.url,
    title_cn: k.title_cn,
    title_orig: k.title_orig,
    source: k.source,
    source_type: k.source_type,
    date: k.date,
    tags: k.tags,
    locale: k.locale,
    locale_evidence: k.locale_evidence,
    section: k.section,
    raw_text: k.raw_text.slice(0, PASS2_INPUT_TRUNCATE),
  }));
  const userPrompt = buildPass2User(JSON.stringify(payload), feedback);
  let parsed: any = {};
  try {
    const raw = await runner(PASS2_SYSTEM, userPrompt);
    const cleaned = extractJson(raw);
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const { jsonrepair } = await import("jsonrepair");
      parsed = JSON.parse(jsonrepair(cleaned));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[pass2] 调用失败，回退空报告: ${msg}`);
    parsed = {};
  }

  const sections: DailyReport["sections"] = {
    gz_local: [],
    biz_insight: [],
    policy_market: [],
    tech: [],
    ipo: [],
  };
  for (const sec of SECTIONS) {
    const arr = parsed?.sections?.[sec];
    if (!Array.isArray(arr)) continue;
    for (const ai of arr) {
      if (!ai || typeof ai.url !== "string") continue;
      const base = byUrl.get(ai.url);
      if (!base) continue; // 池外 url 不纳入（R1 兜底）
      sections[sec].push(assembleItem({ base }, ai));
    }
  }

  const insights = Array.isArray(parsed?.insights)
    ? parsed.insights
        .filter((x: any) => x && typeof x === "object")
        .slice(0, 5)
        .map((x: any) => ({
          topic: String(x.topic ?? ""),
          tags: normalizeTags(x.tags),
          impact: String(x.impact ?? ""),
          action: String(x.action ?? ""),
          ...(x.related_url ? { related_url: String(x.related_url) } : {}),
        }))
    : [];

  const must_read = Array.isArray(parsed?.must_read)
    ? parsed.must_read
        .filter((x: any) => x && typeof x.url === "string")
        .slice(0, 5)
        .map((x: any) => ({ url: String(x.url), why: String(x.why ?? ""), ...(x.title ? { title: String(x.title) } : {}) }))
    : [];

  return {
    date: "",
    hero_line: typeof parsed?.hero_line === "string" ? parsed.hero_line : "",
    must_read,
    insights,
    sections,
  };
}

/** _ensure_schema：补齐缺失键，保证后续校验/渲染不崩。 */
export function ensureSchema(report: DailyReport): void {
  if (typeof report.date !== "string") report.date = "";
  if (typeof report.hero_line !== "string") report.hero_line = "";
  if (!Array.isArray(report.must_read)) report.must_read = [];
  if (!Array.isArray(report.insights)) report.insights = [];
  if (!report.sections || typeof report.sections !== "object") {
    report.sections = {
      gz_local: [],
      biz_insight: [],
      policy_market: [],
      tech: [],
      ipo: [],
    };
  }
  for (const sec of SECTIONS) {
    if (!Array.isArray(report.sections[sec])) report.sections[sec] = [];
  }
}

/**
 * finalize_ranks：rank 由代码生成，不交给模型。
 * 板块内按 importance 降序、must_read 命中优先、同级保持 AI 原序（list.sort 稳定），
 * 编号从 1。返回是否变更（便于测试）。
 */
export function finalizeRanks(report: DailyReport): void {
  const mustSet = new Set(report.must_read.map((m) => m.url).filter(Boolean));
  for (const sec of SECTIONS) {
    const items = report.sections[sec];
    items.sort((a, b) => {
      const am = mustSet.has(a.url) ? 1 : 0;
      const bm = mustSet.has(b.url) ? 1 : 0;
      if (am !== bm) return bm - am; // must_read 优先
      return (b.importance ?? 2) - (a.importance ?? 2); // importance 降序
    });
    items.forEach((it, i) => (it.rank = i + 1));
  }
}
