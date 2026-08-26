/**
 * 浓缩选择：must_read / insights 评分与 top-N 选择（N 层）。
 *
 * 业务目标：行长音频时间窗固定（约 60s 必读 + 45s 商机），AI 产出 3-5 条，
 * 但行长实际只听 3 条；用评分函数从 3-5 里选 top 3，让音频时长可控且按行长偏好排序。
 *
 * 评分维度（按权重从高到低）：
 *  1. importance（AI 在 PASS1 给出 1/2/3；3=今日必知，2=默认，1=可归档）
 *  2. 部门 tag 命中（个贷/财富/私行/客群 之一）—— 行长 5 分钟核心
 *  3. 反馈数据：24h 内 👍 +2 / 👎 -2（必须接 data/feedback/ 才能生效）
 *  4. 板块多样化：避免 3 条都来自同一 section（每条重复 section -3）
 *  5. 位置偏置：AI 给出的前几条略加权（must_read[0] +1、[1] +0.5）
 *
 * 返回 { top, rationale }：top 是 topN 条；rationale 是简短说明（调试/UI 显示）
 */

import type { ReportItem, ReportMustRead } from "../types";
import type { FeedbackEntry } from "../feedback/storage";

/** 4 大零售部门 tag（与 render.ts DEPT_TAGS 一致） */
const DEPT_TAGS = new Set(["财富", "私行", "客群", "信贷"]);

export interface SelectTopOptions {
  /** 默认 3；可临时调整为 5（调试） */
  topN?: number;
  /** 仅统计最近 N 小时的反馈（默认 24） */
  feedbackWindowHours?: number;
  /** 板块多样化惩罚（默认 -3 / 同 section 重复） */
  sectionDiversityPenalty?: number;
  /** 部门 tag 命中加成（默认 +3） */
  deptBonus?: number;
}

export interface RankedItem<T> {
  item: T;
  score: number;
  rationale: string;
}

/** 用 url 在 sourceItems 中查 ReportItem，找不到返回 undefined */
function findSourceItem(
  sourceItems: ReportItem[],
  url: string | undefined,
): ReportItem | undefined {
  if (!url) return undefined;
  return sourceItems.find((it) => it.url === url);
}

/** 反馈 → url score（+2 👍 / -2 👎），按 url 聚合（最近 N 小时） */
function feedbackScoreByUrl(
  feedback: FeedbackEntry[],
  windowHours: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!feedback || feedback.length === 0) return out;
  const cutoff = Date.now() - windowHours * 3600_000;
  for (const f of feedback) {
    if (f.ts < cutoff) continue;
    if (f.section !== "must_read") continue;
    const cur = out.get(f.url) ?? 0;
    out.set(f.url, cur + (f.vote === "up" ? 2 : -2));
  }
  return out;
}

/**
 * 给定 must_read 列表 + sourceItems + feedback，按 N 维度评分选 top N。
 * 返回 { top, rationale } —— top 是 ReportMustRead[]（保持原顺序，传递给 audio/render）；
 * rationale 是调试用字符串数组（与 top 一一对应，说明每条的加分来源）。
 */
export function selectTopMustRead(
  mustRead: ReportMustRead[],
  sourceItems: ReportItem[],
  feedback: FeedbackEntry[] = [],
  opts: SelectTopOptions = {},
): { top: ReportMustRead[]; rationale: string[] } {
  const {
    topN = 3,
    feedbackWindowHours = 24,
    sectionDiversityPenalty = -3,
    deptBonus = 3,
  } = opts;
  if (mustRead.length <= topN) {
    return {
      top: mustRead.slice(),
      rationale: mustRead.map(() => "已 ≤ topN，原样保留"),
    };
  }

  const fbScore = feedbackScoreByUrl(feedback, feedbackWindowHours);

  // 第一轮：单条评分
  const scored: RankedItem<ReportMustRead>[] = mustRead.map((m, idx) => {
    const src = findSourceItem(sourceItems, m.url);
    let score = 0;
    const reasons: string[] = [];

    // 1) importance：3=+10，2=+5，1=0（默认 2）
    const imp = src?.importance ?? 2;
    score += imp === 3 ? 10 : imp === 2 ? 5 : 0;
    if (imp === 3) reasons.push("今日必知 +10");

    // 2) 部门 tag 命中
    const tags = src?.tags ?? [];
    const hasDept = tags.some((t) => DEPT_TAGS.has(t));
    if (hasDept) {
      score += deptBonus;
      reasons.push(`部门 tag +${deptBonus}`);
    }

    // 3) 反馈（24h 👍/👎）
    const fb = fbScore.get(m.url ?? "") ?? 0;
    if (fb !== 0) {
      score += fb;
      reasons.push(fb > 0 ? `👍 +${fb}` : `👎 ${fb}`);
    }

    // 4) 位置偏置（AI 排序前几条略加）
    if (idx === 0) { score += 1; reasons.push("AI 排序 #1 +1"); }
    else if (idx === 1) { score += 0.5; reasons.push("AI 排序 #2 +0.5"); }

    return {
      item: m,
      score,
      rationale: reasons.length ? reasons.join("，") : "基线分（无加分项）",
    };
  });

  // 第二轮：板块多样化重排
  // 按 score 降序取 topN；若同 section 累计 ≥ 2，第三个换下一个最高分
  const sectionCount = new Map<string, number>();
  const top: RankedItem<ReportMustRead>[] = [];
  const pool = [...scored].sort((a, b) => b.score - a.score);
  const overflow: RankedItem<ReportMustRead>[] = []; // 被换下的候选

  for (const cand of pool) {
    if (top.length >= topN) {
      overflow.push(cand);
      continue;
    }
    const src = findSourceItem(sourceItems, cand.item.url);
    const sec = src?.source ?? "unknown";
    const cur = sectionCount.get(sec) ?? 0;
    if (cur >= 2 && top.length > 0) {
      // 同 section 已 ≥ 2 → 暂存为候选
      overflow.push(cand);
      cand.rationale += `，同 section(${sec}) 过多，暂换下`;
      continue;
    }
    sectionCount.set(sec, cur + 1);
    top.push(cand);
  }

  // 候选里若有空位 → 按原 score 填充（保持多样性优先：每 section ≤ 2）
  for (const cand of overflow) {
    if (top.length >= topN) break;
    const src = findSourceItem(sourceItems, cand.item.url);
    const sec = src?.source ?? "unknown";
    const cur = sectionCount.get(sec) ?? 0;
    if (cur >= 2) continue; // 多样性仍生效：跳过同 section
    sectionCount.set(sec, cur + 1);
    top.push(cand);
  }

  // 终值：保持 AI 给的原始顺序（行长更易跟踪"AI 怎么排序"）
  const topSet = new Set(top.map((t) => t.item.url));
  const ordered = mustRead.filter((m) => topSet.has(m.url));
  return { top: ordered, rationale: top.map((t) => t.rationale) };
}
