/**
 * 本地专供 IPO 补数桥（2026-09-11）——**接入层的本地/远端衔接点**。
 *
 * ## 要解决的问题
 * 两个官方权威源被站点 CDN/WAF 拦 GitHub runner 的海外出口 IP：
 *   - `csrcfd`（证监会辅导备案）→ CI 恒 **405**（阿里云 CDN/WAF）；
 *   - **深交所** `www.szse.cn`（审核项目动态 + listed-check B2 上市列表）→ CI 恒 **fetch failed**。
 * 本地（国内网络）实测完全可达（2026-09-11 实锤：csrcfd 3 条深圳企业 / 深交所 2 条拟创业板）。
 * 结果就是：**CI 跑出来的广东 IPO 板块缺了深圳这一半**（深交所=深圳=广东，属核心覆盖）。
 *
 * ## 方案（用户 2026-09-11 拍板）
 * 本地每日 18–19 点跑一次 `npm run ipo:local`（skill `local-ipo-sync`）→ 产出
 * `data/local-ipo.json`（**入库**）→ 远端次日 cron 读取该文件，与在线抓取的 IPO 数据
 * 拼接成完整全貌。
 *
 * ## 统一处理（关键红线）
 * 「丢无日期 / 裁窗口 / 按 URL 去重」**只有一份实现**：`normalizeLocalIpoItems()`
 * （`lib/ingest/merge.ts` 归一化层）。本地写入与远端读取都调它 —— 两边逻辑不可能漂移。
 * 本模块只负责「文件读写 + 与在线条目合并 + 可观测性」，不含任何自有过滤规则。
 *
 * ## 安全边界
 * - 白名单：文件里的 `sourceId` 必须 ∈ `LOCAL_ONLY_IPO_SOURCE_IDS`，否则丢弃并告警
 *   （防止手工改错把别的源灌进 IPO 批次）。
 * - 时间红线：进入文件的条目必须有真实 `publishedAt`（归一化层保证）。
 * - 陈旧保护：文件 `fetchedAt` 超过 `LOCAL_IPO_STALE_DAYS` 天 → 打告警（说明本地同步断了），
 *   但条目仍按窗口裁剪后使用（宁可用近 7 天真实数据，也不静默丢弃）。
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeLocalIpoItems, type CrawledArticle } from "../ingest/merge";
import { IPO_SOURCE_WINDOW_DAYS } from "../ipo-config";

/**
 * 共享归一化器再导出：本地脚本与远端接入都从本模块取它，保证「一个实现、一个入口」。
 * 实现本体在 `lib/ingest/merge.ts`（归一化层），此处仅转出，勿在本文件另写一套。
 */
export { normalizeLocalIpoItems };

/** 补数文件路径（相对仓库根，随代码提交；CI checkout 后可直接读到）。 */
export const LOCAL_IPO_PATH = path.resolve(process.cwd(), "data/local-ipo.json");

/** 文件格式版本（结构变更时递增，读取端据此拒绝不兼容文件）。 */
export const LOCAL_IPO_VERSION = 1;

/** 文件产出者标识（写入端固定填此值，便于排查文件来源）。 */
export const LOCAL_IPO_GENERATOR = "local-ipo-sync";

/** 超过此天数未更新 → 告警「本地同步可能已中断」。 */
export const LOCAL_IPO_STALE_DAYS = 2;

/**
 * **只能本地抓到**的 IPO 源 sourceId 白名单（唯一权威清单）。
 * 与 `lib/sources/crawlers/index.ts` 的 `buildLocalOnlyIpoCrawlers()` 一一对应，
 * 由 `tests/local-ipo.test.ts` 断言两者一致（防止一边加了源另一边忘了）。
 */
export const LOCAL_ONLY_IPO_SOURCE_IDS = ["gd-csrc-tutoring", "gd-szse-audit"] as const;

export interface LocalIpoFile {
  version: number;
  /** 本地抓取完成时刻（ISO 8601 含时区，如 `2026-09-11T18:30:12+08:00`）。 */
  fetchedAt: string;
  /** 产出者（`local-ipo-sync`）。 */
  generator: string;
  /** 写入时使用的窗口口径（天），供读取端自证两边口径一致。 */
  windowDays: number;
  /** 各 sourceId 的条目数（可观测性；CI 日志直接展示）。 */
  sourceCounts: Record<string, number>;
  /** 归一化后的爬虫条目（CrawledArticle 原样，含 sourceId/region/registeredProvince/ipoStage）。 */
  items: CrawledArticle[];
}

/** 读文件结果：`file=null` 时 `reason` 说明为什么不可用（供告警文案）。 */
export interface ReadLocalIpoResult {
  file: LocalIpoFile | null;
  reason?: string;
}

/**
 * 读取补数文件（容错）：不存在 / JSON 坏 / 版本不符 / 结构非法 → `{ file: null, reason }`。
 * 绝不抛异常 —— 远端 CI 不能因为一个数据文件而崩掉整条管线。
 */
export function readLocalIpoFile(filePath: string = LOCAL_IPO_PATH): ReadLocalIpoResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { file: null, reason: "文件不存在" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { file: null, reason: "JSON 解析失败" };
  }
  const f = parsed as Partial<LocalIpoFile>;
  if (!f || typeof f !== "object") return { file: null, reason: "顶层不是对象" };
  if (f.version !== LOCAL_IPO_VERSION) {
    return { file: null, reason: `格式版本不符（文件 ${String(f.version)} ≠ 期望 ${LOCAL_IPO_VERSION}）` };
  }
  if (!Array.isArray(f.items)) return { file: null, reason: "items 不是数组" };
  return {
    file: {
      version: LOCAL_IPO_VERSION,
      fetchedAt: typeof f.fetchedAt === "string" ? f.fetchedAt : "",
      generator: typeof f.generator === "string" ? f.generator : "",
      windowDays: typeof f.windowDays === "number" ? f.windowDays : IPO_SOURCE_WINDOW_DAYS,
      sourceCounts: (f.sourceCounts && typeof f.sourceCounts === "object" ? f.sourceCounts : {}) as Record<string, number>,
      items: f.items as CrawledArticle[],
    },
  };
}

/** 原子写（先写 .tmp 再 rename）：避免 CI 读到半截文件。 */
export function writeLocalIpoFile(file: LocalIpoFile, filePath: string = LOCAL_IPO_PATH): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

/** 文件新鲜度（天）；`fetchedAt` 缺失/非法 → null。语义：不早于今天（未来时间戳记 0）。 */
export function localIpoStalenessDays(fetchedAt: string, now: Date = new Date()): number | null {
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/** 按 sourceId 统计条目数（确定性输出，便于 git diff 稳定）。 */
export function countBySource(items: CrawledArticle[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = it.sourceId || "(无 sourceId)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * **本地写入端**：把本轮新抓的条目与文件里仍在窗口内的旧条目合并成一个快照。
 *
 * 为什么要「保留旧条目」而不是每轮覆盖（自行优化点）：
 *   本地某天跑失败 / 某源临时抽风时，覆盖写会让文件瞬间清空，次日 CI 的深交所/辅导
 *   覆盖直接归零 —— 而这两源本来就只能靠这个文件。保留 + 窗口自动淘汰，等价于给
 *   「本地抓取抖动」加了一层缓冲，最多多留 7 天（与源层窗口一致，不会产生陈旧内容）。
 *
 * 冲突裁决：同一 key 取 `publishedAt` 较新者（官方状态更新时后抓到的更准）。
 * 输出顺序确定性排序（publishedAt 倒序 → sourceId → url），使每日 commit 的 diff 只含真实增量。
 */
export function buildLocalIpoSnapshot(
  crawled: CrawledArticle[],
  opts: {
    prev?: LocalIpoFile | null;
    now?: Date;
    windowDays?: number;
    fetchedAt?: string;
    generator?: string;
  } = {},
): {
  file: LocalIpoFile;
  stats: {
    newRaw: number;
    newNormalized: number;
    prevUsed: number;
    total: number;
    droppedNoDate: number;
    droppedOutOfWindow: number;
    droppedDuplicate: number;
  };
} {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? IPO_SOURCE_WINDOW_DAYS;

  const fresh = normalizeLocalIpoItems(crawled, { windowDays, now });
  const prev = normalizeLocalIpoItems(opts.prev?.items ?? [], { windowDays, now });

  // key → item，prev 打底、fresh 覆盖；冲突取 publishedAt 较新者。
  const byKey = new Map<string, CrawledArticle>();
  const keyOf = (it: CrawledArticle) =>
    it.url?.trim() || `${it.sourceId ?? ""}|${it.title ?? ""}`;
  for (const it of [...prev.items, ...fresh.items]) {
    const k = keyOf(it);
    const old = byKey.get(k);
    if (!old) {
      byKey.set(k, it);
      continue;
    }
    const a = Date.parse(old.publishedAt || "") || 0;
    const b = Date.parse(it.publishedAt || "") || 0;
    if (b >= a) byKey.set(k, it);
  }

  const items = [...byKey.values()].sort((x, y) => {
    if ((y.publishedAt || "") !== (x.publishedAt || "")) {
      return (y.publishedAt || "").localeCompare(x.publishedAt || "");
    }
    if ((x.sourceId || "") !== (y.sourceId || "")) {
      return (x.sourceId || "").localeCompare(y.sourceId || "");
    }
    return (x.url || "").localeCompare(y.url || "");
  });

  const file: LocalIpoFile = {
    version: LOCAL_IPO_VERSION,
    fetchedAt: opts.fetchedAt ?? new Date(now.getTime()).toISOString(),
    generator: opts.generator ?? LOCAL_IPO_GENERATOR,
    windowDays,
    sourceCounts: countBySource(items),
    items,
  };

  return {
    file,
    stats: {
      newRaw: crawled.length,
      newNormalized: fresh.items.length,
      prevUsed: prev.items.length,
      total: items.length,
      droppedNoDate: fresh.droppedNoDate,
      droppedOutOfWindow: fresh.droppedOutOfWindow,
      droppedDuplicate: fresh.droppedDuplicate,
    },
  };
}

/**
 * **远端接入端**：读取补数文件 → 共享归一化 → 与在线条目去重 → 返回「要补充的」条目。
 *
 * 调用点：`lib/sources/crawlers/index.ts` 的 `fetchCrawledArticles()` —— 补进来的条目与
 * 在线爬虫产物汇入**同一个** `ipo` 批次，随后仍走 `mergeCrawledBatch(..., "ipo")` 归一化，
 * 因此下游（漏斗 / gdIpo / render）完全感知不到「这条来自本地」。
 *
 * 在线优先：同一 URL 若在线也抓到了，用在线的那条（更新鲜）。
 */
export function selectLocalIpoItems(
  online: CrawledArticle[],
  opts: { filePath?: string; windowDays?: number; now?: Date } = {},
): CrawledArticle[] {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? IPO_SOURCE_WINDOW_DAYS;
  const { file, reason } = readLocalIpoFile(opts.filePath);
  if (!file) {
    console.warn(
      `[local-ipo] ⚠️ 本地 IPO 补数不可用（${reason}）→ 本次深交所/证监会辅导源为 0 条。` +
        `请本地跑 \`npm run ipo:local\` 补数并推送 data/local-ipo.json。`,
    );
    return [];
  }

  const stale = localIpoStalenessDays(file.fetchedAt, now);
  if (stale !== null && stale > LOCAL_IPO_STALE_DAYS) {
    console.warn(
      `[local-ipo] ⚠️ 补数文件已 ${stale} 天未更新（>${LOCAL_IPO_STALE_DAYS} 天）→ 本地定时同步可能已中断；` +
        `本次仍使用窗口内条目。`,
    );
  }

  const allowed = new Set<string>(LOCAL_ONLY_IPO_SOURCE_IDS as readonly string[]);
  const rejected: string[] = [];
  const candidates = file.items.filter((it) => {
    const id = it.sourceId ?? "";
    if (allowed.has(id)) return true;
    rejected.push(id || "(空 sourceId)");
    return false;
  });
  if (rejected.length > 0) {
    console.warn(
      `[local-ipo] ⚠️ 丢弃 ${rejected.length} 条非白名单条目（sourceId: ${[...new Set(rejected)].join(", ")}）`,
    );
  }

  const norm = normalizeLocalIpoItems(candidates, { windowDays, now });
  const onlineUrls = new Set(online.map((it) => it.url?.trim()).filter(Boolean) as string[]);
  const additions = norm.items.filter((it) => !onlineUrls.has(it.url?.trim() ?? ""));

  const counts = countBySource(additions);
  const detail = Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(" / ");
  console.log(
    `[local-ipo] ✅ 本地补数：文件 ${file.items.length} 条 → 窗口内 ${norm.items.length} 条 → ` +
      `新增 ${additions.length} 条${detail ? `（${detail}）` : ""}；文件抓取于 ${file.fetchedAt || "未知"}`,
  );
  if (norm.droppedNoDate || norm.droppedOutOfWindow || norm.droppedDuplicate) {
    console.log(
      `[local-ipo]    └ 裁剪：无日期 ${norm.droppedNoDate} / 超窗 ${norm.droppedOutOfWindow} / 重复 ${norm.droppedDuplicate}`,
    );
  }
  return additions;
}
