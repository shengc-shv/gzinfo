/**
 * 阶段①：晚间预分析（M4）。
 *
 * 职责：抓取 → 筛选 → 产出待打标队列 → 合并打标结果进 Tag Store。
 * **全程不调用生产 LLM**（强制 SKIP_AI=1），打标由 WorkBuddy 离线完成，
 * 或用 --tagger=llm 显式改用生产 LLM（CI 场景）。
 *
 * ⚠️ 触发时刻不固定（20:00 只是举例）：本脚本不读取当前钟点，
 *    阶段由 PIPELINE_PHASE=pre 显式声明，重复运行幂等。
 *
 * 用法：
 *   npm run pre-analyze                    # 采集 + 产出队列；若已有 incoming 则一并合并
 *   npm run pre-analyze -- --emit-only     # 只产出队列（等 WorkBuddy 打标）
 *   npm run pre-analyze -- --commit-only   # 只合并 incoming（不重新采集）
 *   npm run pre-analyze -- --tagger=llm    # 用生产 LLM 打标（需凭证，本地不可用）
 *
 * 输入：
 *   - 采集：源注册表（lib/sources/registry）
 *   - 打标结果：data/tag-incoming.json
 *       { "items": [ { "url": "...", "aiRelevant": true, "summary": "...",
 *                      "section": "biz_insight", "locale": "national",
 *                      "tags": ["财富"], "importance": 2 } ] }
 * 输出：
 *   - data/tag-queue.json（待打标队列，供 WorkBuddy / LLM 消费）
 *   - data/tag-store.json（标签仓库，增量更新）
 */

import "./_env";

import fs from "node:fs";
import path from "node:path";

import { bootstrap } from "../lib/pipeline/bootstrap";
import { ingestAll } from "../lib/pipeline/ingest";
import { runFilterPipeline } from "../lib/pipeline/filter";
import { loadHistory } from "../lib/output/history";
import type { ArticleInput } from "../lib/types";
import {
  loadTagStore,
  saveTagStore,
  upsertRecords,
  pruneStore,
  buildRecord,
  storeStats,
  tagStoreEnabled,
} from "../lib/tagstore/store";
import { lookup, TAG_STORE_PATH } from "../lib/tagstore/store";
import { urlId, titleFingerprint, contentFingerprint, normalizeUrl } from "../lib/tagstore/dedupe";
import { recordFromArticle } from "../lib/tagstore/merge";
import type { TagRecord, Tagger } from "../lib/tagstore/types";
import { reportDate, windowDays } from "../lib/tagstore/phase";
import { windowBounds } from "../lib/tagstore/window";

const DATA_DIR = path.resolve(process.cwd(), "data");
const QUEUE_PATH = path.resolve(DATA_DIR, process.env.TAG_QUEUE_PATH ?? "tag-queue.json");
const INCOMING_PATH = path.resolve(DATA_DIR, process.env.TAG_INCOMING_PATH ?? "tag-incoming.json");

interface QueueItem {
  id: string;
  url: string;
  title: string;
  sourceId?: string;
  source?: string;
  publishedAt: string;
  excerpt: string;
  titleFp: string;
  contentFp: string;
  /** 业务相关性红线提示：是否命中客群/财富/私行/信贷锚词（仅提示，最终由打标者判定） */
  businessHint: string[];
}

interface IncomingItem {
  url: string;
  aiRelevant: boolean;
  summary?: string;
  section?: TagRecord["section"];
  locale?: TagRecord["locale"];
  tags?: string[];
  importance?: 1 | 2 | 3;
}

const BUSINESS_KEYWORDS: Record<string, string[]> = {
  客群: ["客群", "零售客户", "获客", "客群经营", "客户增长"],
  财富: ["财富", "理财", "基金", "净值", "代销", "中收", "贵金属", "黄金", "保险"],
  私人银行: ["私人银行", "私行", "家族信托", "高净值", "传承", "离岸"],
  信贷: ["信贷", "贷款", "按揭", "房贷", "消费金融", "普惠", "不良", "授信", "供应链金融"],
};

/** IPO 类条目的单独保留期（天）：与过滤层 7 天窗口豁免对齐。 */
const IPO_RETAIN_DAYS = 7;

/** 是否 IPO 类（源 id / 标题 / 板块任一命中）。 */
function isIpoLike(title?: string, sourceId?: string, section?: string): boolean {
  if (section === "ipo") return true;
  const sid = (sourceId ?? "").toLowerCase();
  if (sid.includes("ipo") || sid.includes("declare")) return true;
  return /IPO|提交注册|问询|上市委|首发/.test(title ?? "");
}

function businessHint(title: string, excerpt: string): string[] {
  const text = `${title} ${excerpt}`;
  return Object.entries(BUSINESS_KEYWORDS)
    .filter(([, words]) => words.some((w) => text.includes(w)))
    .map(([line]) => line);
}

/** 采集 + 过滤（与正式运行同路径，保证口径一致）。 */
async function collect(): Promise<ArticleInput[]> {
  // 预分析阶段强制走 SKIP_AI：绝不触发生产 LLM
  process.env.SKIP_AI = "true";
  const ctx = await bootstrap();
  const ingested = await ingestAll(ctx);
  const filtered = runFilterPipeline(ingested.articles, ctx);
  console.log(
    `[pre-analyze] 采集 ${ingested.articles.length} 条 → 过滤后 ${filtered.articles.length} 条`,
  );
  return filtered.articles;
}

/** 生成待打标队列（自动跳过 store 中已有有效记录的条目 = 幂等）。 */
function buildQueue(articles: ArticleInput[], store: ReturnType<typeof loadTagStore>): QueueItem[] {
  const out: QueueItem[] = [];
  for (const a of articles) {
    if (!a?.url) continue;
    // 时间真实性红线：无真实发布时间不入库、不进队列
    const publishedAt = a.publishedAt
      ? new Date(a.publishedAt as unknown as string).toISOString()
      : undefined;
    if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) continue;
    // 已打过标 → 跳过（重复运行幂等）
    if (lookup(store, a.url, a.title ?? "")) continue;
    out.push({
      id: urlId(a.url),
      url: a.url,
      title: a.title ?? "",
      sourceId: a.sourceId,
      source: a.source,
      publishedAt,
      excerpt: (a.excerpt ?? "").slice(0, 300),
      titleFp: titleFingerprint(a.title ?? ""),
      contentFp: contentFingerprint(a.title ?? "", a.excerpt ?? ""),
      businessHint: businessHint(a.title ?? "", a.excerpt ?? ""),
    });
  }
  return out;
}

/** 从队列 / 历史库补出条目元数据（incoming 只有 url 时用来补全）。 */
function resolveArticleMeta(url: string, queue: QueueItem[]): ArticleInput | undefined {
  const q = queue.find((x) => x.url === url || x.id === urlId(url));
  if (q) {
    return {
      url: q.url,
      title: q.title,
      source: q.source ?? "",
      sourceId: q.sourceId,
      excerpt: q.excerpt,
      publishedAt: new Date(q.publishedAt) as unknown as Date,
    } as ArticleInput;
  }
  const history = loadHistory();
  const hit = history[url] ?? history[normalizeUrl(url)];
  if (hit) {
    return {
      url,
      title: hit.title ?? "",
      source: hit.source ?? "",
      sourceId: hit.sourceId,
      excerpt: hit.excerpt ?? "",
      publishedAt: new Date(hit.publishedAt as unknown as string) as unknown as Date,
    } as ArticleInput;
  }
  return undefined;
}

/** 合并 incoming 打标结果进 store。 */
function commitIncoming(queue: QueueItem[], tagger: Tagger): { added: number; updated: number; skipped: number; missing: number } {
  if (!fs.existsSync(INCOMING_PATH)) {
    console.log(`[pre-analyze] 未发现 ${path.basename(INCOMING_PATH)}，跳过合并`);
    return { added: 0, updated: 0, skipped: 0, missing: 0 };
  }
  const parsed = JSON.parse(fs.readFileSync(INCOMING_PATH, "utf8")) as
    | { items?: IncomingItem[] }
    | IncomingItem[];
  const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  if (items.length === 0) {
    console.log("[pre-analyze] incoming 为空，跳过合并");
    return { added: 0, updated: 0, skipped: 0, missing: 0 };
  }

  const store = loadTagStore();
  const records: TagRecord[] = [];
  let missing = 0;
  for (const it of items) {
    if (!it?.url) continue;
    const art = resolveArticleMeta(it.url, queue);
    if (!art) {
      missing++;
      continue;
    }
    const rec = recordFromArticle(
      art,
      {
        aiRelevant: Boolean(it.aiRelevant),
        summary: it.summary,
        section: it.section,
        locale: it.locale,
        tags: it.tags,
        importance: it.importance,
      },
      tagger,
    );
    if (rec) {
      // IPO 在过滤层有 7 天窗口豁免，标签库同步放宽，避免被 3 天保留期误清
      if (isIpoLike(art.title, art.sourceId, it.section)) rec.retainDays = IPO_RETAIN_DAYS;
      records.push(rec);
    } else missing++;
  }

  const stats = upsertRecords(store, records);
  const removed = pruneStore(store);
  saveTagStore(store);
  const after = storeStats(store);
  console.log(
    `[pre-analyze] 合并：新增 ${stats.added} / 更新 ${stats.updated} / 无变化 ${stats.skipped} / 元数据缺失 ${missing}；清理过期 ${removed}`,
  );
  console.log(
    `[pre-analyze] 标签库现有 ${after.total} 条（有价值 ${after.relevant}）→ ${TAG_STORE_PATH}`,
  );
  return { ...stats, missing };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const emitOnly = argv.includes("--emit-only");
  const commitOnly = argv.includes("--commit-only");
  const tagger: Tagger = argv.includes("--tagger=llm") ? "llm" : "workbuddy";

  if (!tagStoreEnabled()) {
    console.log("[pre-analyze] TAG_STORE 已关闭（TAG_STORE=0），退出");
    return;
  }
  if (!process.env.PIPELINE_PHASE) process.env.PIPELINE_PHASE = "pre";

  console.log(
    `[pre-analyze] 阶段=pre 报告日=${reportDate()} 窗口天数=${windowDays()} 打标者=${tagger}`,
  );

  let queue: QueueItem[] = [];
  if (!commitOnly) {
    const store0 = loadTagStore();
    const before = storeStats(store0);
    const articles = await collect();
    queue = buildQueue(articles, store0);
    console.log(
      `[pre-analyze] 待打标 ${queue.length} 条（标签库已有 ${before.total} 条，已命中的自动跳过）`,
    );
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      QUEUE_PATH,
      JSON.stringify({ generatedAt: new Date().toISOString(), items: queue }, null, 2),
    );
    console.log(`[pre-analyze] 队列已写出 → ${QUEUE_PATH}`);
  } else if (fs.existsSync(QUEUE_PATH)) {
    const raw = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
    queue = raw?.items ?? [];
  }

  if (tagger === "llm" && !commitOnly) {
    console.log("[pre-analyze] --tagger=llm 需在 CI 环境运行（本地 LLM 后端不可用），本次跳过自动打标");
  }

  if (!emitOnly) {
    commitIncoming(queue, tagger);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[pre-analyze] FAILED:", e);
    process.exit(1);
  });
