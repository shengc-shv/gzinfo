/**
 * Pass 1 — AI 筛选分类（文档第 5 节）。
 *
 * 核心设计：AI 只给「判断」，不给「事实」。每条结果按 URL 回 join 输入池，
 * title/source/date/raw_text 一律以池为准；AI 仅提供
 * keep/section/source_type/locale/locale_evidence/tags/title_cn/title_orig/importance_candidate。
 *
 * 早期校验（fail fast，比等 Pass 2 返工便宜）：
 *  - AI 返回池外 URL → 丢弃并记 warn
 *  - keep=true 但标题/原标题命中违禁词 → 早筛丢弃
 *  - locale=gz 但证据非原文子串 → 降级为 national（丢地域资格不丢内容）
 *  - section=gz_local 但 locale≠gz → 改归 biz_insight
 *  - section/tags/importance/source_type 非法值 → 落回默认值
 *
 * 单批失败：不抛异常拖垮整次运行，该批按丢弃处理并记 error 日志。
 */
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { ALLOWED_TAGS, BANNED_WORDS, SECTIONS } from "./validator";
import { buildPass1User, PASS1_SYSTEM } from "./prompts";
import type {
  Locale,
  ReportSectionKey,
  SourceType,
} from "../types";

/** Pass 1 输入：经归一化的文章池（字段以输入池为准）。 */
export interface Pass1Input {
  url: string;
  title: string;
  source: string;
  /** MM/DD */
  date: string;
  /** 截断至 1200 字 */
  raw_text: string;
  /** 软提示（不强制 AI 采用）：原始采集分类。 */
  category?: string;
  /**
   * 本地关键词提权（2026-08-21 第二梯队）：标题命中广州锚词
   * （广州/穗/天河/海珠/琶洲 等，与 GZ_ANCHOR_RE 同源）→ true。
   * 目的：标题含明确广州地名的条目，降低被「保留标准第2~4条」门槛
   * 刷掉的概率（Pass 1 倾向判 locale=gz / section=gz_local）。
   */
  gz_hint?: boolean;
}

/** Pass 1 保留条目（标题/来源/日期/原文来自池，其余来自 AI 判断）。 */
export interface Pass1Item {
  url: string;
  /** 原标题（来自池） */
  title: string;
  /** AI 翻译/照抄的中文标题 */
  title_cn: string;
  title_orig?: string;
  source: string;
  source_type: SourceType;
  date: string;
  tags: string[];
  locale: Locale;
  locale_evidence?: string;
  section: ReportSectionKey;
  /** importance 候选（1/2/3），Pass 2 终排时再裁定 */
  importance_candidate: 1 | 2 | 3;
  /** 来自池（供 Pass 2 证据校验与降维使用，落盘前清理） */
  raw_text: string;
}

/** LLM 调用封装（可注入 mock 便于测试）。 */
export type LlmRunner = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

const defaultRunner: LlmRunner = (systemPrompt, userPrompt) =>
  runLlm(
    {
      systemPrompt,
      userPrompt,
      timeoutMs: 240_000,
      model: process.env.PASS1_MODEL?.trim() || undefined,
    },
    { stage: "pass1" },
  ).then((r) => r.text);

const BATCH_SIZE = 30;

function normalizeSection(s: unknown): ReportSectionKey {
  return SECTIONS.includes(s as ReportSectionKey)
    ? (s as ReportSectionKey)
    : "biz_insight";
}
function normalizeLocale(l: unknown): Locale {
  return l === "gz" || l === "national" || l === "overseas" ? l : "national";
}
function normalizeSourceType(t: unknown): SourceType {
  return t === "official" || t === "media" ? t : "media";
}
function normalizeImportance(i: unknown): 1 | 2 | 3 {
  return i === 3 || i === 1 ? i : 2;
}
function normalizeTags(t: unknown): string[] {
  if (!Array.isArray(t)) return [];
  const allowed = new Set<string>(ALLOWED_TAGS);
  return Array.from(new Set(t.filter((x) => allowed.has(String(x))))).slice(0, 6);
}
function hitsBanned(s: string): boolean {
  return BANNED_WORDS.some((w) => s.includes(w));
}

/**
 * 对单批输入调用 LLM，返回 URL → AI 判断 的字典；解析失败重试后再放弃（记 warn）。
 *
 * 2026-08-31 加重试：BATCH_SIZE=30 而实际每日进管线的常只有 20 条左右 →
 * **一批就是全部**。一次坏 JSON（实测 `Colon expected at position 2457`）就会把
 * 当日正文整批丢弃，报告静默退化成「只有历史滚动条目」（实测 policy_market 9 → 3）。
 * LLM 输出有随机性，重试一次通常就能拿到合法 JSON；与 PASS2 的
 * MAX_PASS2_RETRY 回炉机制同一思路。成功路径零额外成本（只在失败时才多调一次）。
 */
const PASS1_BATCH_RETRY = 1;

async function runPass1Batch(
  batch: Pass1Input[],
  runner: LlmRunner,
): Promise<Map<string, any>> {
  const payload = batch.map((a) => ({
    url: a.url,
    title: a.title,
    source: a.source,
    date: a.date,
    raw_text: a.raw_text,
    ...(a.category ? { category: a.category } : {}),
    ...(a.gz_hint ? { gz_hint: true } : {}),
  }));
  const userPrompt = buildPass1User(JSON.stringify(payload));
  for (let attempt = 1; attempt <= PASS1_BATCH_RETRY + 1; attempt++) {
    try {
      const raw = await runner(PASS1_SYSTEM, userPrompt);
      const cleaned = extractJson(raw);
      let parsed: { items?: any[] };
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        const { jsonrepair } = await import("jsonrepair");
        parsed = JSON.parse(jsonrepair(cleaned));
      }
      const map = new Map<string, any>();
      for (const it of parsed.items ?? []) {
        if (it && typeof it.url === "string") map.set(it.url, it);
      }
      if (map.size === 0 && batch.length > 0) {
        // 解析成功但一条都没回 → 多半是 LLM 吐了空壳，同样按失败处理触发重试
        throw new Error("解析成功但 items 为空（LLM 返回空壳）");
      }
      if (attempt > 1) {
        console.log(`[pass1] 第 ${attempt} 次尝试成功，挽回 ${map.size} 条`);
      }
      return map;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt <= PASS1_BATCH_RETRY) {
        console.warn(`[pass1] 批次解析失败（第 ${attempt} 次，重试中）: ${msg}`);
        continue;
      }
      console.warn(`[pass1] 批次调用失败（${batch.length} 条按丢弃）: ${msg}`);
      return new Map();
    }
  }
  return new Map();
}

/**
 * 运行 Pass 1：分批并行（默认 30/批），AI 只给判断；早期校验 fail-fast；
 * 保留条目按原输入池顺序稳定排序后返回（保证可复现）。
 */
export async function runPass1(
  inputs: Pass1Input[],
  runner: LlmRunner = defaultRunner,
): Promise<Pass1Item[]> {
  if (inputs.length === 0) return [];
  const pool = new Map(inputs.map((a) => [a.url, a]));

  // 分批并行
  const batches: Pass1Input[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    batches.push(inputs.slice(i, i + BATCH_SIZE));
  }
  const batchMaps = await Promise.all(
    batches.map((b) => runPass1Batch(b, runner)),
  );

  const kept: Pass1Item[] = [];
  for (const a of inputs) {
    const ai = batchMaps
      .find((m) => m.has(a.url))
      ?.get(a.url);
    if (!ai) continue; // 该批解析缺失此条 → 视为丢弃
    if (ai.keep !== true) continue;

    // 早期校验①：池外 URL（理论上不会，因 map key 来自池，这里双保险）
    if (!pool.has(a.url)) {
      console.warn(`[pass1] 池外 URL 丢弃: ${a.url}`);
      continue;
    }
    // 早期校验②：keep=true 但标题/原标题命中违禁词 → 早筛丢弃
    if (hitsBanned(a.title) || hitsBanned(ai.title_orig ?? "")) {
      console.warn(`[pass1] 违禁词早筛丢弃: ${a.url}`);
      continue;
    }

    let locale = normalizeLocale(ai.locale);
    let locale_evidence: string | undefined = ai.locale_evidence
      ? String(ai.locale_evidence)
      : undefined;
    // 早期校验③：locale=gz 但证据非原文子串 → 降级为 national（丢地域资格不丢内容）
    // gz_hint 提权（2026-08-21）：标题命中广州锚词的条目，证据允许取自标题
    // （本地媒体报道标题自带广州地名，无需正文重复出现）。
    if (locale === "gz") {
      const evidenceOk =
        (locale_evidence && a.raw_text.includes(locale_evidence)) ||
        (a.gz_hint && locale_evidence && a.title.includes(locale_evidence));
      if (!evidenceOk) {
        locale = "national";
        locale_evidence = undefined;
        console.warn(`[pass1] locale=gz 证据非原文子串 → 降级 national: ${a.url}`);
      }
    }
    let section = normalizeSection(ai.section);
    // 早期校验④：section=gz_local 但 locale≠gz → 改归 biz_insight
    if (section === "gz_local" && locale !== "gz") {
      section = "biz_insight";
    }

    kept.push({
      url: a.url,
      title: a.title,
      title_cn: (ai.title_cn || a.title || "").trim() || a.title,
      title_orig: ai.title_orig ? String(ai.title_orig) : undefined,
      source: a.source,
      source_type: normalizeSourceType(ai.source_type),
      date: a.date,
      tags: normalizeTags(ai.tags),
      locale,
      locale_evidence,
      section,
      importance_candidate: normalizeImportance(ai.importance_candidate),
      raw_text: a.raw_text,
    });
  }
  return kept;
}
