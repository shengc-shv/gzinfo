/**
 * 记录一次 gh-pages 发布来源到 data/publish-state.json（2026-09-03）。
 *
 * 由 .github/workflows/daily.yml 在 publish 步骤**成功之后**调用：
 *   - source=schedule（schedule 正式首发）→ published-check 据此让当天后续 schedule 跳过
 *   - source=manual（dispatch publish=true 人工覆盖）→ 不阻断同日 schedule 首发
 *     （首次 schedule 命中会再发正式版覆盖测试版 —— 凌晨 dispatch 测试不再吞掉正式首发）
 *
 * 先发后记：gh-pages push 成功才记账，避免「记了没发」导致次日误判已发布。
 *
 * env：
 *   REPORT_TZ      可选 报告时区（默认 Asia/Shanghai，决定「今天」是哪一天）
 *   SOURCE         必填 schedule | manual（发布来源）
 *   GITHUB_RUN_ID  可选 发布 run id（溯源，与 gh-pages commit message 同源）
 *
 * 用法：npm run record-publish
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  emptyPublishState,
  prunePublishState,
  recordPublish,
  type PublishState,
} from "../lib/publish-state";
import { formatBroadcastAt, memoryTimeZone } from "../lib/memory/broadcast-time";

const STATE_FILE = path.join(__dirname, "..", "data", "publish-state.json");

function log(msg: string) {
  console.log(`[record-publish] ${msg}`);
}

function loadState(): PublishState {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      log("publish-state.json 不存在，按空库初始化");
      return emptyPublishState();
    }
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Partial<PublishState>;
    if (!raw || typeof raw !== "object" || !raw.reports || typeof raw.reports !== "object") {
      log(`publish-state.json 结构异常（reports 缺失）→ 按空库重建`);
      return emptyPublishState();
    }
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      reports: raw.reports as Record<string, PublishState["reports"][string]>,
    };
  } catch (err) {
    log(`读取失败（${(err as Error).message}）→ 按空库重建`);
    return emptyPublishState();
  }
}

function main(): void {
  const tz = process.env.REPORT_TZ || "Asia/Shanghai";
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const source = process.env.SOURCE as "schedule" | "manual" | undefined;
  if (source !== "schedule" && source !== "manual") {
    log(`SOURCE 缺失或非法（got: ${String(source)}）— 期望 schedule|manual，退出 1`);
    process.exit(1);
  }

  const publishedAt = formatBroadcastAt(new Date(), memoryTimeZone());
  const runId = process.env.GITHUB_RUN_ID || "";

  const state = loadState();
  const next = prunePublishState(
    recordPublish(state, dateStr, { source, runId, publishedAt }),
    7,
    dateStr
  );
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  log(
    `✅ 已记录发布来源：${dateStr} source=${source} @ ${publishedAt}${runId ? `（run ${runId}）` : ""}`
  );
  log(
    source === "schedule"
      ? "次日/后续 schedule 命中将据此跳过重复发布（manual 记录不阻断同日 schedule 首发）。"
      : "manual 记录不阻断同日 schedule 首发；首次 schedule 命中仍会发布正式版覆盖。"
  );
}

main();
