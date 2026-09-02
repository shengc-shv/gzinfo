/**
 * 内容记忆守卫：把「事件记忆」落到四大板块的产出上。
 *
 * 定位：LLM 之后、写盘之前的**确定性闸门**。
 *  - LLM 生成前：由 buildMemoryBrief + formatMemoryBrief 注入提示（避开重复、给出建议角度）；
 *  - LLM 生成后：本模块逐条判定，过滤/降级重播项，板块不足时分三级兜底补齐。
 *
 * 关键设计：
 *  1. 判定顺序 = hero → must_read → insights → risk（板块优先级）。
 *     边判边写记忆（rememberBroadcast），因此**同一板块内同事件只留第一条**
 *     ——LLM 常把同一事件拆成两条必读，靠这个天然收敛。
 *  2. 同日跨板块不互斥：定调一句话 + 必读展开是合理呈现，只要求基本增量。
 *  3. 兜底三级（永不产出空板块，守住「定调/必读永不空」红线）：
 *     L1 释放被过滤项（progress > refresh > cooldown > duplicate，同级按增量降序）
 *     L2 从两天池补位「记忆库中不存在」的高分条目
 *     L3 仍不足 → 保留 LLM 原产出（宁可重复，不留空）
 */

import type { ExecutiveSummary, ExecInsight, ExecRisk } from "../ai/executive-summary";
import { synthMustReadWhy } from "../ai/executive-summary";
import { scoreBranchRelevance, type BranchRelevance } from "../ai/relevance-score";
import {
  beginDay,
  evaluateCandidate,
  rememberBroadcast,
  nextAngle,
  SECTION_POLICY,
  type EventMemoryStore,
  type EventRecord,
  type MemoryCandidate,
  type MemoryDecision,
  type MemorySection,
  type MemoryVerdict,
} from "./event-memory";

/** 补位池条目（= 两天可评分池 ScorablePoolEntry 的超集）。 */
export interface GuardPoolItem {
  title: string;
  summary?: string;
  subcategory?: string;
  source?: string;
  sourceId?: string;
  url?: string;
  locale?: string;
  category?: string;
}

export interface GuardInput {
  exec: ExecutiveSummary;
  store: EventMemoryStore;
  /** 今天 YYYY-MM-DD。 */
  today: string;
  /** 兜底补位池（两天可评分池）。为空则跳过 L2 补位。 */
  pool?: GuardPoolItem[];
}

export interface GuardOutput {
  exec: ExecutiveSummary;
  /** 已记录本次播报的记忆库（供调用方落盘）。 */
  store: EventMemoryStore;
  /** 逐条判定明细（日志/测试用）。 */
  decisions: MemoryDecision[];
  /** 人类可读日志行。 */
  log: string[];
}

/** 释放优先级（L1 兜底时按此顺序放行被过滤项）。 */
const RELEASE_PRIO: Record<MemoryVerdict, number> = {
  new: 0,
  progress: 1,
  refresh: 2,
  cooldown: 3,
  duplicate: 4,
  exhausted: 5,
};

interface Paired<T> {
  item: T;
  decision: MemoryDecision;
}

/**
 * L1 兜底：被过滤项按「结论优先级 → 信息增量降序」释放，直到达到 minKeep。
 * exhausted（板块内次数达上限）最后才考虑 —— 实在凑不齐时才放行。
 */
function releaseToMin<T>(paired: Paired<T>[], minKeep: number): Paired<T>[] {
  const kept = paired.filter((p) => p.decision.allow);
  if (kept.length >= minKeep) return kept;
  const dropped = paired.filter((p) => !p.decision.allow);
  dropped.sort(
    (a, b) =>
      RELEASE_PRIO[a.decision.verdict] - RELEASE_PRIO[b.decision.verdict] ||
      b.decision.novelty - a.decision.novelty,
  );
  const out = [...kept];
  // 第一轮：不动 exhausted
  for (const d of dropped) {
    if (out.length >= minKeep) break;
    if (d.decision.verdict === "exhausted") continue;
    out.push(d);
  }
  // 第二轮：仍不足才动 exhausted（宁可重复，不留空）
  if (out.length < minKeep) {
    for (const d of dropped) {
      if (out.length >= minKeep) break;
      if (out.includes(d)) continue;
      out.push(d);
    }
  }
  return out;
}

/**
 * 板块拥挤时降级：若去掉 refresh（换角度重播）后仍满足 minKeep，
 * 就优先展示真正的新内容，把「重播项」让位。
 */
function demoteRefresh<T>(kept: Paired<T>[], minKeep: number): Paired<T>[] {
  if (kept.length <= minKeep) return kept;
  const without = kept.filter((k) => k.decision.verdict !== "refresh");
  return without.length >= minKeep ? without : kept;
}

/** 从补位池里挑出「记忆库中不存在」的条目（L2）。 */
function pickFreshFromPool(
  pool: GuardPoolItem[],
  store: EventMemoryStore,
  section: MemorySection,
  today: string,
  excludeUrls: Set<string>,
  limit: number,
  out: { picked: MemoryCandidate[]; store: EventMemoryStore },
): number {
  if (limit <= 0) return 0;
  const scored = pool
    .filter((p) => p.title && (!p.url || !excludeUrls.has(p.url)))
    .map((p) => {
      const rel = scoreBranchRelevance({
        title: p.title,
        ...(p.summary ? { summary: p.summary } : {}),
        ...(p.category ? { category: p.category } : {}),
        ...(p.subcategory ? { subcategory: p.subcategory } : {}),
      });
      return { p, rel };
    })
    .filter((x) => x.rel.tier !== "drop")
    .sort((a, b) => b.rel.score - a.rel.score);

  let n = 0;
  for (const { p, rel } of scored) {
    if (n >= limit) break;
    const cand: MemoryCandidate = {
      title: p.title,
      text: p.summary ?? "",
      ...(p.url ? { url: p.url } : {}),
      score: rel.score,
      tier: rel.tier,
      ...(rel.override ? { override: true } : {}),
    };
    const d = evaluateCandidate({ cand, section, today, store: out.store });
    if (d.verdict !== "new" && d.verdict !== "progress") continue;
    out.picked.push(cand);
    out.store = rememberBroadcast(out.store, {
      cand,
      section,
      date: today,
      novelty: d.novelty,
    });
    if (p.url) excludeUrls.add(p.url);
    n++;
  }
  return n;
}

/** 用补位条目拼一条 must_read（文案口径与评分兜底一致）。 */
function toMustRead(cand: MemoryCandidate): { title: string; why: string; url?: string } {
  const rel: BranchRelevance = scoreBranchRelevance({
    title: cand.title,
    ...(cand.text ? { summary: cand.text } : {}),
  });
  return {
    title: cand.title.slice(0, 15),
    why: synthMustReadWhy(rel),
    ...(cand.url ? { url: cand.url } : {}),
  };
}

/** 用补位条目拼一条 insight。 */
function toInsight(cand: MemoryCandidate): ExecInsight {
  const rel: BranchRelevance = scoreBranchRelevance({
    title: cand.title,
    ...(cand.text ? { summary: cand.text } : {}),
  });
  const lines = rel.businessLines.length ? rel.businessLines.join("/") : "相关";
  return {
    topic: cand.title.slice(0, 15),
    impact: `对广州分行${lines}业务有潜在影响`,
    action: `建议分行关注${rel.businessLines[0] ?? "相关"}动向并评估动作`,
    ...(rel.businessLines.length ? { tag: rel.businessLines.slice(0, 2) } : {}),
    ...(cand.url ? { sources: [{ title: cand.title, url: cand.url }] } : {}),
  };
}

/**
 * 主入口：对四大板块执行记忆去重 + 兜底补齐。
 * 纯函数（不改入参），返回新 exec 与更新后的记忆库。
 */
export function applyMemoryGuard(input: GuardInput): GuardOutput {
  const { exec, today, pool = [] } = input;
  // 开启新的一天：结算昨天的播报进长期记忆 + 清空当天暂存区（保证同日重跑幂等）
  let store: EventMemoryStore = beginDay(input.store, today);
  const decisions: MemoryDecision[] = [];
  const log: string[] = [];
  const next: ExecutiveSummary = { ...exec };

  // ---- 1) hero（今日定调）----
  if (exec.hero_line && exec.hero_line.trim()) {
    // 透传分行相关性分，使「定调」这类重大事件能在跨天结算时拿到真实 peakScore
    // （否则 peakScore 恒为 0，无法享受「重大事件 ≥60 双倍保留」）。
    const heroRel = scoreBranchRelevance({ title: exec.hero_line });
    const cand: MemoryCandidate = {
      title: exec.hero_line,
      score: heroRel.score,
      ...(heroRel.override ? { override: true } : {}),
    };
    const d = evaluateCandidate({ cand, section: "hero", today, store });
    decisions.push(d);
    if (d.allow) {
      store = rememberBroadcast(store, {
        cand,
        section: "hero",
        date: today,
        novelty: d.novelty,
        ...(d.requiredAngle ? { angle: d.requiredAngle } : {}),
      });
      log.push(`🧠 定调：${d.verdict}（增量 ${d.novelty.toFixed(2)}）— ${d.reason}`);
    } else {
      // 定调被去重 → 必须补一条新的（红线：定调永不空）
      const box = { picked: [] as MemoryCandidate[], store };
      const n = pickFreshFromPool(pool, store, "hero", today, new Set(), 1, box);
      store = box.store;
      if (n > 0) {
        next.hero_line = `今日分行焦点：${box.picked[0].title.slice(0, 26)}`;
        // 口播稿沿用会与旧稿雷同 → 清空，由 audio.ts 按 hero_line 重新确定性生成
        next.spoken_hero = undefined;
        log.push(`🧠 定调命中去重（${d.verdict}），改用池内新事件补位：${next.hero_line}`);
      } else {
        log.push(
          `🧠 定调命中去重（${d.verdict}），但池内无新事件可补 → 保留原定调（宁可重复，不留空）`,
        );
      }
    }
  }

  // ---- 2) must_read（今日必读）----
  {
    const paired: Paired<{ title: string; why: string; url?: string }>[] = [];
    for (const m of exec.must_read ?? []) {
      const cand: MemoryCandidate = {
        title: m.title,
        text: m.why,
        ...(m.url ? { url: m.url } : {}),
      };
      // 补 meta：从补位池按 url 取分行相关性分（用于「重大事件打破冷却」）
      const meta = m.url ? pool.find((p) => p.url === m.url) : undefined;
      if (meta) {
        const rel = scoreBranchRelevance({
          title: meta.title,
          ...(meta.summary ? { summary: meta.summary } : {}),
        });
        cand.score = rel.score;
        cand.tier = rel.tier;
        if (rel.override) cand.override = true;
      }
      const d = evaluateCandidate({ cand, section: "must_read", today, store });
      paired.push({ item: m, decision: d });
      // 通过才写记忆：保证同一板块内同事件只留第一条
      if (d.allow) {
        store = rememberBroadcast(store, {
          cand,
          section: "must_read",
          date: today,
          novelty: d.novelty,
          ...(d.requiredAngle ? { angle: d.requiredAngle } : {}),
        });
      }
    }
    decisions.push(...paired.map((p) => p.decision));
    let kept = releaseToMin(paired, SECTION_POLICY.must_read.minKeep);
    kept = demoteRefresh(kept, SECTION_POLICY.must_read.minKeep);

    // L2 补位：必读仍不足 → 从两天池挑「记忆库没有」的高分条目
    if (kept.length < SECTION_POLICY.must_read.minKeep && pool.length > 0) {
      const exclude = new Set<string>();
      for (const k of kept) if (k.item.url) exclude.add(k.item.url);
      const box = { picked: [] as MemoryCandidate[], store };
      const n = pickFreshFromPool(
        pool,
        store,
        "must_read",
        today,
        exclude,
        SECTION_POLICY.must_read.minKeep - kept.length,
        box,
      );
      store = box.store;
      for (const c of box.picked) kept.push({ item: toMustRead(c), decision: {
        section: "must_read",
        title: c.title,
        verdict: "new",
        allow: true,
        novelty: 1,
        reason: "L2 兜底补位（池内新事件）",
      } });
      if (n > 0) log.push(`🧠 必读去重后不足 ${SECTION_POLICY.must_read.minKeep} 条 → 池内补位 ${n} 条`);
    }

    const filtered = (exec.must_read ?? []).length - kept.length;
    if (filtered > 0) {
      log.push(
        `🧠 必读：${(exec.must_read ?? []).length} → ${kept.length} 条（去重 ${filtered} 条：${paired
          .filter((p) => !kept.includes(p))
          .map((p) => p.decision.verdict)
          .join(",")}）`,
      );
    }
    if (kept.length > 0) next.must_read = kept.map((k) => k.item);
  }

  // ---- 3) insights（商机洞察）----
  {
    const paired: Paired<ExecInsight>[] = [];
    for (const it of exec.insights ?? []) {
      const cand: MemoryCandidate = {
        title: it.topic,
        text: `${it.impact ?? ""} ${it.action ?? ""}`.trim(),
        ...(it.sources?.[0]?.url ? { url: it.sources[0].url } : {}),
      };
      const d = evaluateCandidate({ cand, section: "insights", today, store });
      paired.push({ item: it, decision: d });
      if (d.allow) {
        store = rememberBroadcast(store, {
          cand,
          section: "insights",
          date: today,
          novelty: d.novelty,
          ...(d.requiredAngle ? { angle: d.requiredAngle } : {}),
        });
      }
    }
    decisions.push(...paired.map((p) => p.decision));
    let kept = releaseToMin(paired, SECTION_POLICY.insights.minKeep);
    kept = demoteRefresh(kept, SECTION_POLICY.insights.minKeep);

    if (kept.length < SECTION_POLICY.insights.minKeep && pool.length > 0) {
      const exclude = new Set<string>();
      for (const k of kept) {
        const u = k.item.sources?.[0]?.url;
        if (u) exclude.add(u);
      }
      const box = { picked: [] as MemoryCandidate[], store };
      const n = pickFreshFromPool(
        pool,
        store,
        "insights",
        today,
        exclude,
        SECTION_POLICY.insights.minKeep - kept.length,
        box,
      );
      store = box.store;
      for (const c of box.picked) kept.push({ item: toInsight(c), decision: {
        section: "insights",
        title: c.title,
        verdict: "new",
        allow: true,
        novelty: 1,
        reason: "L2 兜底补位（池内新事件）",
      } });
      if (n > 0) log.push(`🧠 商机去重后不足 ${SECTION_POLICY.insights.minKeep} 条 → 池内补位 ${n} 条`);
    }

    const filtered = (exec.insights ?? []).length - kept.length;
    if (filtered > 0) {
      log.push(
        `🧠 商机：${(exec.insights ?? []).length} → ${kept.length} 条（去重 ${filtered} 条：${paired
          .filter((p) => !kept.includes(p))
          .map((p) => p.decision.verdict)
          .join(",")}）`,
      );
    }
    next.insights = kept.map((k) => k.item);
  }

  // ---- 4) risk（风险提示）----
  // 风险可以为 null：去重命中即不预警（当日没有新风险是正常状态），
  // 不做 L2 补位——编造风险比没有风险更糟。
  if (exec.risk) {
    const r: ExecRisk = exec.risk;
    // 透传分行相关性分，使 risk 板块事件跨天结算时也能拿到真实 peakScore。
    const riskSummary = `${r.evidence ?? ""} ${r.impact ?? ""}`.trim();
    const riskRel = scoreBranchRelevance({
      title: r.topic,
      ...(riskSummary ? { summary: riskSummary } : {}),
    });
    const cand: MemoryCandidate = {
      title: r.topic,
      text: `${riskSummary} ${r.action ?? ""}`.trim(),
      ...(r.url ? { url: r.url } : {}),
      score: riskRel.score,
      ...(riskRel.override ? { override: true } : {}),
    };
    const d = evaluateCandidate({ cand, section: "risk", today, store });
    decisions.push(d);
    if (d.allow) {
      store = rememberBroadcast(store, {
        cand,
        section: "risk",
        date: today,
        novelty: d.novelty,
        ...(d.requiredAngle ? { angle: d.requiredAngle } : {}),
      });
      log.push(`🧠 风险：${d.verdict}（增量 ${d.novelty.toFixed(2)}）— ${d.reason}`);
    } else {
      next.risk = undefined;
      next.spoken_risk = undefined;
      log.push(`🧠 风险命中去重（${d.verdict}，增量 ${d.novelty.toFixed(2)}）→ 今日不重复预警`);
    }
  }

  return { exec: next, store, decisions, log };
}

/**
 * 生成前调用：给出「本次应避开 / 应换角度」的事件清单，
 * 供调用方注入 LLM 提示词（见 formatMemoryBrief）。
 */
export function suggestAngles(
  store: EventMemoryStore,
  today: string,
): Array<{ id: string; title: string; angle: string; guide: string }> {
  const out: Array<{ id: string; title: string; angle: string; guide: string }> = [];
  for (const rec of Object.values(store.events ?? {})) {
    if (rec.lastBroadcastAt !== today) continue;
    const last = (rec.samples ?? []).filter((s) => s.date === today).slice(-1)[0];
    if (!last) continue;
    const a = nextAngle(rec as EventRecord);
    out.push({ id: rec.id, title: last.title, angle: a, guide: ANGLE_GUIDE_TEXT[a] });
  }
  return out;
}

const ANGLE_GUIDE_TEXT: Record<string, string> = {
  政策变化: "只讲政策/规则本身变了什么、何时生效、适用范围",
  市场反应: "讲市场与机构的第一反应，少复述政策条文",
  受影响人群: "讲哪一类客户被直接影响，需求发生了什么变化",
  数据验证: "用最新数据验证进展（规模/增速/占比），用数字说话",
  同业动作: "讲同业已经怎么做了（产品/定价/流程），突出竞争位次",
  客户行动: "讲分行与该客群当下可执行的动作",
};
