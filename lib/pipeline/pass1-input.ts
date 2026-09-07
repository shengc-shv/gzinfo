/**
 * ArticleInput → Pass1Input 归一化。
 *
 * 从 lib/pipeline/ai.ts 抽出为独立模块（M4）：tagstore/pipeline.ts 与 ai.ts
 * 都要用它，放原处会形成 ai.ts ↔ tagstore/pipeline.ts 的循环依赖。
 */

import type { ArticleInput } from "../types";
import type { Pass1Input } from "../ai/pass1";
import {
  isGzLocalCandidate,
} from "../output/render/cards";
import { LIGHT_AI_SOURCES, LIGHT_AI_RAW_CAP } from "../ai/light-ai";

/** Pass1 输入 raw_text 截断上限（2026-09-05 优化：原 1200 字远超分类判断所需，
 *  且下游 Pass 2 还会二次截断到 600 字，多出部分纯浪费 token 且增大 JSON 断裂概率）。 */
export const PASS1_RAW_CAP = 450;

/** 归一化 ArticleInput → Pass1Input：raw_text 截断 + date MM/DD + gz_hint 提权。 */
export function toPass1Input(a: ArticleInput): Pass1Input {
  const d = a.publishedAt ?? a.fetchedAt;
  const date = d
    ? `${String(new Date(d as unknown as string).getMonth() + 1).padStart(2, "0")}/${String(
        new Date(d as unknown as string).getDate(),
      ).padStart(2, "0")}`
    : "";
  const isLight = LIGHT_AI_SOURCES.has(a.sourceId ?? "");
  const raw = (a.excerpt || a.summary || "").slice(0, isLight ? LIGHT_AI_RAW_CAP : PASS1_RAW_CAP);
  return {
    url: a.url,
    title: a.title,
    source: a.source,
    date,
    raw_text: raw,
    category: a.category,
    // gz_hint 提权（2026-08-21 第二梯队）：标题命中广州锚词 → 标记，降低被
    // 保留标准第2~4条门槛刷掉的概率，Pass 1 倾向判 locale=gz / section=gz_local。
    // 2026-08-29 加业务相关性门槛：只对「广州锚 + 与客群/财富/私行/信贷挂钩」的内容
    // 提权（植物园志愿者/公安通告/学校上新等本地生活政务不占广州本地名额）。
    gz_hint: isGzLocalCandidate(a.title, a.excerpt ?? "") || undefined,
  };
}
