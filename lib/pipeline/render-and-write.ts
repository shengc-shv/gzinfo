/**
 * 渲染 + 写盘（PR5）。
 *
 * 抽取自 daily.ts main 中 167-194 行：
 * - renderHtml / renderMarkdown 渲染
 * - 写主报告到 data/history/reports/<date>/（唯一存储）
 * - 写 sidecar `<date>-articles.json`（today + past-30d 滚动列表）
 * - 导出归一化全量池到 data/fetched-articles.json（供预分析任务或人工核查）
 *
 * 唯一存储：data/history/reports/ 是唯一报告存储；daily_reports/（gh-pages 发布目录）
 * 由 build-site.mjs 在构建时从唯一存储同步，daily.ts 不再写旧目录。
 */

import fs from "node:fs";
import path from "node:path";
import { renderHtml, renderMarkdown } from "../output/render";
import { REPORTS_DIR } from "../output/paths";
import type { AudioMeta } from "../audio/audio";
import type { ArticleInput, DailyReport } from "../types";
import type { DailyContext } from "./context";

export interface RenderAndWriteInput {
  /** 最终 report（含 side outputs） */
  report: DailyReport;
  /** 滚动列表（today + past-30d）—— sidecar `<date>-articles.json` 用 */
  rolling: ArticleInput[];
  /** 语音元数据（失败/缺失时为 undefined） */
  audio: AudioMeta | undefined;
  /** 9 道过滤后的 articles —— 导出 data/fetched-articles.json 用 */
  filteredArticles: ArticleInput[];
}

/**
 * 渲染 + 写主报告 + sidecar + 导出全量池。
 * 失败抛错（与原 main 行为一致）。
 */
export async function renderAndWrite(
  input: RenderAndWriteInput,
  ctx: DailyContext,
): Promise<void> {
  const { report, rolling, audio, filteredArticles } = input;
  const date = ctx.date;

  // ① 渲染
  const html = renderHtml(report, date, { audio });
  const md = process.env.OUTPUT_MARKDOWN === "true" ? renderMarkdown(report, date) : null;

  // ② 写主报告到唯一存储
  const d = path.join(REPORTS_DIR, date);
  fs.mkdirSync(d, { recursive: true });
  const b = path.join(d, date);
  fs.writeFileSync(`${b}.json`, JSON.stringify(report, null, 2), "utf8");
  // Sidecar with the rolling article list (today + past-30d) + LLM-attached
  // summary, so scripts/render.ts can rebuild HTML/MD for UI iteration
  // without re-fetching or re-calling the LLM.
  fs.writeFileSync(
    `${b}-articles.json`,
    JSON.stringify({ date, articles: rolling }, null, 2),
    "utf8",
  );
  fs.writeFileSync(`${b}.html`, html, "utf8");
  if (md) fs.writeFileSync(`${b}.md`, md, "utf8");
  ctx.log.info(
    "render",
    `wrote ${b}.{json,html${md ? ",md" : ""},articles.json}（唯一存储 data/history/reports/）`,
  );

  // ③ 导出归一化全量池（关键词漏斗后），供"预分析"任务或人工核查比对
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(
    "data/fetched-articles.json",
    JSON.stringify(filteredArticles, null, 2),
    "utf8",
  );
  ctx.log.info(
    "render",
    `📤 归一化全量池导出: ${filteredArticles.length} 条 → data/fetched-articles.json`,
  );

  ctx.log.info("render", "done");
}
