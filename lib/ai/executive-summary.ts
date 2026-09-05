import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { titleSimilarityDice } from "../ingest/dedup-similar";
import {
  rankByRelevance,
  scoreBranchRelevance,
  type BranchRelevance,
  type ScorableArticle,
} from "./relevance-score";
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
  /** M 层：今日风险（1 条最值得警惕）。evidence 必填具体事件，impact 按部门拆解 */
  risk?: ExecRisk;
  /** 广东/广州 IPO 企业动态口播（≤60字）；当日无相关动态时为 null */
  guangdong_ipo?: { spoken?: string } | null;
  /** 口播稿：今日定调（主播解读感：60字左右完整句，事件+应对建议，纯口语） */
  spoken_hero?: string;
  /** 口播稿：今日必读（主播解读感：5条左右，每条=事件+应对建议，独立成句换行，≤280字，纯口语） */
  spoken_must_read?: string;
  /** 口播稿：商机洞察（每条=事件+应对建议，多条换行，≤240字，纯口语） */
  spoken_insights?: string;
  /** M 层：风险口播稿（≤80字，行长听到"今天有 1 个需要警惕：xxx，建议 xxx"形式） */
  spoken_risk?: string;
}

/** M 层：单条今日风险（与 ExecInsight 对称） */
export interface ExecRisk {
  topic: string;
  evidence: string;
  impact: string;
  action: string;
  url?: string;
  source?: "T1" | "T1.5" | "T2";
  sources?: Array<{ title: string; url: string }>;
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
  /** B-1：关键词层已识别的风险候选（来自 risk_tracker），喂给 LLM 的 risk 段 */
  riskCandidates?: Array<{ title: string; url?: string; trackers: string[]; priority: string }>;
  /**
   * 内容记忆提示（2026-09-02 去重机制）：近期已播报事件清单 + 若需重播的
   * 建议切入角度。由 lib/memory/event-memory.ts 的 formatMemoryBrief 生成，
   * 原样追加到提示词中，让 LLM 在**生成阶段**就避开重复表述。
   */
  memoryBrief?: string;
  /** 报告日期 YYYY-MM-DD */
  date: string;
}

const SYSTEM_PROMPT =
  "你是股份行广州分行零售决策简报主编。基于当日信息生成「今日必读」与「商机提示」，面向分行信息技术部领导和分管零售的行领导，严格按用户要求输出 JSON。";

const RULES = `你是股份行广州分行零售决策简报的主编。系统面向分行信息技术部领导和分管零售的行领导（即零售分管行长，关注整个零售条线，而非某个部门总经理），核心诉求：更快掌握宏观经济变化、政府政策变化、市场变化，从而挖掘更多客户、发现更多商机。

业务线全覆盖要求（极重要）：读者是零售分管行长，必读与商机须覆盖零售多条业务线，不得只堆个贷/住房金融。财富管理、私人银行、客群经营与新获客、信用卡、代发、养老、住房金融、消费信贷——这些零售条线地位同等，命中高信号时须与房贷/信贷同优先级置顶；若输入中同时存在房贷政策与财富/私行/获客信号，应分别选取、均衡呈现（例如必读里既有房贷40年新规，也应有财富/私行/获客类高信号）。

时间窗口要求（极重要）：必读与商机须覆盖「今天 + 昨天」两天的信息——既含今日凌晨突发的政策/市场信号，也含昨日白天发布、今天仍在生效的重要条目。不要只基于今天单日挑条目；昨天白天的重要宏观政策、权威机构报告若今天仍具决策价值，应纳入。

基于输入的当日条目（宏观政策 + 广州商机 + 市场总览 + IPO），输出五部分：

0. hero_line（今日定调，1 句话）：以"总编辑"视角提炼今天最值得分行领导关注的一件事，50 字以内，一句话讲清"今天主题是什么、对分行意味着什么"。例："中行'算力Token贷'在穗抢跑落地，同业以新风控逻辑圈占科创轻资产客群，建议分行尽快评估应对。" 若当日无突出主题可省略（输出空字符串）；并为该定调配套口播稿 spoken_hero（"主播解读感"：60 字左右完整句，先讲事件再给应对建议，如"消费贷贴息集体扩围，价格战升级，建议分行统一口径抢抓窗口"，与 hero_line 结论一致；纯口语、无链接/无Markdown/无emoji，可直接朗读，严禁照读 hero_line 原文）。

1. must_read（今日必读，3-5 条）— **偏宏观、市场级大信号**：央行/金融监管总局等全国性政策转向、市场重大变化、行业性新趋势、新产品新玩法。答"今天/本周市场可能怎么走"。**只放宏观，不放具体获客动作**（具体动作归 insights）。
   - title：事件标题（15 字内，中文，可精简）
   - why：为什么重要——对广州分行经营规划/战略意味着什么（30-50 字）
   - url：源链接，从下方输入对应条目的 url 字段原样复制（若对不上可省略，留空）
   ；并为今日必读整体配套口播稿 spoken_must_read（"主播解读感"：5 条左右，每条 = 事件一句话 + 对分行经营规划的启示（各 30-50 字），独立成句、句号收尾、换行分隔形成气口停顿；总字数≤300 字；严禁逐条照读标题与全文，不念链接与来源名）。

2. insights（商机提示，3-5 条）— **偏落地、可执行**：具体可落地的获客/产品/客户线索（"哪个客户/产品/动作该做"）。**不放宏观大信号**（宏观归 must_read）；**不放监管威胁**（威胁归 risk）。每条：
   - topic：主题（15 字内）
   - impact：对广州分行零售/对公业务的潜在影响（40-60 字）
   - action：建议动作——具体可执行、带时限感（获客方向/产品配置/风险提示，40-60 字），如"本周走访医疗企业客群、今日起推荐放开限购绩优基金"
   - tag：业务线标签数组，从词表选 1-2 个（词表：竞对动态/信贷/代发/私行/政银合作/住房金融/财富/客群/监管/科技金融）
   - sources：来源链接数组（1-3 条，必填优先）。每条为输入中直接支撑该洞察的源文章，原样复制其 {title,url}（url 从输入对应条目复制，不得编造）。若洞察由多条输入综合得出，列最权威的 1-3 条；若确实无任何输入支撑则该字段省略。
   ；并为商机洞察整体配套口播稿 spoken_insights（每条 = 事件一句话 + 处置动作一句话（各 30-45 字），多条各占一行、句号收尾换行分隔形成气口停顿；每条≤60 字、总字数≤260 字；讲清"机会在哪+本周怎么落"，不要铺陈成段落，不念表格）。

3. risk（M 层：今日风险，1 条或 null）— **偏监管/合规威胁**：今天最值得警惕的 1 件事。**与 must_read/insights 严格错开**：
   - must_read 是宏观机会/趋势，insights 是落地动作，**risk 是"威胁/红线"**（监管处罚/合规风险/系统性风险事件/窗口指导等）
   - **不能同一条事件又当 must_read 又当 risk**（同一事件只在一边出现，避免重复说"同样的事情"）
   - 优先从「关键词层风险候选」（即输入中的 risk_candidates 数组，由 B-1 risk_tracker 预识别）里选 —— 这是关键词 + AI 双轨
   - 若 risk_candidates 都不合适，LLM 可自己从 finance/gz 中识别
   - 无突出风险时，risk 设为 null（不要硬编）
   - topic：风险主题（15 字内，如"央行重申防止资金空转"）
   - evidence：依据（1 句，事件本身，**禁止"市场波动/不确定性增加"这类虚词**，必须可溯源到输入条目）
   - impact：对广州分行零售/对公业务的影响（40-60 字，**按部门拆解**：个贷/财富/私行/公司/风控 受影响的方式）
   - action：建议动作（40-60 字，具体可执行，**带部门**："公司部应…/风控部应…"）
   - source：来源权威等级（T1=央妈/金融监管总局/国务院 / T1.5=交易所/行业协会 / T2=媒体智库）
   - sources：来源链接数组（1-3 条，evidence 依据的输入条目，原样复制 {title,url}）
   ；并配套口播稿 spoken_risk（≤80 字，结构"今天有 1 个需要警惕：[topic]，[impact 一句话]，[action 一句话]"，纯口语、无链接/无 Markdown/无 emoji，每句独立成句、句号收尾）。当日无突出风险时，risk 设为 null（不要硬编），spoken_risk 省略。

4. guangdong_ipo（广东/广州企业 IPO 动态，1 条或 null）：若输入 ipo 条目中存在"广东/广州企业"的 IPO 相关进展，则产出 guangdong_ipo.spoken（≤90字，说清企业名称、注册地、所属行业、上市地（深交/北交/上交/境外）、最新进展，一两句话）；若无广东/广州 IPO 动态，则 guangdong_ipo 设为 null（不要编造）。
   - 算作"IPO 进展"的阶段（2026-08-31 补全，覆盖在审企业全生命周期）：**受理 / 问询** / 过会 / 提交注册 / 注册生效 / 辅导备案 / 招股 / 申购 / 上市敲钟
   - 特别注意：输入里的东财在审表条目常是"IPO已受理""IPO问询中"这类**早期在审状态**——同样算 IPO 进展，不要因为没到"过会/注册"就判为无动态返回 null。

要求：
- 只基于输入信息，不要编造
- 广州本地信息（南沙/广州企业/广州政策）优先于泛全国信息
- 语言精炼，站在分行行长视角，不写空话套话
- 措辞语气（2026-08-27 用户反馈：口播每条都说"建议分行"太死板）：凡涉及"建议分行开展动作"的表达，**措辞灵活、多样化**，避免每条都用"建议分行"开头：
  - 柔软建议式（不固定句式）：
    - 「建议分行…」（如"建议分行统一口径抢抓窗口"）
    - 「可考虑…」「值得关注…」「下一步观察…」
    - 「提示…」「可能影响…」「需注意…」
    - 直接陈述事实 + 隐含行动（"今日贴息提至 5000，财富部可考虑调整产品结构"）
  - **严禁**「分行应该/分行应/须尽快/需尽快/务必」等强硬祈使语气
  - 适用于 hero_line、spoken_* 口播稿、insights.action、risk.action
  - 目标：行长听口播时不会觉得"每条都是"建议分行""这种机械感
- spoken_* 口播稿均为纯文本：无 Markdown、无链接、无 emoji、无 # * | \` 等符号，可直接朗读；口播稿是"二次提炼的主播语态"，严禁把 hero_line/must_read/insights/risk 原文整段照读，要浓缩成口语（定调/必读/洞察/风险均为"事件+应对建议"式完整句，每条独立成句、句号收尾、换行分隔形成气口停顿；总口播约 700 字、时长约 2.5 分钟）
- 输出 STRICTLY 一个 JSON 对象（无 markdown 代码块）：
{"hero_line":"...","spoken_hero":"...","must_read":[{"title":"...","why":"...","url":"..."}],"spoken_must_read":"...","insights":[{"topic":"...","impact":"...","action":"...","tag":["..."],"sources":[{"title":"...","url":"..."}]}],"spoken_insights":"...","risk":{"topic":"...","evidence":"...","impact":"...","action":"...","source":"T1","sources":[{"title":"...","url":"..."}]} 或 null,"spoken_risk":"...","guangdong_ipo":{"spoken":"..."} 或 null}
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

/**
 * B7 边界互斥守卫（确定性，不依赖 LLM）：同一事件不得既进 must_read/insights 又进 risk。
 * 用标题 Dice 相似度（阈值）+ 含子串关系判定「同一事件」，命中则丢弃 risk（置 undefined），
 * 杜绝「同样一件事」在必读与风险两个板块重复呈现，违反「精确性>丰富性」。
 * 只删 risk：must_read（宏观）与 insights（落地动作）本就是两块、允许共存。
 */
export function dedupeExecutiveCrossSection(exec: ExecutiveSummary): ExecutiveSummary {
  if (!exec.risk) return exec;
  const norm = (s: string) =>
    s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  const sigs = new Set<string>();
  for (const m of exec.must_read) sigs.add(norm(m.title));
  for (const i of exec.insights) sigs.add(norm(i.topic));
  const rt = norm(exec.risk.topic);
  if (!rt) return exec;
  const CROSS_DICE = 0.5;
  for (const s of sigs) {
    if (!s) continue;
    if (titleSimilarityDice(rt, s) >= CROSS_DICE) return { ...exec, risk: undefined };
    if (rt.length >= 4 && s.length >= 4 && (rt.includes(s) || s.includes(rt)))
      return { ...exec, risk: undefined };
  }
  return exec;
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
    // B-1：关键词层 risk_tracker 已识别的风险候选，LLM 优先从这里选 1 条作为今日风险
    ...(input.riskCandidates && input.riskCandidates.length > 0
      ? { risk_candidates: input.riskCandidates }
      : {}),
  };
  const userPrompt = [
    RULES,
    // 内容记忆约束：近期播过什么、若必须再讲应换什么角度（去重机制的第一道闸）
    ...(input.memoryBrief ? [input.memoryBrief] : []),
    "",
    `当日信息（JSON）：`,
    JSON.stringify(payload),
    "",
    '请输出 {"hero_line":"...","spoken_hero":"...","must_read":[...],"spoken_must_read":"...","insights":[...],"spoken_insights":"...","guangdong_ipo":{...} 或 null}，hero_line 1 句、must_read 3-5 条、insights 3-5 条；spoken_* 与 guangdong_ipo.spoken 按要求字数返回纯口语文本。',
  ].join("\n");
  try {
    const { text } = await runLlm({ systemPrompt: SYSTEM_PROMPT, userPrompt, timeoutMs: 240_000 }, { stage: "executive" });
    // 2026-09-05 可观测性：exec 曾「成功但空壳」（must_read/insights 全空）且无任何日志。
    // 打原始响应长度+头部片段，区分「200 空响应」「残缺 JSON」「内容空壳」三类失败。
    console.log(`[exec-llm] 原始响应 ${text.length} 字符 | 头部: ${text.slice(0, 260).replace(/\s+/g, " ")}`);
    const cleaned = extractJson(text);
    let parsed: ExecutiveSummary;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // jsonrepair 仍失败会抛给外层 catch（统一打日志），不再静默 return null
      const jsonrepair = (await import("jsonrepair")).jsonrepair;
      parsed = JSON.parse(jsonrepair(cleaned));
      console.log(`[exec-llm] jsonrepair 修复后解析成功（cleaned ${cleaned.length} 字符）`);
    }
    if (!Array.isArray(parsed.must_read) || !Array.isArray(parsed.insights)) {
      console.warn(
        `[exec-llm] 结构校验失败: must_read=${Array.isArray(parsed.must_read)} insights=${Array.isArray(parsed.insights)} | parsed keys=${Object.keys(parsed as object).join(",")}`,
      );
      return null;
    }
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
    // M 层：风险解析（risk 可为 null；source 限定 T1/T1.5/T2；sources 同 insights 相似度回链）
    const rawRisk = parsed.risk;
    const risk: ExecRisk | undefined =
      rawRisk && typeof rawRisk === "object" && typeof rawRisk.topic === "string" && rawRisk.topic.trim()
        ? (() => {
            const r = rawRisk as unknown as Record<string, unknown>;
            const explicit = Array.isArray(r.sources) && (r.sources as unknown[]).length > 0
              ? (r.sources as Array<{ title?: string; url?: string }>)
                  .slice(0, 3)
                  .filter((s) => s && s.url)
                  .map((s) => ({ title: s.title || "", url: s.url as string }))
              : [];
            const sources = explicit.length > 0
              ? explicit
              : resolveInsightSources(
                  String(r.topic),
                  String(r.evidence ?? ""),
                  String(r.impact ?? ""),
                  [...input.finance, ...input.gz],
                );
            return {
              topic: String(r.topic),
              evidence: typeof r.evidence === "string" ? r.evidence : "",
              impact: typeof r.impact === "string" ? r.impact : "",
              action: typeof r.action === "string" ? r.action : "",
              ...(typeof r.url === "string" && r.url ? { url: r.url } : {}),
              ...(r.source === "T1" || r.source === "T1.5" || r.source === "T2" ? { source: r.source } : {}),
              ...(sources.length > 0 ? { sources } : {}),
            };
          })()
        : undefined;
    console.log(
      `[exec-llm] parsed 盘点: must_read=${parsed.must_read.length} insights=${parsed.insights.length} hero=${typeof parsed.hero_line === "string" && parsed.hero_line ? 1 : 0} spoken_hero=${typeof parsed.spoken_hero === "string" && parsed.spoken_hero.trim() ? 1 : 0} spoken_must=${typeof parsed.spoken_must_read === "string" && parsed.spoken_must_read.trim() ? 1 : 0} spoken_ins=${typeof parsed.spoken_insights === "string" && parsed.spoken_insights.trim() ? 1 : 0} risk=${parsed.risk && typeof parsed.risk === "object" && typeof (parsed.risk as { topic?: unknown }).topic === "string" ? 1 : 0} spoken_risk=${typeof parsed.spoken_risk === "string" && parsed.spoken_risk.trim() ? 1 : 0} gd_ipo=${parsed.guangdong_ipo && typeof parsed.guangdong_ipo === "object" ? 1 : 0}`,
    );
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
      risk,
      spoken_risk:
        typeof parsed.spoken_risk === "string" && parsed.spoken_risk.trim()
          ? parsed.spoken_risk.trim()
          : undefined,
      guangdong_ipo:
        parsed.guangdong_ipo && typeof parsed.guangdong_ipo === "object" && typeof parsed.guangdong_ipo.spoken === "string" && parsed.guangdong_ipo.spoken.trim()
          ? { spoken: parsed.guangdong_ipo.spoken.trim() }
          : null,
    };
  } catch (e) {
    // 2026-09-05：此前静默 return null，CI 无法区分失败原因。打日志后行为不变（仍返回 null）。
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[exec-llm] 生成失败（返回 null，将触发评分兜底）: ${msg.slice(0, 200)}`);
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
/**
 * 把一条分行相关性评分「翻译」成必读卡可展示的 why（客户中心视角）。
 * 导出供内容记忆层的兜底补位复用（lib/memory/exec-guard.ts），保持文案口径一致。
 */
export function synthMustReadWhy(rel: BranchRelevance): string {
  const lines = rel.businessLines.join("/");
  const head =
    rel.authority >= 0.95 ? "国家核心监管新政" : rel.authority >= 0.8 ? "监管/地方级信号" : "市场信号";
  const tail = rel.override ? "建议分行评估对客与产品影响" : `直击${lines}业务`;
  return `${head}（${lines}）：${tail}`.slice(0, 60);
}

/**
 * 评分层兜底生成器（SKIP_AI 无 store.json 时调用）。
 *
 * 关键价值：让「客户中心」在零 LLM 下也是结构化的——按分行相关性
 * 确定性选出 top 必读/商机/风险，报告永不空、且房贷40年这类硬规则条目
 * 必然置顶。与 LLM 路径产物同形（ExecutiveSummary），下游 mergeStoredExecutive 直接消费。
 */

/** 显著关键词（金融实体/数字/政策动作）——用于兜底去重「同事件不同措辞」的报道 */
const SALIENT_KW = [
  "房贷", "按揭", "住房", "期限", "40年", "30年", "信托", "罚", "处罚", "违规",
  "消费贷", "贴息", "LPR", "降息", "降准", "私行", "理财", "黄金", "外汇", "REITs",
  "IPO", "上市", "科创", "湾区", "广州", "广东",
];

/**
 * 零售核心条线（行长 5 分钟视角）：必读与商机都先按条线均衡各取 1 条。
 * 用户 2026-08-29 拍板：客群 / 财富 / 私行 / 信贷（含住房金融）应各有一条出现在
 * 必读和商机——除非该条线确实没有达标内容（有阈值把关，不硬凑）。
 */
const BALANCED_LINES = ["财富", "私行", "客群", "信贷"];

/**
 * 「均衡优先 + 按重要性补位」选取（2026-08-29 用户拍板）：
 *   轮次一：核心条线各取 1 条**已达标**（调用方按 tier 过滤过）的条目 → 保证条线均衡；
 *   轮次二：剩余名额按相关性分数（重要性）补齐 → 保证重要信号不被埋。
 * 另做「同事件去重」：共享 ≥2 个显著关键词的报道视为同一事件，只留最相关一条
 * （比字面 Dice 更能识别「同事件不同措辞」，如房贷40年的多个变体）。
 */
function balancedPick(
  ranked: Array<{ article: ScorableArticle; relevance: BranchRelevance }>,
  limit: number,
): Array<{ article: ScorableArticle; relevance: BranchRelevance }> {
  // 同事件去重
  const seenSigs: string[][] = [];
  const kept: Array<{ article: ScorableArticle; relevance: BranchRelevance }> = [];
  for (const r of ranked) {
    const sig = SALIENT_KW.filter((k) => r.article.title.includes(k));
    if (seenSigs.some((s) => s.filter((k) => sig.includes(k)).length >= 2)) continue;
    seenSigs.push(sig);
    kept.push(r);
  }
  const picked: Array<{ article: ScorableArticle; relevance: BranchRelevance }> = [];
  // 轮次一：核心条线各取 1 条。该条线有 must_read 档就用它，没有才退到 insight 档
  // （保证「有达标内容就先给一条」，不会因某条线整体分数偏低而轮空）。
  for (const line of BALANCED_LINES) {
    if (picked.length >= limit) break;
    const cand =
      kept.find(
        (r) =>
          !picked.includes(r) &&
          r.relevance.tier === "must_read" &&
          r.relevance.businessLines.includes(line),
      ) ??
      kept.find(
        (r) =>
          !picked.includes(r) &&
          r.relevance.tier === "insight" &&
          r.relevance.businessLines.includes(line),
      );
    if (cand) picked.push(cand);
  }
  // 轮次二：先补齐「尚未覆盖」的核心条线（避免被单一高分条线挤掉），
  // 再按分数（重要性）补满剩余名额——must_read 档优先，再 insight 档。
  const covered = new Set(picked.flatMap((r) => r.relevance.businessLines));
  const rest = kept.filter((r) => !picked.includes(r));
  for (const line of BALANCED_LINES) {
    if (picked.length >= limit) break;
    if (covered.has(line)) continue;
    const cand =
      rest.find(
        (r) =>
          !picked.includes(r) &&
          r.relevance.tier === "must_read" &&
          r.relevance.businessLines.includes(line),
      ) ??
      rest.find((r) => !picked.includes(r) && r.relevance.businessLines.includes(line));
    if (cand) picked.push(cand);
  }
  const restMust = rest.filter(
    (r) => !picked.includes(r) && r.relevance.tier === "must_read",
  );
  const restOther = rest.filter(
    (r) => !picked.includes(r) && r.relevance.tier !== "must_read",
  );
  for (const r of [...restMust, ...restOther]) {
    if (picked.length >= limit) break;
    picked.push(r);
  }
  return picked;
}

export function buildExecutiveFromScores(
  articles: Array<{
    title?: string;
    category?: string;
    subcategory?: string;
    source?: string;
    sourceId?: string;
    summary?: string;
    url?: string;
    locale?: string;
  }>,
  _date: string,
): ExecutiveSummary {
  const pool: ScorableArticle[] = (articles ?? [])
    .filter((a) => a && a.title)
    .map((a) => ({
      title: a.title!,
      category: a.category,
      subcategory: a.subcategory,
      sourceId: a.sourceId ?? a.source,
      summary: a.summary,
      url: a.url,
      locale: a.locale,
    }));
  const ranked = rankByRelevance(pool);
  // 必读：从 must_read / insight 档里选（阈值把关：drop/context 档不进必读）。
  // 均衡优先：核心条线各取 1 条，再按重要性补齐（2026-08-29 用户拍板）。
  const mr = balancedPick(
    ranked.filter(
      (r) =>
        (r.relevance.tier === "must_read" || r.relevance.tier === "insight") &&
        // 外埠区域性银行只作参考 → 不占必读名额（2026-08-29 用户：无本地借鉴意义）
        !r.relevance.foreignRegional,
    ),
    5,
  );
  const must_read = mr.map((r) => ({
    title: r.article.title,
    why: synthMustReadWhy(r.relevance),
    ...(r.article.url ? { url: r.article.url } : {}),
  }));
  // 风险先定位：原则 3 要求风险与商机严格错开，同一事件不重复出现在两个板块。
  const rk = ranked.find((r) => r.relevance.vertical === "risk");
  // 商机：同样均衡优先；与必读、风险都错开（原则 3）。
  const mrSet = new Set(mr);
  const ins = balancedPick(
    ranked.filter(
      (r) =>
        !mrSet.has(r) &&
        r !== rk &&
        (r.relevance.tier === "insight" || r.relevance.tier === "must_read"),
    ),
    5,
  );
  const insights = ins.map((r) => ({
    topic: r.article.title.slice(0, 15),
    impact: `对广州分行${r.relevance.businessLines.join("/")}业务有潜在影响`,
    action: `建议分行关注${r.relevance.businessLines[0] ?? "相关"}动向并评估动作`,
  }));
  const risk = rk
    ? {
        topic: rk.article.title.slice(0, 15),
        evidence: rk.article.title,
        impact: "对分行相关条线需关注合规与风险敞口",
        action: "建议对应条线评估并制定应对",
        ...(rk.article.url ? { url: rk.article.url } : {}),
      }
    : undefined;
  const top = ranked[0];
  const hero_line = top ? `今日分行焦点：${top.article.title.slice(0, 26)}` : "";
  return {
    hero_line,
    must_read,
    insights,
    ...(risk ? { risk } : {}),
  };
}

/**
 * 评分护栏（AI 模式 LLM 生成后调用）。
 *
 * 作用：
 *  1) 按分行相关性对必读重排序——客户中心条目（房贷40年型）必然上浮；
 *  2) 强制把「硬规则」命中的池内文章顶入必读（若 LLM 漏选，杜绝被埋）。
 * 不改动 insights/risk/hero_line（那些是 LLM 的语义富化，护栏只管「排序与兜底置顶」）。
 */
export function applyRelevanceGuardrail(
  exec: ExecutiveSummary,
  articlePool: Array<{
    title?: string;
    category?: string;
    subcategory?: string;
    source?: string;
    sourceId?: string;
    summary?: string;
    url?: string;
    locale?: string;
  }>,
): ExecutiveSummary {
  if (!exec || !Array.isArray(exec.must_read)) return exec;
  const pool: ScorableArticle[] = (articlePool ?? [])
    .filter((a) => a && a.title)
    .map((a) => ({
      title: a.title!,
      category: a.category,
      subcategory: a.subcategory,
      sourceId: a.sourceId ?? a.source,
      summary: a.summary,
      url: a.url,
      locale: a.locale,
    }));

  // 1) 为每条必读打分（基于标题+why，无需 LLM 标签）
  const scored = exec.must_read.map((m) => ({
    m,
    rel: scoreBranchRelevance({ title: m.title, summary: m.why, url: m.url }),
  }));

  // 2) 强制把「硬规则」命中的池内文章顶入必读（若 LLM 漏选）
  const covered = new Set<string>();
  for (const s of scored) covered.add(s.m.url ?? s.m.title);
  const forced: Array<{ title: string; why: string; url?: string }> = [];
  for (const a of pool) {
    if (forced.length + scored.length >= 5) break;
    const rel = scoreBranchRelevance(a);
    if (
      rel.tier === "must_read" &&
      rel.override &&
      a.url &&
      !covered.has(a.url) &&
      !covered.has(a.title)
    ) {
      forced.push({ title: a.title, why: synthMustReadWhy(rel), url: a.url });
      covered.add(a.url);
      covered.add(a.title);
    }
  }

  // 3) 合并去重 + 按分行相关性降序重排
  const merged = [...forced, ...scored.map((s) => s.m)];
  const seen = new Set<string>();
  const dedup = merged.filter((m) => {
    const k = m.url ?? m.title;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const scoreOf = (m: { title: string; why?: string; url?: string }) =>
    scoreBranchRelevance({ title: m.title, summary: m.why, url: m.url }).score;
  dedup.sort((a, b) => scoreOf(b) - scoreOf(a));

  return { ...exec, must_read: dedup.slice(0, 5) };
}

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
