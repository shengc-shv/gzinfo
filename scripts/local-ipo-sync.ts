/**
 * 本地 IPO 补数同步（2026-09-11 用户拍板）——**skill `local-ipo-sync` 的执行体**。
 *
 * ## 一句话
 * 把「CI 抓不到的官方 IPO 源」在本地抓下来，按**与远端完全相同的接入层逻辑**归一化后
 * 写入 `data/local-ipo.json` 并推送；远端次日 cron 读取该文件，与在线抓取的 IPO 数据
 * 拼接成完整全貌。
 *
 * ## 设计纪律（用户 2026-09-11 明确要求）
 * 「按已经跑通方案的逻辑处理，只是在灌入的数据源改一下」——因此本脚本：
 *   - **不自己实现任何过滤/归一去重逻辑**，一律调用接入层共享函数
 *     （爬虫 `run()` → `toGzcmbdf3Format()` 与 `fetchCrawledArticles()` 逐步一致；
 *      归一化 `normalizeLocalIpoItems()` 是本地写入与远端读取的同一份实现）；
 *   - **唯一的差异就是源集合**（`--sources`），默认只跑 `buildLocalOnlyIpoCrawlers()`
 *     （即 CI 不可达的 csrcfd + 深交所），可 `--sources=all` 跑全量核对。
 *
 * ## 用法
 *   npm run ipo:local                 # 抓本地专供源 → 写文件 → 提交推送
 *   npm run ipo:local -- --dry-run     # 只抓与打印，不写盘、不推送
 *   npm run ipo:local -- --no-push     # 写盘但不提交推送
 *   npm run ipo:local -- --sources=all # 用全量 IPO 源跑（本地网络都能到）
 *
 * ## 失败策略
 * 全部源抓取失败 → 退出码 1（让定时任务/技能看到失败），且**保留文件里仍在窗口内的旧条目**
 * （见 buildLocalIpoSnapshot 的 merge-preserve：本地抖动不应让次日 CI 的深交所覆盖归零）。
 */
import "./_env";
import { spawnSync } from "node:child_process";
import { buildIpoCrawlers, buildLocalOnlyIpoCrawlers } from "../lib/sources/crawlers";
import {
  LOCAL_IPO_GENERATOR,
  LOCAL_IPO_PATH,
  buildLocalIpoSnapshot,
  readLocalIpoFile,
  writeLocalIpoFile,
} from "../lib/sources/local-ipo";
import type { CrawledArticle } from "../lib/ingest/merge";
import { IPO_SOURCE_WINDOW_DAYS } from "../lib/ipo-config";
import type { BaseCrawler } from "../lib/sources/crawlers/base-crawler";

interface Args {
  sources: "local-only" | "all";
  windowDays: number;
  file: string;
  dryRun: boolean;
  push: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sources: "local-only",
    windowDays: IPO_SOURCE_WINDOW_DAYS,
    file: LOCAL_IPO_PATH,
    dryRun: false,
    push: true,
  };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-push") args.push = false;
    else if (a.startsWith("--sources=")) {
      const v = a.slice("--sources=".length);
      if (v !== "local-only" && v !== "all") {
        throw new Error(`--sources 只接受 local-only / all，收到：${v}`);
      }
      args.sources = v;
    } else if (a.startsWith("--window=")) {
      const n = Number(a.slice("--window=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--window 非法：${a}`);
      args.windowDays = Math.floor(n);
    } else if (a.startsWith("--file=")) {
      args.file = a.slice("--file=".length);
    } else if (a === "--help" || a === "-h") {
      console.log(
        [
          "用法: npm run ipo:local -- [选项]",
          "  --sources=local-only|all   源集合（默认 local-only = CI 不可达的 csrcfd + 深交所）",
          "  --window=<天>              窗口（默认取 lib/ipo-config.ts 的 IPO_SOURCE_WINDOW_DAYS）",
          "  --file=<路径>              产出文件（默认 data/local-ipo.json）",
          "  --dry-run                  只抓取与打印，不写盘、不推送",
          "  --no-push                  写盘但不 git 提交推送",
        ].join("\n"),
      );
      process.exit(0);
    } else if (a.startsWith("-")) {
      throw new Error(`未知参数：${a}`);
    }
  }
  return args;
}

/** 本地时区的 ISO 8601（含偏移），让文件里的 fetchedAt 人类可读、机器可解析。 */
function isoWithOffset(d: Date, tz = process.env.REPORT_TZ?.trim() || "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const off =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+08:00";
  const m = off.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const suffix = m ? `${m[1]}${m[2]}:${m[3] ?? "00"}` : "+08:00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}${suffix}`;
}

/** 与 `fetchCrawledArticles()` 中 IPO 批次**完全相同**的采集路径（run → toGzcmbdf3Format）。 */
async function crawlIpo(crawlers: BaseCrawler[]): Promise<CrawledArticle[]> {
  const out: CrawledArticle[] = [];
  for (const crawler of crawlers) {
    try {
      await crawler.run();
      out.push(...(crawler.toGzcmbdf3Format() as CrawledArticle[]));
    } catch (err) {
      console.error(`[ipo:local] [${crawler.name}] 爬虫异常: ${(err as Error).message}`);
    }
  }
  return out;
}

function git(args: string[], allowFail = false): boolean {
  const r = spawnSync("git", args, { stdio: "inherit" });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} 失败（exit ${r.status}）`);
  }
  return r.status === 0;
}

/** 取 git 输出（不打印），用于变更判定。 */
function gitCapture(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const crawlers = args.sources === "all" ? buildIpoCrawlers() : buildLocalOnlyIpoCrawlers();
  console.log(
    `[ipo:local] 源集合=${args.sources}（${crawlers.map((c) => c.name).join(" / ")}）；` +
      `窗口=${args.windowDays} 天；文件=${args.file}`,
  );

  // ① 采集（与远端同一条路径）
  const crawled = await crawlIpo(crawlers);
  console.log(`[ipo:local] 抓取完成：原始 ${crawled.length} 条`);

  // ② 归一化 + 与文件里窗口内旧条目合并（共享函数：时间红线 / 窗口 / URL 去重）
  const { file: prev, reason: prevReason } = readLocalIpoFile(args.file);
  if (!prev) console.log(`[ipo:local] 上一版文件不可用（${prevReason}）→ 本次以新抓结果为准`);
  const { file, stats } = buildLocalIpoSnapshot(crawled, {
    prev,
    windowDays: args.windowDays,
    fetchedAt: isoWithOffset(new Date()),
    generator: LOCAL_IPO_GENERATOR,
  });

  console.log(
    `[ipo:local] 归一化：新抓 ${stats.newNormalized}/${stats.newRaw} 条` +
      `（丢无日期 ${stats.droppedNoDate} / 超窗 ${stats.droppedOutOfWindow} / 重复 ${stats.droppedDuplicate}）` +
      `；沿用旧文件窗口内 ${stats.prevUsed} 条 → 最终 ${stats.total} 条`,
  );
  console.log(
    `[ipo:local] 各源条目：${
      Object.entries(file.sourceCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join("  ") || "(空)"
    }`,
  );
  console.log(
    `[ipo:local] 本版条目明细：${file.items
      .map((it) => `${it.publishedAt} ${it.title?.slice(0, 24)}`)
      .slice(0, 20)
      .join(" | ") || "(空)"}`,
  );

  if (stats.newNormalized === 0) {
    console.warn(
      `[ipo:local] ⚠️ 本轮所有源均未产出窗口内条目（${crawlers.length} 个源全失败或全超窗）` +
        `${stats.prevUsed > 0 ? "；已保留上一版窗口内条目" : ""}`,
    );
  }

  if (args.dryRun) {
    console.log("[ipo:local] --dry-run：不写盘、不推送。");
    return stats.newNormalized === 0 && stats.total === 0 ? 1 : 0;
  }

  // ③ 写盘（原子写）
  writeLocalIpoFile(file, args.file);
  console.log(`[ipo:local] ✅ 已写入 ${args.file}`);

  // ④ 提交推送（文件无变化则跳过，避免空提交）
  if (!args.push) {
    console.log("[ipo:local] --no-push：跳过 git 提交推送。");
    return 0;
  }
  const branch = gitCapture(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch !== "main") {
    console.warn(`[ipo:local] ⚠️ 当前分支为 ${branch}（非 main），推送前请确认。`);
  }
  const dirty = gitCapture(["status", "--porcelain", "--", args.file]).trim();
  if (!dirty) {
    console.log("[ipo:local] 文件内容无变化 → 跳过提交推送。");
    return 0;
  }
  const others = gitCapture(["status", "--porcelain"])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.endsWith(args.file.replace(/^.*\//, "")));
  if (others.length > 0) {
    console.warn(
      `[ipo:local] ⚠️ 工作区还有 ${others.length} 处其它未提交改动（只提交本文件）：${others
        .slice(0, 3)
        .join(" / ")}`,
    );
  }
  git(["add", "--", args.file]);
  git([
    "commit",
    "-m",
    `chore(ipo): 本地专供源补数 data/local-ipo.json（${isoWithOffset(new Date()).slice(0, 10)}，${file.items.length} 条）`,
  ]);
  // 远端可能有 CI 的归档提交 → 先合并再推；冲突则中止并交回人工（绝不强推）。
  git(["fetch", "origin", "main"]);
  if (!git(["merge", "--no-edit", "origin/main"], true)) {
    git(["merge", "--abort"], true);
    console.error(
      "[ipo:local] ✗ 与 origin/main 合并冲突，已 abort。请手动处理后重跑（或 `git push origin main`）。",
    );
    return 1;
  }
  git(["push", "origin", "main"]);
  console.log("[ipo:local] ✅ 已推送 data/local-ipo.json 到 origin/main");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[ipo:local] ✗ ${(err as Error).message}`);
    process.exit(1);
  });
