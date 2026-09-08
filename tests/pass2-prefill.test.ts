/**
 * PASS2 预分析缓存复用（prefill）回归测试（2026-09-08 需求）。
 *
 * 验证全 AI 模式下 runPass2 对命中 pre1 打标（prefillCache）条目的处理：
 *  1. cached 条目不进 LLM payload，直接确定性复用 prefill summary（落位沿用 PASS1 判定的 section）
 *  2. LLM 失败（runner 抛错）时仍保留 cached 条目，不丢预分析成果
 *  3. 全部命中缓存时完全跳过 LLM 调用（省一整次 PASS2）
 *  4. 无 prefill 时行为不变（全量走 LLM）
 *  5. fresh 条目正常走 LLM，summary 取 LLM 产出（不取 prefill）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPass2 } from "../lib/ai/pass2";
import type { Pass1Item, LlmRunner } from "../lib/ai/pass1";
import type { ReportSectionKey, SourceType, Locale } from "../lib/types";

function makeKept(url: string, section: ReportSectionKey): Pass1Item {
  return {
    url,
    title: `标题-${url}`,
    title_cn: `标题-${url}`,
    source: "src",
    source_type: "media" as SourceType,
    date: "09/08",
    tags: ["tag-a"],
    locale: "national" as Locale,
    section,
    importance_candidate: 2,
    raw_text: "这是一段用于测试的原文内容，长度需要足够以通过截断逻辑而不丢失关键信息。",
  };
}

function findItem(report: any, url: string): any {
  for (const sec of Object.keys(report.sections)) {
    const it = report.sections[sec].find((x: any) => x.url === url);
    if (it) return it;
  }
  return undefined;
}

const FRESH_LLM_OUT = (url: string, titleCn: string) =>
  JSON.stringify({
    sections: {
      gz_local: [
        {
          url,
          summary: "LLM_SUMMARY",
          importance: 3,
          tags: ["tag-a"],
          title_cn: titleCn,
          title_orig: undefined,
          source: "src",
          source_type: "media",
          date: "09/08",
          locale: "national",
          locale_evidence: undefined,
        },
      ],
    },
    must_read: [{ url, why: "x" }],
    insights: [],
    hero_line: "h",
  });

test("cached 条目不进 LLM payload，且复用 prefill summary", async () => {
  const cached = makeKept("https://example.com/cached", "biz_insight");
  const fresh = makeKept("https://example.com/fresh", "gz_local");
  let payloadSeen = "";
  const runner: LlmRunner = async (_sys, up) => {
    payloadSeen = up;
    return FRESH_LLM_OUT(fresh.url, fresh.title_cn);
  };
  const prefill = new Map<string, string>([[cached.url, "PREFILL_SUMMARY"]]);
  const report = await runPass2([cached, fresh], runner, undefined, prefill);

  assert.ok(!payloadSeen.includes(cached.url), "cached 条目不应进入 LLM payload");
  assert.ok(payloadSeen.includes(fresh.url), "fresh 条目应进入 LLM payload");

  const cachedItem = findItem(report, cached.url);
  assert.ok(cachedItem, "cached 条目应出现在报告");
  assert.equal(cachedItem.summary, "PREFILL_SUMMARY");
  assert.equal(
    report.sections.biz_insight.some((x: any) => x.url === cached.url),
    true,
    "cached 应落在 PASS1 判定的 biz_insight 板块",
  );
});

test("LLM 失败时仍保留 cached 条目，不丢预分析成果", async () => {
  const cached = makeKept("https://example.com/cached", "biz_insight");
  const fresh = makeKept("https://example.com/fresh", "gz_local");
  const runner: LlmRunner = async () => {
    throw new Error("LLM down");
  };
  const prefill = new Map<string, string>([[cached.url, "PREFILL_SUMMARY"]]);
  const report = await runPass2([cached, fresh], runner, undefined, prefill);

  const cachedItem = findItem(report, cached.url);
  assert.ok(cachedItem, "LLM 失败也应保留 cached 条目");
  assert.equal(cachedItem.summary, "PREFILL_SUMMARY");
  assert.equal(findItem(report, fresh.url), undefined, "fresh 因 LLM 失败无法生成，不应出现");
});

test("全部命中缓存时完全跳过 LLM 调用（省一整次 PASS2）", async () => {
  const c1 = makeKept("https://example.com/c1", "biz_insight");
  const c2 = makeKept("https://example.com/c2", "policy_market");
  let called = 0;
  const runner: LlmRunner = async () => {
    called++;
    return JSON.stringify({ sections: {}, must_read: [], insights: [], hero_line: "" });
  };
  const prefill = new Map<string, string>([
    [c1.url, "S1"],
    [c2.url, "S2"],
  ]);
  const report = await runPass2([c1, c2], runner, undefined, prefill);
  assert.equal(called, 0, "全部命中缓存时不应调用 LLM");
  assert.ok(findItem(report, c1.url), "c1 应出现");
  assert.ok(findItem(report, c2.url), "c2 应出现");
});

test("无 prefill 时行为不变（全量走 LLM）", async () => {
  const fresh = makeKept("https://example.com/fresh", "gz_local");
  let called = 0;
  const runner: LlmRunner = async (_s, up) => {
    called++;
    return FRESH_LLM_OUT(fresh.url, fresh.title_cn);
  };
  const report = await runPass2([fresh], runner);
  assert.equal(called, 1, "无 prefill 时应调用 LLM 全量生成");
  const item = findItem(report, fresh.url);
  assert.equal(item.summary, "LLM_SUMMARY");
});

test("fresh 条目走 LLM 取 LLM 产出，不受 prefill 干扰", async () => {
  const fresh = makeKept("https://example.com/fresh", "gz_local");
  // prefill 含一个不在 kept 中的干扰 url（不应影响 fresh 的 LLM 生成）
  const runner: LlmRunner = async (_s, up) => FRESH_LLM_OUT(fresh.url, fresh.title_cn);
  const prefill = new Map<string, string>([["https://example.com/other", "STALE_PREFILL"]]);
  const report = await runPass2([fresh], runner, undefined, prefill);
  const item = findItem(report, fresh.url);
  assert.equal(item.summary, "LLM_SUMMARY", "fresh 应取 LLM 产出而非被 prefill 干扰");
});
