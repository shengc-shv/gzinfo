import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { titleSimilarityDice } from "../ingest/dedup-similar";
import fs from "node:fs";
import path from "node:path";

/**
 * 「执行摘要 / 商机提示」AI 层（用户 2026-08-19 确认实施）
 *
 * 每天一次 LLM 调用，基于当日 宏观政策(finance) + 广州商机(gz) 的高信号条目
 * 与市场点评，产出：
 *  - must_read：今日必读 3-5 条（高影响事件 + 对分行意味着什么）
 *  - insights：商机提示 3-5 条（对广州分行零售/对公的潜在影响 + 建议动作）
 * 把「看新闻」升级为「看结论」。任何失败 → 返回 null，页面不渲染该板块。
 */

export interface ExecInsight {
  /** 主题（一句话，如「LPR 下调预期升温」） */
  topic: string;
  /** 对分行零售/对公业务的潜在影响 */
  impact: string;
  /** 建议动作（获客/产品/风险，可执行） */
  action: string;
  /** 业务线标签（2026-08-21 重构）：从词表选 1-2 个，如 竞对动态/信贷/代发/私行/政银合作/住房金融/财富/客群 */
  tag?: string[];
  /** 来源链接（可选，1-3 条）：引用输入中相关源文章（title+url 原样复制），供读者溯源 */
  sources?: Array<{ title: string; url: string }>;
}

export interface ExecutiveSummary {
  /** 今日定调（2026-08-21 重构）：一句话总编辑视角，3 秒 get 今天主题；无则页面不渲染 hero-line */
  hero_line?: string;
  /** 今日必读：高影响事件 + 为何重要 + 源链接（可空：旧归档/AI 未回链时渲染不包 <a>） */
  must_read: Array<{ title: string; why: string; url?: string }>;
  /** 商机提示：对广州分行零售/对公的潜在影响与建议动作 */
  insights: ExecInsight[];
  /** 口播稿：今日定调（主播解读感：60字左右完整句，事件+应对建议，纯口语） */
  spoken_hero?: string;
  /** 口播稿：今日必读（主播解读感：5条左右，每条=事件+应对建议，独立成句换行，≤280字，纯口语） */
  spoken_must_read?: string;
  /** 口播稿：商机洞察（每条=事件+应对建议，多条换行，≤240字，纯口语） */
  spoken_insights?: string;
  /** 广东/广州 IPO 企业动态口播（≤60字）；当日无相关动态时为 null */
  guangdong_ipo?: { spoken?: string } | null;
}

export interface ExecSummaryInput {
  /** 当日宏观政策条目（title + 摘要 + 源链接） */
  finance: Array<{ title: string; summary?: string; subcategory?: string; url?: string }>;
  /** 当日广州商机条目（title + 摘要 + 源链接） */
  gz: Array<{ title: string; summary?: string; subcategory?: string; url?: string }>;
  /** 市场行情总览（AI 点评，可选） */
  marketOverview?: string;
  /** IPO 板块条目（用于筛广东/广州 IPO 动态口播，可选） */
  ipo?: Array<{ title?: string; summary?: string; url?: string }>;
  /** 报告日期 YYYY-MM-DD */
  date: string;
}

const SYSTEM_PROMPT =
  "你是股份行广州分行零售决策简报主编。基于当日信息生成「今日必读」与「商机提示」，面向分行信息技术部领导和分管零售的行领导，严格按用户要求输出 JSON。";

const RULES = `你是股份行广州分行零售决策简报的主编。系统面向分行信息技术部领导和分管零售的行领导，核心诉求：更快掌握宏观经济变化、政府政策变化、市场变化，从而挖掘更多客户、发现更多商机。

基于输入的当日条目（宏观政策 + 广州商机 + 市场总览 + IPO），输出四部分：

0. hero_line（今日定调，1 句话）：以"总编辑"视角提炼今天最值得分行领导关注的一件事，50 字以内，一句话讲清"今天主题是什么、对分行意味着什么"。例："中行'算力Token贷'在穗抢跑落地，同业以新风控逻辑圈占科创轻资产客群，分行需尽快评估应对。" 若当日无突出主题可省略（输出空字符串）；并为该定调配套口播稿 spoken_hero（"主播解读感"：60 字左右完整句，先讲事件再给应对建议，如"消费贷贴息集体扩围，价格战升级，建议分行统一口径抢抓窗口"，与 hero_line 结论一致；纯口语、无链接/无Markdown/无emoji，可直接朗读，严禁照读 hero_line 原文）。

1. must_read（今日必读，3-5 条）：从输入中挑出对广州分行领导"今天最该知道"的高影响事件（如降准降息、LPR、社融、广州产业政策、广州本地金融动态、重要市场转折）。每条：
   - title：事件标题（15 字内，中文，可精简）
   - why：为什么重要——对广州分行零售/对公意味着什么（30-50 字）
   - url：源链接，从下方输入对应条目的 url 字段原样复制（若对不上可省略，留空）
   ；并为今日必读整体配套口播稿 spoken_must_read（"主播解读感"：5 条左右，每条 = 事件一句话 + 应对建议一句话（各 30-50 字），独立成句、句号收尾、换行分隔形成气口停顿；总字数≤280 字；讲清"发生了什么+分行怎么做"，严禁逐条照读标题与全文，不念链接与来源名）。

2. insights（商机提示，3-5 条）：把当日信息转化为"在广州可落地的商机/风险"，每条：
   - topic：主题（15 字内）
   - impact：对广州分行零售/对公业务的潜在影响（40-60 字）
   - action：建议动作——具体可执行（获客方向/产品配置/风险提示，40-60 字），如"关注消费贷客群、加大理财配置推荐、提示按揭风险"
   - tag：业务线标签数组，从词表选 1-2 个（词表：竞对动态/信贷/代发/私行/政银合作/住房金融/财富/客群/监管/科技金融）
   - sources：来源链接数组（1-3 条，必填优先）。每条为输入中直接支撑该洞察的源文章，原样复制其 {title,url}（url 从输入对应条目复制，不得编造）。若洞察由多条输入综合得出，列最权威的 1-3 条；若确实无任何输入支撑则该字段省略。
   ；并为商机洞察整体配套口播稿 spoken_insights（每条 = 事件一句话 + 应对建议一句话（各 30-45 字），多条各占一行、句号收尾换行分隔形成气口停顿；每条≤60 字、总字数≤240 字；讲清"机会在哪+怎么落"，不要铺陈成段落，不念表格）。

3. guangdong_ipo（广东/广州企业 IPO 动态，1 条或 null）：若输入 ipo 条目中存在"广东/广州企业"的 IPO 相关进展（过会、注册生效、申购、招股、上市敲钟等），则产出 guangdong_ipo.spoken（≤60字，说清企业名称、上市板块与最新进展，一两句话）；若无广东/广州 IPO 动态，则 guangdong_ipo 设为 null（不要编造）。

要求：
- 只基于输入信息，不要编造
- 广州本地信息（南沙/广州企业/广州政策）优先于泛全国信息
- 语言精炼，站在分行行长视角，不写空话套话
- spoken_* 口播稿均为纯文本：无 Markdown、无链接、无 emoji、无 # * | \` 等符号，可直接朗读；口播稿是"二次提炼的主播语态"，严禁把 hero_line/must_read/insights 原文整段照读，要浓缩成口语（定调/必读/洞察均为"事件+应对建议"式完整句，每条独立成句、句号收尾、换行分隔形成气口停顿；总口播约 600 字、时长约 2 分钟）
- 输出 STRICTLY 一个 JSON 对象（无 markdown 代码块）：
{"hero_line":"...","spoken_hero":"...","must_read":[{"title":"...","why":"...","url":"..."}],"spoken_must_read":"...","insights":[{"topic":"...","impact":"...","action":"...","tag":["..."],"sources":[{"title":"...","url":"..."}]}],"spoken_insights":"...","guangdong_ipo":{"spoken":"..."} 或 null}
注意：字符串内引号用单引号或中文引号，禁止裸双引号；url 字段原样复制输入中的链接。`;

/**
 * 商机洞察回链来源：insights 为 AI 综合而成，未必带 sources 字段。
 * 用生成时看到的 inputs（finance+gz，每条含真实 url）按「主题+影响+建议」与
 * 条目标题/摘要的 Dice 相似度，取前 1-3 条命中文章作为 ①/②/③ 溯源入口。
 * 双门槛防错链：Dice ≥ 0.16 且 与命中文本共享 ≥ 2 个中文 bigram（有意义字符片段）。
 *  - Dice 单看易错链改写表述（如「存款利率期限拉平」↔「存1年=存2年=存3年存款利率罕见持平」Dice≈0.18 其实是同主题）；
 *  - 共享 bigram 门槛挡掉「托育园/券商中考/博览会」这类完全无关却偶发高 Dice 的错源。
 * 无达标匹配返回空（优雅降级，不臆造）。sources 已在生成时落地 store.json 复用。
 */
function sharedBigramCount(a: string, b: string): number {
  const sa = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) sa.add(a.slice(i, i + 2));
  let n = 0;
  for (let i = 0; i < b.length - 1; i++) {
    if (sa.has(b.slice(i, i + 2))) n++;
  }
  return n;
}

export function resolveInsightSources(
  topic: string,
  impact: string,
  action: string,
  inputs: Array<{ title: string; summary?: string; url?: string }>,
): Array<{ title: string; url: string }> {
  const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  const nh = norm(`${topic} ${impact} ${action}`);
  if (!nh) return [];
  const scored: Array<{ title: string; url: string; score: number }> = [];
  for (const it of inputs) {
    if (!it.url) continue;
    const t = it.title || "";
    const corpus = norm(`${t} ${it.summary || ""}`);
    if (!corpus) continue;
    const dt = titleSimilarityDice(nh, norm(t));
    const dc = titleSimilarityDice(nh, corpus);
    const useCorpus = dc >= dt;
    const score = useCorpus ? dc : dt;
    const shared = useCorpus ? sharedBigramCount(nh, corpus) : sharedBigramCount(nh, norm(t));
    if (score >= 0.16 && shared >= 2) scored.push({ title: t, url: it.url, score });
  }
  const best = new Map<string, { title: string; url: string; score: number }>();
  for (const s of scored) {
    const cur = best.get(s.url);
    if (!cur || s.score > cur.score) best.set(s.url, s);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ title, url }) => ({ title, url }));
}

export async function generateExecutiveSummary(
  input: ExecSummaryInput,
): Promise<ExecutiveSummary | null> {
  const payload = {
    date: input.date,
    market_overview: input.marketOverview ?? "",
    finance: input.finance.slice(0, 12),
    gz: input.gz.slice(0, 12),
    ipo: (input.ipo ?? []).slice(0, 20).map((it) => ({
      title: it.title ?? "",
      summary: it.summary ?? "",
      url: it.url ?? "",
    })),
  };
  const userPrompt = [
    RULES,
    "",
    `当日信息（JSON）：`,
    JSON.stringify(payload),
    "",
    '请输出 {"hero_line":"...","spoken_hero":"...","must_read":[...],"spoken_must_read":"...","insights":[...],"spoken_insights":"...","guangdong_ipo":{...} 或 null}，hero_line 1 句、must_read 3-5 条、insights 3-5 条；spoken_* 与 guangdong_ipo.spoken 按要求字数返回纯口语文本。',
  ].join("\n");
  try {
    const { text } = await runLlm({ systemPrompt: SYSTEM_PROMPT, userPrompt, timeoutMs: 240_000 }, { stage: "executive" });
    const cleaned = extractJson(text);
    let parsed: ExecutiveSummary;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const jsonrepair = (await import("jsonrepair")).jsonrepair;
      parsed = JSON.parse(jsonrepair(cleaned));
    }
    if (!Array.isArray(parsed.must_read) || !Array.isArray(parsed.insights)) return null;
    // 源链接回链：AI 可能漏回 url，用输入 finance/gz 的 url 按标题回匹配注入（更稳，不依赖 LLM 吐 url）
    const normTitle = (t: string) =>
      t.replace(/\s+/g, "").replace(/[，。、：:；;！!？?""'']/g, "").toLowerCase();
    const urlByNorm = new Map<string, string>();
    for (const it of [...input.finance, ...input.gz]) {
      if (it.url) urlByNorm.set(normTitle(it.title), it.url);
    }
    const resolveUrl = (title: string): string | undefined => {
      const k = normTitle(title);
      if (urlByNorm.has(k)) return urlByNorm.get(k);
      for (const [ik, iu] of urlByNorm) {
        if (ik.includes(k) || k.includes(ik)) return iu;
      }
      return undefined;
    };
    return {
      hero_line: typeof parsed.hero_line === "string" ? parsed.hero_line : "",
      spoken_hero: typeof parsed.spoken_hero === "string" && parsed.spoken_hero.trim() ? parsed.spoken_hero.trim() : undefined,
      must_read: parsed.must_read.slice(0, 5).map((m) => ({
        title: m.title,
        why: m.why,
        url: m.url || resolveUrl(m.title),
      })),
      spoken_must_read: typeof parsed.spoken_must_read === "string" && parsed.spoken_must_read.trim() ? parsed.spoken_must_read.trim() : undefined,
      insights: parsed.insights.slice(0, 5).map((it) => {
        // sources：优先用 LLM 显式引源；否则用生成时看到的 inputs（finance+gz，含真实 URL）
        // 按相似度回链 1-3 条来源，保证「商机洞察」卡片有可信溯源入口（不依赖 LLM 吐 url 格式）。
        const explicit = Array.isArray(it.sources) && it.sources.length > 0
          ? it.sources.slice(0, 3).filter((s) => s && s.url).map((s) => ({ title: s.title || "", url: s.url }))
          : [];
        const sources = explicit.length > 0 ? explicit : resolveInsightSources(it.topic, it.impact, it.action, [...input.finance, ...input.gz]);
        return {
          topic: it.topic,
          impact: it.impact,
          action: it.action,
          ...(Array.isArray(it.tag) && it.tag.length > 0 ? { tag: it.tag.slice(0, 2) } : {}),
          ...(sources.length > 0 ? { sources } : {}),
        };
      }),
      spoken_insights: typeof parsed.spoken_insights === "string" && parsed.spoken_insights.trim() ? parsed.spoken_insights.trim() : undefined,
      guangdong_ipo:
        parsed.guangdong_ipo && typeof parsed.guangdong_ipo === "object" && typeof parsed.guangdong_ipo.spoken === "string" && parsed.guangdong_ipo.spoken.trim()
          ? { spoken: parsed.guangdong_ipo.spoken.trim() }
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * 执行摘要跨运行归档（2026-08-20；文件名 2026-08-20 改 store.json）。
 *
 * 背景：data/ai-assets/store.json 被 .gitignore 排除、CI 不提交，SKIP_AI 复用
 * 在 CI 里每次 runner 都是空 {}，README 承诺的「复用 AI 资产」实际从未跨运行生效。
 * 解法：当天生成的执行摘要归档到 history/<date>/store.json（随报告一起提交进 main），
 * SKIP_AI / 正常模式重跑时优先从该文件复用，实现真正的零 LLM 成本重跑。
 * baseDir 参数便于单测隔离（默认 process.cwd()）。
 */
export function writeStore(
  date: string,
  exec: ExecutiveSummary,
  opts: { baseDir?: string } = {},
): void {
  try {
    const dir = path.resolve(opts.baseDir ?? process.cwd(), "history", date);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "store.json"),
      JSON.stringify({ date, updatedAt: new Date().toISOString(), executive: exec }, null, 2),
      "utf8",
    );
  } catch {
    // 归档失败不打断主流程
  }
}

/**
 * 读取 history/<date>/store.json；缺失或损坏返回 undefined。
 * 过渡兼容：若 store.json 不存在，再尝试读旧的 executive.json（一次性迁移后即可删）。
 */
export function loadStore(
  date: string,
  opts: { baseDir?: string } = {},
): ExecutiveSummary | undefined {
  const root = path.resolve(opts.baseDir ?? process.cwd(), "history", date);
  for (const name of ["store.json", "executive.json"]) {
    try {
      const p = path.join(root, name);
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const exec = raw?.executive;
      if (exec && Array.isArray(exec.must_read) && Array.isArray(exec.insights)) return exec as ExecutiveSummary;
    } catch {
      // 尝试下一个候选文件名
    }
  }
  return undefined;
}

/**
 * 解析当日执行摘要来源（2026-08-19 修正 SKIP_AI；2026-08-20 持久化源扩展；
 * 2026-08-20 新增 forceRegen 开关）。
 * - SKIP_AI：仅复用持久化资产（history/<date>/store.json 优先，其次
 *   data/ai-assets 的 daily:<date>.executive），绝不调 LLM，与 README 一致。
 * - forceRegen：忽略已存在归档，强制调 generate（覆盖写），用于手动重新生成。
 *   仅在非 SKIP_AI 模式有意义（SKIP_AI 下忽略，避免无 LLM 却想重算）。
 * - 正常（无 forceRegen）：优先复用持久化，缺失才回退 generate。
 * 纯函数，便于单测；daily.ts 调用。
 */
export async function selectExecutiveSummary(opts: {
  skipAi: boolean;
  persisted: ExecutiveSummary | undefined;
  generate: () => Promise<ExecutiveSummary | null>;
  forceRegen?: boolean;
}): Promise<ExecutiveSummary | null> {
  if (opts.skipAi) return opts.persisted ?? null;
  if (opts.forceRegen) return await opts.generate();
  return opts.persisted ?? (await opts.generate());
}
