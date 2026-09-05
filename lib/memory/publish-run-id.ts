/**
 * 从 gh-pages 发布 commit message 提取「发布 run id」。
 *
 * daily.yml 的 publish 步骤用 peaceiris/actions-gh-pages，commit message 形如：
 *   daily: report for <run_id> <源 commit sha>
 * （action 会在 commit_message 后自动追加源 commit 的 40 位 sha）。
 *
 * 2026-09-05 修复：原 mark-delivered.ts 用 /run (\d+)/ 匹配，而实际格式是
 * "report for <id>"（无 "run " 字样）→ 恒匹配失败 → reportRunId 恒缺失 →
 * 次日结算指纹对账（deliverySettlementGate）从未生效，一直静默走「信任交付」。
 * 本函数是提取 run id 的唯一入口，独立成纯函数并配测试，防止回归。
 */

const REPORT_RUN_ID_RE = /report for (\d+)/;

export function extractReportRunId(commitMessage: string | undefined | null): string | undefined {
  const m = REPORT_RUN_ID_RE.exec(commitMessage ?? "");
  return m ? m[1] : undefined;
}
