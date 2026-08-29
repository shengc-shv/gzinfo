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
} from "../../ai/executive-summary";
import { mergeStoredExecutive } from "../../output/render";
import { buildTwoDayExecPool, collectTwoDayArticles } from "../../ai/exec-pool";
import type { HistoryStore } from "../../output/history";
import type { FilterResult } from "../../filters/types";
import type { DailyContext } from "../context";

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
  const stored = loadStore(date);
  // 两天（今天 + 昨天）可评分池：兜底与护栏都基于它。
  // 必要性：用户 6-8 点跑，跨天判重后「今天」常只剩十余条低信号新条目，
  // 只看今天会让兜底产出空必读；昨日白天的重要条目须从历史库捞回（2026-08-29）。
  const twoDayPool = collectTwoDayArticles({ history, articles, today: date });

  // SKIP_AI 分支：仅复用 store，不调 LLM
  if (ctx.mode.kind === "skip-ai") {
    if (stored && (stored.must_read?.length || stored.insights?.length)) {
      const before = { must: report.must_read.length, ins: report.insights.length };
      const next = mergeStoredExecutive(report, stored);
      ctx.log.info(
        "exec",
        `🧠 SKIP_AI 复用 store.json 执行摘要：必读 ${before.must}→${next.must_read.length} / 商机 ${before.ins}→${next.insights.length}`,
      );
      return next;
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
      const next = mergeStoredExecutive(report, fallback);
      ctx.log.info(
        "exec",
        `🧠 SKIP_AI 评分层兜底生成：必读 ${next.must_read.length} / 商机 ${next.insights.length}`,
      );
      return next;
    }
    return report;
  }

  // AI 模式：默认重新生成 LLM（更符合"AI 开 = AI 跑"的用户预期）
  // 仅当 REGEN_EXEC=0 时才复用 store.json（CI 去重 / 失败恢复等显式场景）
  // REGEN_EXEC=1 显式声明"重生成"，与默认行为等价（用于脚本可读性）
  const regenMode = process.env.REGEN_EXEC ?? "1";  // 默认 "1"（重新生成）
  if (regenMode === "0" && stored && (stored.hero_line || stored.must_read?.length || stored.insights?.length)) {
    const next = mergeStoredExecutive(report, stored);
    if (stored.hero_line) next.hero_line = stored.hero_line;
    ctx.log.info(
      "exec",
      `🧠 AI 模式 + REGEN_EXEC=0 复用 store.json 执行摘要：${stored.must_read?.length ?? 0} 必读 / ${stored.insights?.length ?? 0} 商机`,
    );
    return next;
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
    let exec = await generateExecutiveSummary({
      date,
      finance: pool.finance,
      gz: pool.gz,
      ...(riskCandidates.length > 0 ? { riskCandidates } : {}),
    });
    if (exec) {
      // 评分护栏：LLM 生成后按分行相关性重排必读 + 强制顶入硬规则条目，
      // 让「客户中心」不依赖 LLM 临场发挥（房贷40年型不可能被埋）。
      exec = applyRelevanceGuardrail(exec, twoDayPool);
      // B7 边界互斥守卫：同一事件不得既必读/商机又风险（确定性去重，不靠 LLM 自觉）。
      exec = dedupeExecutiveCrossSection(exec);
      const next: DailyReport = { ...report };
      if (exec.hero_line) next.hero_line = exec.hero_line;
      const mustRead = exec.must_read
        .filter((m) => !!m.url)
        .map((m) => ({ title: m.title, why: m.why, url: m.url as string }));
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
        `🧠 必读/商机/风险(今昨2天窗口)生成：${exec.must_read.length} 必读 / ${exec.insights.length} 商机 / ${exec.risk ? 1 : 0} 风险（输入 finance ${pool.finance.length} + gz ${pool.gz}）`,
      );
      return next;
    }
    ctx.log.info("exec", `ℹ️ 2天窗口执行摘要为空（沿用 PASS2 产出）`);
    return report;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log.warn("exec", `⚠️ 2天窗口执行摘要生成失败（沿用 PASS2）: ${msg}`);
    return report;
  }
}
