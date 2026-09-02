/**
 * 必读 / 商机 / hero_line 执行摘要（PR4 引入，PR6 SKIP_AI 模式统一收口）。
 *
 * 模式自适应：
 * - AI 模式：先读 store.json（若已有 → 复用，零 LLM）；否则用 buildTwoDayExecPool +
 *   generateExecutiveSummary 拼 2 天窗口 → 覆盖 PASS2 产出 → writeStore 持久化
 * - SKIP_AI 模式：仅从 store.json 复用（无 LLM 路径）
 *
 * 行为完全对齐原 daily.ts main 200-220 行的双分支。
 */

import type { ArticleInput, DailyReport } from "../../types";
import {
  loadStore,
  generateExecutiveSummary,
  writeStore,
  buildExecutiveFromScores,
  applyRelevanceGuardrail,
  dedupeExecutiveCrossSection,
  type ExecutiveSummary,
} from "../../ai/executive-summary";
import { mergeStoredExecutive } from "../../output/render";
import { dedupeExecAgainstSections } from "../../output/dedupe-sections";
import { buildTwoDayExecPool, collectTwoDayArticles } from "../../ai/exec-pool";
import type { HistoryStore } from "../../output/history";
import type { FilterResult } from "../../filters/types";
import type { DailyContext } from "../context";
// 内容记忆与去重（2026-09-02）：生成前注入提示、生成后确定性过滤
import { buildMemoryBrief, formatMemoryBrief } from "../../memory/event-memory";
import { applyMemoryGuard } from "../../memory/exec-guard";
import { loadEventMemory, saveEventMemory, isEventMemoryEnabled } from "../../memory/store";

/**
 * B-1：从 keyword-funnel 的 filterResults 提取 risk_tracker 命中的条目，
 * 作为 LLM risk 段的"已识别候选"输入。
 * 取最高 priority（风险 S > A > B）作为条目的 priority 字段。
 */
function extractRiskCandidates(
  filterResults: Map<string, FilterResult>,
  _articles: ArticleInput[],
  _report: DailyReport,
): Array<{ title: string; url?: string; trackers: string[]; priority: string }> {
  const out: Array<{ title: string; url?: string; trackers: string[]; priority: string }> = [];
  const PRIO: Record<string, number> = { S: 0, A: 1, B: 2 };
  for (const [url, r] of filterResults) {
    if (!r.risks || r.risks.length === 0) continue;
    const trackers = r.risks.map((x) => x.tracker);
    const priority = r.risks.reduce(
      (best, x) => (PRIO[x.priority] < PRIO[best] ? x.priority : best),
      "B",
    );
    // 用 url 作 title 兜底（exec summary LLM 看到 url 也能去 search）
    out.push({ title: r.matched.join(" / ") || url, url, trackers, priority });
  }
  // 按 priority S > A > B 排序，最多取 5 条
  out.sort((a, b) => PRIO[a.priority] - PRIO[b.priority]);
  return out.slice(0, 5);
}

/**
 * 应用执行摘要到 report。
 * 返回新 report（不 mutate 入参）。
 * 失败不抛错（与原 main 一致：生成失败时沿用 PASS2 产出）。
 */
export async function buildExecutiveSummary(
  report: DailyReport,
  history: HistoryStore,
  articles: ArticleInput[],
  ctx: DailyContext,
  filterResults?: Map<string, FilterResult>,
): Promise<DailyReport> {
  const date = ctx.date;
  // 跨层级去重：必读头条已涵盖的事件，资讯板块不再重复展开（2026-08-30 用户）。
  // 包住所有 return，确保各分支（SKIP_AI 复用/兜底、REGEN=0、AI 生成）统一生效。
  const finalize = (r: DailyReport): DailyReport => dedupeExecAgainstSections(r);
  const stored = loadStore(date);
  // 两天（今天 + 昨天）可评分池：兜底与护栏都基于它。
  // 必要性：用户 6-8 点跑，跨天判重后「今天」常只剩十余条低信号新条目，
  // 只看今天会让兜底产出空必读；昨日白天的重要条目须从历史库捞回（2026-08-29）。
  const twoDayPool = collectTwoDayArticles({ history, articles, today: date });

  // —— 内容记忆与去重（2026-09-02）——
  // 解决「同一事件连续多天重复口播」：生成前把近期已播报事件告诉 LLM（含建议
  // 切入角度），生成后再用确定性闸门过滤掉无增量的重复表述。
  // 总开关 EVENT_MEMORY=0 可整体关闭（回滚用）。
  const memoryOn = isEventMemoryEnabled();
  let memStore = memoryOn ? loadEventMemory() : null;
  /** 把本次播报写回记忆库（幂等：同一天重跑结果一致，见 beginDay）。 */
  const persistMemory = (): void => {
    if (memoryOn && memStore) saveEventMemory(memStore, { today: date });
  };
  /** 对一份 ExecutiveSummary 跑记忆去重 + 兜底；失败一律放行原产出。 */
  const guard = (ex: ExecutiveSummary): ExecutiveSummary => {
    if (!memoryOn || !memStore) return ex;
    try {
      const g = applyMemoryGuard({
        exec: ex,
        store: memStore,
        today: date,
        pool: twoDayPool,
      });
      memStore = g.store;
      for (const line of g.log) ctx.log.info("exec", line);
      return g.exec;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log.warn("exec", `⚠️ 内容记忆去重异常（放行原产出）: ${msg}`);
      return ex;
    }
  };

  // SKIP_AI 分支：仅复用 store，不调 LLM
  if (ctx.mode.kind === "skip-ai") {
    if (stored && (stored.must_read?.length || stored.insights?.length)) {
      const before = { must: report.must_read.length, ins: report.insights.length };
      const next = mergeStoredExecutive(report, guard(stored));
      ctx.log.info(
        "exec",
        `🧠 SKIP_AI 复用 store.json 执行摘要：必读 ${before.must}→${next.must_read.length} / 商机 ${before.ins}→${next.insights.length}`,
      );
      persistMemory();
      return finalize(next);
    }
    ctx.log.info(
      "exec",
      `ℹ️ SKIP_AI 无 store.json 执行摘要可复用（history/${date}/store.json 缺失或为空）`,
    );
    // 评分层兜底：无 store 时用分行相关性评分器确定性生成必读/商机，
    // 保证 SKIP_AI 下报告也以客户为中心（不空、不靠运气、房贷40年型必然置顶）。
    // 输入用「今天+昨天」两天池（twoDayPool），覆盖凌晨突发与昨日白天重要条目。
    const fallback = buildExecutiveFromScores(twoDayPool, date);
    if (fallback.must_read.length || fallback.insights.length) {
      const next = mergeStoredExecutive(report, guard(fallback));
      ctx.log.info(
        "exec",
        `🧠 SKIP_AI 评分层兜底生成：必读 ${next.must_read.length} / 商机 ${next.insights.length}`,
      );
      persistMemory();
      return finalize(next);
    }
    persistMemory();
    return finalize(report);
  }

  // AI 模式：默认重新生成 LLM（更符合"AI 开 = AI 跑"的用户预期）
  // 仅当 REGEN_EXEC=0 时才复用 store.json（CI 去重 / 失败恢复等显式场景）
  // REGEN_EXEC=1 显式声明"重生成"，与默认行为等价（用于脚本可读性）
  const regenMode = process.env.REGEN_EXEC ?? "1";  // 默认 "1"（重新生成）
  if (regenMode === "0" && stored && (stored.hero_line || stored.must_read?.length || stored.insights?.length)) {
    const next = mergeStoredExecutive(report, guard(stored));
    if (stored.hero_line) next.hero_line = stored.hero_line;
    ctx.log.info(
      "exec",
      `🧠 AI 模式 + REGEN_EXEC=0 复用 store.json 执行摘要：${stored.must_read?.length ?? 0} 必读 / ${stored.insights?.length ?? 0} 商机`,
    );
    persistMemory();
    return finalize(next);
  }

  // 生成新执行摘要
  try {
    const pool = buildTwoDayExecPool({ history, articles, report, today: date });
    // B-1：从 filterResults 提取 risk_tracker 候选，喂给 LLM 作为 risk 段输入
    const riskCandidates = filterResults
      ? extractRiskCandidates(filterResults, articles, report)
      : [];
    if (riskCandidates.length > 0) {
      ctx.log.info("exec", `🎯 关键词层风险候选 ${riskCandidates.length} 条（喂给 LLM）`);
    }
    // 2026-08-31：此前漏传 ipo，exec 提示词里的 guangdong_ipo 槽位从未拿到输入 →
    // LLM 按「无则 null、不要编造」的指令恒回 null，口播只能靠 audio.ts 确定性兜底。
    if (pool.ipo.length > 0) {
      ctx.log.info("exec", `🏦 广东IPO 候选 ${pool.ipo.length} 条（喂给 LLM 的 guangdong_ipo 槽位）`);
    }
    // 内容记忆提示（去重第一道闸）：把近期已播报事件 + 建议切入角度写给 LLM，
    // 让它在生成阶段就避开重复表述；生成后还有一道确定性闸门（guard）。
    let memoryBrief: string | undefined;
    if (memoryOn && memStore) {
      try {
        const brief = buildMemoryBrief(memStore, date, { lookbackDays: 10, limit: 8 });
        memoryBrief = formatMemoryBrief(brief);
        if (brief.length > 0) {
          ctx.log.info("exec", `🧠 记忆提示：${brief.length} 个近期已播报事件已告知 LLM`);
        }
      } catch {
        memoryBrief = undefined;
      }
    }
    let exec = await generateExecutiveSummary({
      date,
      finance: pool.finance,
      gz: pool.gz,
      ...(pool.ipo.length > 0 ? { ipo: pool.ipo } : {}),
      ...(riskCandidates.length > 0 ? { riskCandidates } : {}),
      ...(memoryBrief ? { memoryBrief } : {}),
    });

    // 兜底（2026-08-31 修复）：LLM 静默返回空（空池 / 网络异常被吞 / 只回 1 条 IPO 类弱信号）
    // → 用「今天 + 昨天」2 天评分池确定性生成必读/商机/定调，保证「今日分析/定调」永不空、
    // 且与下方展示条目一致。与 SKIP_AI 分支共用同一 scorer，两条路径口径统一。
    const llHasContent = !!exec && ((exec.must_read?.length ?? 0) > 0 || (exec.insights?.length ?? 0) > 0);
    if (!llHasContent) {
      const fb = buildExecutiveFromScores(twoDayPool, date);
      ctx.log.info(
        "exec",
        `🔁 LLM 执行摘要为空/过薄，回退 2 天评分兜底（finance ${pool.finance.length}+gz ${pool.gz.length} → 必读 ${fb.must_read.length}/商机 ${fb.insights.length}）`,
      );
      if (!exec) {
        exec = fb;
      } else {
        // LLM 只回了弱信号（如仅 1 条 IPO 类定调、必读/商机空）→ 必读/商机/定调
        // 全用 2 天评分兜底（保证非空 + 与下方展示一致），仅保留 LLM 可能有效的
        // 风险 / IPO 口播段
        exec = {
          ...fb,
          ...(exec.risk ? { risk: exec.risk } : {}),
          ...(exec.guangdong_ipo ? { guangdong_ipo: exec.guangdong_ipo } : {}),
        };
      }
    }

    if (exec) {
      // 评分护栏：LLM 生成后按分行相关性重排必读 + 强制顶入硬规则条目，
      // 让「客户中心」不依赖 LLM 临场发挥（房贷40年型不可能被埋）。
      exec = applyRelevanceGuardrail(exec, twoDayPool);
      // B7 边界互斥守卫：同一事件不得既必读/商机又风险（确定性去重，不靠 LLM 自觉）。
      exec = dedupeExecutiveCrossSection(exec);
      // 内容记忆闸门：过滤「昨天刚说过、今天无增量」的重复表述，
      // 必须重播的强制换角度，板块被去重掏空时分三级兜底补齐。
      exec = guard(exec);
      const next: DailyReport = { ...report };
      if (exec.hero_line) next.hero_line = exec.hero_line;
      const mustRead = exec.must_read
        .filter((m) => !!m.url)
        .map((m) => ({ title: m.title, why: m.why, url: m.url as string }));
      // 兜底条目（评分器生成）可能无 url；有 url 才写盘（ReportMustRead.url 必填），
      // 全部无 url 时保留 report 原值，避免必读被静默清空
      if (mustRead.length) next.must_read = mustRead;
      if (exec.insights.length) {
        next.insights = exec.insights.map((it) => ({
          topic: it.topic,
          tags: it.tag ?? [],
          impact: it.impact,
          action: it.action,
          ...(it.sources && it.sources.length ? { sources: it.sources } : {}),
        }));
      }
      // M 层：风险落地（ExecRisk → DailyReport.risk）
      if (exec.risk) {
        next.risk = {
          topic: exec.risk.topic,
          evidence: exec.risk.evidence,
          impact: exec.risk.impact,
          action: exec.risk.action,
          ...(exec.risk.url ? { url: exec.risk.url } : {}),
          ...(exec.risk.source ? { source: exec.risk.source } : {}),
          ...(exec.risk.sources && exec.risk.sources.length
            ? { sources: exec.risk.sources }
            : {}),
        };
      }
      writeStore(date, exec);
      ctx.log.info(
        "exec",
        `🧠 必读/商机/风险(今昨2天窗口)生成：${exec.must_read.length} 必读 / ${exec.insights.length} 商机 / ${exec.risk ? 1 : 0} 风险（输入 finance ${pool.finance.length} + gz ${pool.gz.length}）`,
      );
      persistMemory();
      return finalize(next);
    }
    ctx.log.info("exec", `ℹ️ 2天窗口执行摘要为空（沿用 PASS2 产出）`);
    persistMemory();
    return finalize(report);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log.warn("exec", `⚠️ 2天窗口执行摘要生成失败: ${msg}`);
    // 2026-08-31：LLM 抛错同样回退 2 天评分兜底 —— 与「LLM 返回空」同口径，
    // 保证「今日分析/定调」永不空且与下方展示一致（此前沿用 PASS2 会重现薄产出问题）。
    try {
      const fb = buildExecutiveFromScores(twoDayPool, date);
      if (fb.must_read.length || fb.insights.length) {
        const next = mergeStoredExecutive(report, guard(fb));
        ctx.log.info(
          "exec",
          `🔁 LLM 异常回退 2 天评分兜底：必读 ${next.must_read.length} / 商机 ${next.insights.length}`,
        );
        persistMemory();
        return finalize(next);
      }
    } catch (e2) {
      ctx.log.warn(
        "exec",
        `⚠️ 评分兜底也失败（沿用 PASS2）: ${e2 instanceof Error ? e2.message : String(e2)}`,
      );
    }
    persistMemory();
    return finalize(report);
  }
}
