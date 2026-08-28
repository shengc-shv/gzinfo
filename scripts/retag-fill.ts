/**
 * 给 history 旧条目补标（2026-08-28 用户反馈 A 任务）。
 *
 * 背景：每日 daily 跑时，sina-a-stock 等 7 源只给「当日新文」。前一天抓的条目
 * 进入 article-history.json（7 天窗口可用），但如果它们从未被 LLM 预分析过
 * （ai_relevant=null / summary 缺失）→ mergeRolling 把它们合入 sections 后，render
 * 阶段用 `if (!summary) continue` 踢出（避免空卡），最终用户看不到这些条目。
 *
 * 例如用户给的 URL：
 *   https://finance.sina.com.cn/jjxw/2026-08-27/doc-iniptaff5800386.shtml
 *   "多家A股上市券商中期业绩显著增长" — 8-27 抓的，进 history，但 ai_relevant=null
 *   → 8-28 报告 sections 里被 line 1305 踢出。
 *
 * 本脚本：扫描 history 中 ai_relevant=null 或 subcategory=null 或 summary 缺失
 * 的条目，LLM 逐条补标（ai_relevant + subcategory + summary），写回 article-history.json。
 *
 * 与 scripts/retag-relevance.ts 区别：retag-relevance 是清理无相关条目（强制 ai_relevant=false）；
 *                  retag-fill  是给空条目打标（标 ai_relevant=true/false + subcategory + summary）。
 *
 * 用法：
 *   node --import tsx scripts/retag-fill.ts           # 扫全 history 补标
 *   node --import tsx scripts/retag-fill.ts --limit 100   # 限量（防 LLM 成本爆炸）
 *   node --import tsx scripts/retag-fill.ts --dry-run     # 只看不写
 *   node --import tsx scripts/retag-fill.ts --batch 20     # 每批 20 条 LLM 一次
 */
import fs from "node:fs";
import { runLlm } from "../lib/ai/llm";
import { extractJson } from "../lib/ai/json-util";

const HIST_PATH = "data/article-history.json";
const BATCH = Number(process.env.RETAG_BATCH ?? "30");
const CONCURRENCY = 3;

interface HistoryEntry {
  title?: string;
  sourceId?: string;
  category?: string;
  subcategory?: string;
  summary?: string;
  ai_relevant?: boolean;
  publishedAt?: string;
  [k: string]: unknown;
}

const SYSTEM_PROMPT =
  "你是股份行广州分行零售研判编辑。逐条给 history 补 ai_relevant/subcategory/summary 三个字段。严格按 schema 输出 JSON 数组。";

const USER_TEMPLATE = `请对以下每条资讯补三个字段（输出 JSON 数组，每条对应一条，顺序与输入一致）：
- ai_relevant (boolean): 与银行零售/对公业务/分行决策有参考价值则 true；纯噪声（娱乐/无关地区/纯行政/已废弃话题）则 false
- subcategory (string): 归到 biz_insight / policy_market / gz_local / gz_wealth / gz_credit / tech / ipo / gd-ipo 之一；不确定时给 "uncategorized"
- summary (string, 30-70 字): 银行视角一句话摘要

输入（JSON 数组，每条含 url/title/excerpt/sourceId）：
{ITEMS_JSON}

输出 STRICTLY 一个 JSON 数组（无 markdown 代码块）：
[{"url":"...","ai_relevant":true,"subcategory":"...","summary":"..."}, ...]`;

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function needRetag(e: HistoryEntry): boolean {
  if (e.ai_relevant !== true) return true;
  if (!e.subcategory) return true;
  if (!e.summary || !e.summary.trim()) return true;
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

  const hist = JSON.parse(fs.readFileSync(HIST_PATH, "utf8")) as Record<string, HistoryEntry>;
  const targets = Object.entries(hist)
    .filter(([, e]) => e?.title && needRetag(e))
    .slice(0, limit);

  console.log(
    `[retag-fill] 扫描完成：history 总 ${Object.keys(hist).length} 条，待补标 ${targets.length} 条${dryRun ? "（dry-run，不写）" : ""}`,
  );
  if (targets.length === 0) {
    console.log("[retag-fill] 无需补标，退出");
    return;
  }

  const batches = chunk(targets, BATCH);
  const results: Array<{ url: string; ok: boolean; data?: any; err?: string }> = [];
  const failedBatches: Array<{ url: string; err: string }> = [];

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const concurrent = batches.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      concurrent.map(async (batch) => {
        const items = batch.map(([url, e]) => ({
          url,
          title: e.title ?? "",
          excerpt: e.excerpt ?? "",
          sourceId: e.sourceId ?? "",
        }));
        const userPrompt = USER_TEMPLATE.replace("{ITEMS_JSON}", JSON.stringify(items));
        const result = await runLlm(
          { systemPrompt: SYSTEM_PROMPT, userPrompt, timeoutMs: 120_000 },
          { stage: "other" },
        );
        const cleaned = extractJson(result.text);
        let parsed: any = cleaned;
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          const jsonrepair = (await import("jsonrepair")).jsonrepair;
          parsed = JSON.parse(jsonrepair(cleaned));
        }
        if (!Array.isArray(parsed)) {
          throw new Error("LLM 输出非数组");
        }
        return { batch, parsed };
      }),
    );
    for (let bi = 0; bi < batchResults.length; bi++) {
      const r = batchResults[bi];
      const batch = concurrent[bi];
      if (r.status === "fulfilled") {
        const { parsed } = r.value;
        for (let j = 0; j < batch.length; j++) {
          const [url] = batch[j];
          const got = parsed[j];
          if (got && typeof got === "object" && "ai_relevant" in got) {
            results.push({ url, ok: true, data: got });
          } else {
            results.push({ url, ok: false, err: "无 ai_relevant 字段" });
          }
        }
      } else {
        const errMsg = (r.reason as Error)?.message ?? String(r.reason);
        console.warn(`[retag-fill] 整批失败: ${errMsg.slice(0, 100)}`);
        for (const [url] of batch) {
          failedBatches.push({ url, err: errMsg.slice(0, 200) });
        }
      }
    }
    console.log(
      `[retag-fill] 批次 ${i / CONCURRENCY + 1}/${Math.ceil(batches.length / CONCURRENCY)} 完成（累计 ${results.length + failedBatches.length}/${targets.length}）`,
    );
  }

  const succeeded = results.filter((r) => r.ok);
  const failedInline = results.filter((r) => !r.ok);
  const totalFailed = failedInline.length + failedBatches.length;
  console.log(`\n[retag-fill] 成功 ${succeeded.length} / 失败 ${totalFailed}`);

  if (!dryRun) {
    let written = 0;
    for (const r of succeeded) {
      const e = hist[r.url];
      const d = r.data!;
      if (d.ai_relevant !== undefined) {
        if (e.ai_relevant !== d.ai_relevant) {
          e.ai_relevant = d.ai_relevant;
          written++;
        }
      }
      if (d.subcategory) e.subcategory = d.subcategory;
      if (d.summary) e.summary = d.summary;
    }
    fs.writeFileSync(HIST_PATH, JSON.stringify(hist, null, 2), "utf8");
    console.log(`[retag-fill] 写回 ${HIST_PATH}，变更 ${written} 条 ai_relevant`);
  } else {
    console.log(`[retag-fill] --dry-run，未写盘`);
  }

  if (totalFailed > 0) {
    console.log(`\n[retag-fill] 失败样本（前 5 条）：`);
    const sample = [...failedInline, ...failedBatches].slice(0, 5);
    for (const f of sample) {
      console.log(`  - ${f.url.slice(0, 80)}: ${f.err?.slice(0, 100)}`);
    }
  }
}

main().catch((e) => {
  console.error(`[retag-fill] FAILED:`, e);
  process.exit(1);
});
