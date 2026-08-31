/**
 * 广东地区IPO 板块（side-output，绕过相关性 LLM）。
 *
 * 背景（2026-08-30 实跑结论，CI run 33315502473 日志 line 828-829 证实）：
 *   gd-ipo 文章穿过 9 道过滤后，会被 runAiPipeline（相关性 LLM）整体丢弃——
 *   LLM 不把「ipo」当作有效 section 输出，导致线上 sections['ipo'] 恒为 0、
 *   口播「广东IPO=无」、页面 IPO 动态 tab 空。
 *
 * 修复：IPO 是「参考/结构板块」，应仿 buildStockRecap 直接从 filteredArticles
 * （gd-ipo / ipo 类目，已在 filter 阶段豁免跨天去重）构建 report.sections['ipo']，
 * 完全绕过相关性 LLM。与渲染侧 isGdIpoCandidate / 三道闸内容判定口径一致。
 *
 * 同时导出 buildGdIpoSpoken：确定性拼出口播稿（免 LLM，AI/SKIP_AI 双模式可用）。
 */

import type { ArticleInput, DailyReport, ReportItem } from "../../types";
import type { DailyContext } from "../context";
// 复用渲染侧广东IPO 内容判定（单一口径，避免两套正则漂移）
import { isGdIpoCandidate } from "../../output/render/cards";

/** IPO 类目（结构化爬虫产物：东财在审表 → gd-ipo；辅导备案/交易所权威源 → ipo）。 */
const IPO_CAT = new Set(["gd-ipo", "ipo"]);

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** ArticleInput（gd-ipo/ipo）→ ReportItem（字段对齐板块卡渲染）。 */
function toReportItem(a: ArticleInput): ReportItem {
  const pub = a.publishedAt ? new Date(a.publishedAt) : undefined;
  const mmdd = pub ? `${pad(pub.getMonth() + 1)}/${pad(pub.getDate())}` : "";
  const title = a.title_cn || a.title || "无标题";
  // IPO 是事实参考：summary 取爬虫 excerpt（已带「注册地/保荐/更新」）或标题占位
  const summary = (a.summary || a.excerpt || title).slice(0, 90).trim() || title;
  const tier = a.tier;
  return {
    url: a.url || "",
    title_cn: title,
    title_orig: a.title_cn ? a.title : undefined,
    source: a.source || "",
    source_type: tier === "T1" || tier === "T1.5" ? "official" : "media",
    tier,
    date: mmdd,
    summary,
    importance: 2,
    rank: 0,
    // 广东 IPO 打「粤」标（渲染徽章；口播识别用），全国 ipo 不打
    tags: a.category === "gd-ipo" ? ["粤"] : [],
    locale: "national",
  };
}

/** MM/DD → 可比数值（越新越大），用于板块内按时间倒序。 */
function dateValue(it: ReportItem): number {
  const m = it.date.match(/^(\d{2})\/(\d{2})$/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

/**
 * 把今日 filteredArticles 中的 gd-ipo / ipo 文章直接构建进 report.sections['ipo']，
 * 与 mergeRollingIntoReport 已并入的滚动历史 IPO 条目按 url 去重合并且今日优先。
 * 返回新 report（不 mutate）。无当日 IPO 命中 → 原样返回（保留滚动并入的）。
 */
export function buildGdIpo(
  report: DailyReport,
  filteredArticles: ArticleInput[],
  ctx: DailyContext,
): DailyReport {
  const today = filteredArticles.filter((a) => IPO_CAT.has(a.category ?? ""));
  if (today.length === 0) {
    ctx.log.info("gd-ipo", "ℹ️ 今日 filteredArticles 无 gd-ipo/ipo 命中，保留滚动并入的 IPO 板块");
    return report;
  }
  const newItems = today.map(toReportItem).sort((x, y) => dateValue(y) - dateValue(x));
  const existing = report.sections?.ipo ?? [];
  const seen = new Set(existing.map((i) => i.url));
  const merged: ReportItem[] = [...existing];
  for (const it of newItems) {
    if (!it.url || !seen.has(it.url)) {
      merged.push(it);
      if (it.url) seen.add(it.url);
    }
  }
  merged.sort((x, y) => dateValue(y) - dateValue(x));
  merged.forEach((it, i) => (it.rank = i + 1));
  ctx.log.info(
    "gd-ipo",
    `🏦 广东IPO板块构建：${newItems.length} 条今日 + ${existing.length} 条滚动 = ${merged.length} 条（绕过相关性 LLM）`,
  );
  return { ...report, sections: { ...report.sections, ipo: merged } };
}

/**
 * 确定性口播稿（免 LLM）：从 IPO 板块条目中挑广东企业（「粤」标或 isGdIpoCandidate），
 * 取前 2 条拼成 ≤50 字口语。audio.ts 在 exec.guangdong_ipo.spoken 缺失时调用，
 * 保证 AI / SKIP_AI 两种模式口播都能覆盖广东 IPO（不再依赖 LLM 兜底生成）。
 */
export function buildGdIpoSpoken(items: ReportItem[]): string {
  const cand = items.filter(
    (it) => it.tags?.includes("粤") || isGdIpoCandidate(it.title_cn || "", it.summary || ""),
  );
  if (cand.length === 0) return "";
  const head = cand.slice(0, 2);
  const parts = head.map((it) =>
    (it.title_cn || "")
      // 去括号修饰（「（拟A股）」），冒号改逗号让 TTS 停顿自然：「尚睿科技，IPO已受理」
      .replace(/[（(].*?[)）]/g, "")
      .replace(/[：:]/g, "，")
      .replace(/，+/g, "，")
      .replace(/^，|，$/g, "")
      .trim(),
  );
  let s = parts.join("；");
  // 多于 2 家时收尾「等N家」，避免口播听起来像只有这两家
  if (cand.length > 2) s += `；等${cand.length}家`;
  return s.length > 50 ? s.slice(0, 50) : s;
}
