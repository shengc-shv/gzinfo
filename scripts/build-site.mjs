#!/usr/bin/env node
/**
 * Build the static site that gets published to GitHub Pages (or any static
 * host). Run AFTER `npm run daily` has produced today's report.
 *
 * 存储模型（M2-⑤ 去双写，2026-08-19）：
 *   data/history/reports/ 是唯一报告存储（daily.ts 只写这里）；
 *   daily_reports/ 是 gh-pages 发布目录（daily.yml 依赖）。
 * 本脚本负责把唯一存储同步到发布目录：
 *   - 合并唯一存储 + 发布目录里 CI 恢复的历史（双写前的旧报告只在 gh-pages 上）
 *   - 每个日期目录复制到 daily_reports/{date}/（唯一存储优先覆盖）
 *   - 生成 index.html（最新报告）/ archive.html（全部日期）/ .nojekyll
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node scripts/build-site.mjs
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = "daily_reports";
const STORE = "data/history/reports";

const dateDirs = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .filter((d) => fs.existsSync(path.join(dir, d, `${d}.html`)))
    : [];

// 合并唯一存储与发布目录（历史报告可能在发布目录里，双写前产物 / CI 恢复）
const storeDates = new Set(dateDirs(STORE));
const publishDates = new Set(dateDirs(ROOT));
const dates = [...new Set([...storeDates, ...publishDates])].sort((a, b) =>
  b.localeCompare(a),
);

if (dates.length === 0) {
  console.error(`[build-site] 找不到报告目录（${STORE} / ${ROOT}）— 先跑 \`npm run daily\`。`);
  process.exit(1);
}

// 输出目录（发布目录）确保存在
fs.mkdirSync(ROOT, { recursive: true });

// --- 同步每个日期目录到发布目录（唯一存储优先，覆盖旧副本）---
let copied = 0;
for (const d of dates) {
  const src = storeDates.has(d) ? path.join(STORE, d) : path.join(ROOT, d);
  const dst = path.join(ROOT, d);
  if (!storeDates.has(d)) continue; // 发布目录已有，无需动
  fs.cpSync(src, dst, { recursive: true, force: true });
  copied++;
}
console.log(`[build-site] 同步 ${copied} 个日期目录 → ${ROOT}/（共 ${dates.length} 个报告）`);

// --- 音频滚动清理：只保留最近 3 天（报告正文保留 7 天不变）---
// 报告目录整体拷贝后，删除日期早于「今天-3」的 audio/ 子目录（mp3）。
const AUDIO_KEEP_DAYS = 3;
const audioCutoff = new Date();
audioCutoff.setDate(audioCutoff.getDate() - AUDIO_KEEP_DAYS);
let audioCleaned = 0;
for (const d of dates) {
  const ad = path.join(ROOT, d, "audio");
  if (!fs.existsSync(ad)) continue;
  const day = new Date(`${d}T00:00:00`);
  if (day < audioCutoff) {
    fs.rmSync(ad, { recursive: true, force: true });
    audioCleaned++;
    console.log(`[build-site] 🗑 清理过期音频目录：daily_reports/${d}/audio`);
  }
}
if (audioCleaned === 0) {
  console.log(`[build-site] 音频滚动清理：无过期（保留最近 ${AUDIO_KEEP_DAYS} 天）`);
}

// --- 分享缩略图：拷贝到发布根（报告 <head> 的 og:image 绝对地址 ${base}/og-image.png 用）---
const OG_SRC = "assets/og-image.png";
if (fs.existsSync(OG_SRC)) {
  fs.copyFileSync(OG_SRC, path.join(ROOT, "og-image.png"));
  console.log(`[build-site] og-image.png → ${ROOT}/`);
} else {
  console.log(`[build-site] ⚠️ 未找到 ${OG_SRC}，分享卡片缩略图将缺失（og:image 失效）`);
}

// --- index.html = latest report ---
const latest = dates[0];
const latestHtml = fs
  .readFileSync(path.join(ROOT, latest, `${latest}.html`), "utf8")
  .replace(/href="\.\.\/archive\.html"/g, 'href="./archive.html"')
  .replace(/src="audio\//g, `src="${latest}/audio/`);
fs.writeFileSync(path.join(ROOT, "index.html"), latestHtml, "utf8");
console.log(`[build-site] index.html  ← ${latest}/${latest}.html`);

// --- archive.html = list of all reports ---
const rows = dates
  .map((d) => {
    const size = (fs.statSync(path.join(ROOT, d, `${d}.html`)).size / 1024).toFixed(0);
    return `      <li><a href="./${d}/${d}.html">${d}</a> <span class="size">${size} KB</span></li>`;
  })
  .join("\n");

const archiveHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>gzcmbdf3 — archive</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    max-width: 720px;
    margin: 3rem auto;
    padding: 0 1.5rem;
    line-height: 1.5;
  }
  h1 { margin-bottom: 0.2rem; font-size: 1.5rem; }
  .meta { color: #888; font-size: 0.9rem; margin-bottom: 1.5rem; }
  ul { list-style: none; padding: 0; }
  li {
    padding: 0.5rem 0;
    border-bottom: 1px solid #eee;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  @media (prefers-color-scheme: dark) {
    li { border-bottom-color: #2a2a2a; }
  }
  li a { text-decoration: none; }
  li a:hover { text-decoration: underline; }
  .size { color: #999; font-size: 0.85rem; }
  .top {
    margin-bottom: 2rem;
    padding: 0.75rem 1rem;
    background: #f6f6f6;
    border-radius: 6px;
  }
  @media (prefers-color-scheme: dark) {
    .top { background: #1e1e1e; }
  }
</style>
</head>
<body>
  <h1>gzcmbdf3 — archive</h1>
  <p class="meta">${dates.length} report${dates.length === 1 ? "" : "s"} · newest first · generated ${new Date().toISOString().slice(0, 10)}</p>
  <div class="top">
    <a href="./index.html">→ Latest report (${latest})</a>
  </div>
  <ul>
${rows}
  </ul>
</body>
</html>
`;
fs.writeFileSync(path.join(ROOT, "archive.html"), archiveHtml, "utf8");
console.log(`[build-site] archive.html (${dates.length} dates)`);

// .nojekyll prevents GitHub Pages from running Jekyll, which would otherwise
// strip directories whose names start with "_". We don't have any today but
// it's cheap insurance and standard practice for static-site GH Pages.
fs.writeFileSync(path.join(ROOT, ".nojekyll"), "", "utf8");
console.log(`[build-site] .nojekyll`);
