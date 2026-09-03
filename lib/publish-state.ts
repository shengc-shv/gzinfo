/**
 * 发布来源显式化（2026-09-03）。
 *
 * 背景：published-check 原先只查「gh-pages 当天目录是否存在」（HTTP 404 → 未发布）。
 * 这是弱信号 —— dispatch publish=true 的测试/覆盖与 schedule 正式首发在 gh-pages 上
 * 长得一模一样：凌晨 dispatch 测试抢占当天目录后，早上 schedule 看到 200 就误判
 * 「今天已发布」而跳过正式首发（漏洞 A/B/E：无来源、无优先级、存在性≠一致性）。
 *
 * 方案：main 分支维护 data/publish-state.json，显式记录每天**最后一次发布**的来源：
 *   - source=schedule → schedule 正式首发；published-check 只认它 → 当天后续 schedule 跳过
 *   - source=manual  → dispatch publish=true 的人工发布/覆盖；**不阻断同日 schedule 首发**
 *     （首次 schedule 命中会再发一次正式版覆盖测试版，today 落盘随之回到正式 run）
 *
 * 写入方：daily.yml 在 gh-pages publish **成功后** record（因果序：先发布成功，后记账）。
 * 读取方：daily.yml published-check（daily 之前，产出 should-publish / PUBLISH_RUN）。
 *
 * 记录为「最后一次发布」而非「当天首次」：同日多次发布自然覆盖（manual 覆盖 schedule
 * 后，次日已翻页无影响；schedule 覆盖 manual 是期望的「正式首发找回」）。
 */
export type PublishSource = "schedule" | "manual";

/** 一次 gh-pages 发布的留痕。 */
export interface PublishEntry {
  /** 发布来源：schedule 正式首发 / manual 人工覆盖。 */
  source: PublishSource;
  /** 发布 run id（与 gh-pages commit message 的 run id 同源，可审计）。 */
  runId: string;
  /** 发布成功时刻（ISO 8601 带时区）。 */
  publishedAt: string;
}

export interface PublishState {
  version: 1;
  updatedAt: string;
  /** key = 报告日期 YYYY-MM-DD。 */
  reports: Record<string, PublishEntry>;
}

export function emptyPublishState(): PublishState {
  return { version: 1, updatedAt: "", reports: {} };
}

/** 记录一次发布（同日覆盖，跨日新增）。 */
export function recordPublish(
  state: PublishState,
  date: string,
  entry: PublishEntry
): PublishState {
  return {
    ...state,
    updatedAt: date,
    reports: { ...state.reports, [date]: entry },
  };
}

/**
 * 当天是否已有 schedule 正式首发（published-check 唯一判据）。
 *
 * 只认 source=schedule：manual 覆盖（含凌晨测试抢占 gh-pages）不构成「已正式首发」，
 * 首次 schedule 命中仍会发布正式版。undefined/null state（文件缺失/损坏容错）→ false
 * （视为未发布，宁重复发布一次同源报告，不吞掉正式首发）。
 */
export function isSchedulePublishedOn(
  state: PublishState | undefined | null,
  date: string
): boolean {
  const e = state && state.reports && state.reports[date];
  return !!e && e.source === "schedule";
}

/**
 * 裁剪历史记录：仅保留最近 keepDays 个日期条目（同日覆盖 → 每天最多 1 条，
 * 按条数剪即按天数剪，避免时区换算）。防止 publish-state.json 无限增长。
 */
export function prunePublishState(
  state: PublishState,
  keepDays: number,
  today: string
): PublishState {
  const dates = Object.keys(state.reports).sort().reverse();
  const keep = new Set(dates.slice(0, Math.max(1, keepDays)));
  return {
    ...state,
    updatedAt: today,
    reports: Object.fromEntries(
      Object.entries(state.reports).filter(([d]) => keep.has(d))
    ),
  };
}
