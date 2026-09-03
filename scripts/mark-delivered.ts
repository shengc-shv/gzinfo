/**
 * 标记当日「人工确认交付」（2026-09-03）。
 *
 * 由 .github/workflows/notify.yml 在**微信推送成功**后调用：把 {date, pushedAt,
 * runId, reportRunId, reportSha} 追加进 data/event-memory.json 的 deliveries
 * （同日重复推送 → 覆盖 pushedAt）。
 *
 * deliveries 是内容记忆 beginDay 的结算闸门：只有被人工推送过的日期，其播报
 * 才会在跨天时结算进长期记忆（9:00 启发式已退役）。
 * ⚠️ 生效判据 = **触达即生效**：推送全量送达（目标 ≥1 且全成功）即视为正式
 * 交付——模板消息渠道无「客户已读」回执，已读不可观测（用户 2026-09-03 拍板）。
 *
 * 版本指纹（reportRunId / reportSha）：从 gh-pages 当天 html 的最新 commit
 * （daily publish 步骤的 commit message 含 `run <id>`）反查被推送版本对应的
 * 发布 run 与 commit sha，供次日结算前与 today.runId 对账（deliverySettlementGate）：
 * 反查失败 → 无指纹 → 照常记录交付（宁缺指纹不阻断交付），结算按信任交付走。
 *
 * env：
 *   REPORT_TZ 可选 报告时区（默认 Asia/Shanghai，决定「今天」是哪一天）
 *   GITHUB_RUN_ID 可选 触发推送的 run id（溯源）
 *   GITHUB_REPOSITORY 可选 owner/repo（反查 gh-pages；CI 自动注入）
 *   GH_TOKEN 可选 GitHub token（反查 gh-pages；notify.yml 注入 secrets.GITHUB_TOKEN）
 *
 * 用法：npm run mark-delivered
 */
import { loadEventMemory, saveEventMemory } from "../lib/memory/store";
import { appendDelivery } from "../lib/memory/event-memory";
import { formatBroadcastAt, memoryTimeZone } from "../lib/memory/broadcast-time";

function log(msg: string) {
  console.log(`[mark-delivered] ${msg}`);
}

/** 反查 gh-pages 当天 html 的最新 commit → 被推送版本的发布 run id + commit sha。 */
async function resolvePushedVersion(
  dateStr: string,
): Promise<{ reportRunId?: string; reportSha?: string }> {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !token) {
    log("⚠️ 无 GITHUB_REPOSITORY / GH_TOKEN，跳过版本反查（交付记录不带版本指纹）");
    return {};
  }
  try {
    const url = `https://api.github.com/repos/${repo}/commits?path=${dateStr}/${dateStr}.html&sha=gh-pages&per_page=1`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      log(`⚠️ 反查 gh-pages 发布版本失败（HTTP ${res.status}）——当天目录可能尚未发布或被清理，不带版本指纹`);
      return {};
    }
    const list = (await res.json()) as { sha?: string; commit?: { message?: string } }[];
    const top = list?.[0];
    if (!top?.sha) {
      log("⚠️ gh-pages 当天无 commit，不带版本指纹");
      return {};
    }
    // daily.yml publish 步骤 commit message 形如 'daily: report for <run_id>'
    const m = /run (\d+)/.exec(top.commit?.message ?? "");
    const reportRunId = m ? m[1] : undefined;
    log(
      reportRunId
        ? `🔎 反查成功：当天 gh-pages 由 run ${reportRunId} 发布（commit ${top.sha.slice(0, 7)}）`
        : `🔎 当天 gh-pages commit message 未含 run id（commit ${top.sha.slice(0, 7)}），仅记 sha`,
    );
    return {
      ...(reportRunId ? { reportRunId } : {}),
      reportSha: top.sha,
    };
  } catch (e) {
    log(`⚠️ 反查 gh-pages 发布版本异常：${e instanceof Error ? e.message : String(e)}（不带版本指纹，照常记录交付）`);
    return {};
  }
}

async function main(): Promise<void> {
  const tz = process.env.REPORT_TZ || "Asia/Shanghai";
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const pushedAt = formatBroadcastAt(new Date(), memoryTimeZone());
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const fp = await resolvePushedVersion(dateStr);
  const store = loadEventMemory();
  const next = appendDelivery(store, {
    date: dateStr,
    pushedAt,
    ...(runId ? { runId } : {}),
    ...(fp.reportRunId ? { reportRunId: fp.reportRunId } : {}),
    ...(fp.reportSha ? { reportSha: fp.reportSha } : {}),
  });
  saveEventMemory(next, { today: dateStr });
  log(
    `✅ 已记录交付：${dateStr} @ ${pushedAt}${runId ? `（notify run ${runId}）` : ""}` +
      (fp.reportRunId ? `｜被推送版本 = gh-pages run ${fp.reportRunId}` : "｜⚠️ 无发布 run 指纹"),
  );
  log(`明日 beginDay 将据此结算 ${dateStr} 的播报进长期记忆（无交付则不结算；版本指纹不一致也不结算）。`);
}

main().catch((e) => {
  console.error(`[mark-delivered] 失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
