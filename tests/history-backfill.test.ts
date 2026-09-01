/**
 * PASS2 摘要回流测试（2026-09-01 修复，lib/pipeline/history-step.ts）。
 *
 * 定位到的问题：report.sections 里的 AI 摘要此前**从未回流**到 articles —— saveHistory
 * 写的是原始 articles，LLM 每天现写的解读写完即弃。CI 归档实证：08-31 真 AI 模式跑完后
 * firstSeen=08-31 的 128 条中有 summary 的 **0 条**。
 *
 * 设计口径（与 PASS1/PASS2 职责一致）：
 *  - 进入 report.sections = PASS1 判「值得保留」→ relevant: true；
 *  - PASS2 写的 summary → 回填 articles.summary（仅在原本无摘要时，防降级截断污染）；
 *  - PASS1 drop 的条目不动：业务关系不大，不再花 LLM 写摘要。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { backfillAiSummary, mergeRollingAndSaveHistory } from "../lib/pipeline/history-step";
import type { ArticleInput, DailyReport, ReportItem } from "../lib/types";
import type { DailyContext } from "../lib/pipeline/context";

const HISTORY_PATH = path.resolve(process.cwd(), "data/article-history.json");
const silent = { info() {}, warn() {}, error() {} };

/** 今天 10:00（动态生成，避免写死日期导致窗口类测试翻车）。 */
function todayAt10(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 10, 0, 0);
}

function art(url: string, over: Partial<ArticleInput> = {}): ArticleInput {
  return {
    url,
    title: `标题-${url}`,
    source: "测试源",
    sourceId: "test-src",
    category: "finance",
    excerpt: "原文摘录",
    publishedAt: todayAt10(),
    ...over,
  } as unknown as ArticleInput;
}

function item(url: string, summary: string): ReportItem {
  return {
    url,
    title_cn: `标题-${url}`,
    title_orig: "",
    summary,
    source: "测试源",
    source_type: "media",
    date: "09/01",
    importance: 2,
    rank: 0,
    tags: [],
    locale: "national",
    locale_evidence: "",
  } as unknown as ReportItem;
}

function report(items: ReportItem[]): DailyReport {
  return {
    date: "2026-09-01",
    hero_line: "定调",
    must_read: [],
    insights: [],
    sections: {
      gz_local: items,
      biz_insight: [],
      policy_market: [],
      tech: [],
      ipo: [],
    },
  } as unknown as DailyReport;
}

function makeCtx(history: Record<string, unknown> = {}): DailyContext {
  return {
    startTime: new Date(),
    date: "2026-09-01",
    mode: { kind: "ai" },
    sources: [],
    tierBySource: new Map(),
    history,
    aiAssets: {},
    errors: [],
    log: silent,
  } as unknown as DailyContext;
}

test("PASS2 摘要回流：进正文的条目拿到 summary + relevant=true", () => {
  const arts = [art("a"), art("b")];
  const r = report([item("a", "AI 写的银行视角摘要")]);
  const { articles, count } = backfillAiSummary(r, arts);

  assert.equal(count, 1, "只有进正文的 1 条应被回填");
  const a = articles.find((x) => x.url === "a");
  assert.equal(a?.summary, "AI 写的银行视角摘要", "PASS2 摘要应回流到 articles");
  assert.equal(a?.relevant, true, "PASS1 保留 = AI 认定相关");

  const b = articles.find((x) => x.url === "b");
  assert.equal(b?.summary, undefined, "PASS1 drop 的条目不应被回填（不值得再花 LLM）");
  assert.equal(b?.relevant, undefined, "未判定的条目不写 relevant");
});

test("已有摘要不被覆盖：防 PASS2 降级截断冲掉预分析精心摘要", () => {
  const arts = [art("a", { summary: "预分析补标的精心摘要" })];
  const r = report([item("a", "raw_text 前 90 字截断的降级产物")]);
  const { articles, count } = backfillAiSummary(r, arts);

  assert.equal(count, 0, "已有摘要时不回填");
  assert.equal(articles[0].summary, "预分析补标的精心摘要", "原摘要必须保持不变");
});

test("sections 为空（SKIP_AI 无产出 / 管线全 drop）→ 原样返回，不误标", () => {
  const arts = [art("a")];
  const { articles, count } = backfillAiSummary(report([]), arts);
  assert.equal(count, 0);
  assert.equal(articles[0].summary, undefined);
  assert.equal(articles[0].relevant, undefined);
});

test("端到端：mergeRollingAndSaveHistory 后历史库条目带 AI 摘要与 relevant", (t) => {
  // saveHistory 会真实写盘（data/article-history.json），必须快照 + 恢复
  const snap = fs.existsSync(HISTORY_PATH) ? fs.readFileSync(HISTORY_PATH, "utf8") : null;
  t.after(() => {
    if (snap) fs.writeFileSync(HISTORY_PATH, snap);
    else if (fs.existsSync(HISTORY_PATH)) fs.unlinkSync(HISTORY_PATH);
  });

  const arts = [art("https://example.com/kept"), art("https://example.com/dropped")];
  const r = report([item("https://example.com/kept", "AI 写的银行视角摘要")]);

  const out = mergeRollingAndSaveHistory(r, arts, makeCtx({}), "2026-09-01T02:00:00.000Z");

  const kept = out.history["https://example.com/kept"];
  assert.ok(kept, "条目应入库");
  assert.equal(kept?.summary, "AI 写的银行视角摘要", "次日两天池/滚动并入应能复用该摘要");
  assert.equal(kept?.ai_relevant, true, "相关性判定应落库，供三态门槛使用");

  const dropped = out.history["https://example.com/dropped"];
  assert.ok(dropped, "PASS1 drop 的条目也应入库（判重需要）");
  assert.equal(dropped?.summary, undefined, "drop 条目无摘要（符合设计，省 LLM 成本）");
});
