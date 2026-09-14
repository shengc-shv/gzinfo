/**
 * 采集分类 → 渲染板块 的单一真源（2026-09-14 收敛，详见 docs/gzinfo-fix-list-2026-09-14.md P0-4）。
 *
 * 此前 lib/ai/pipeline.ts 与 lib/output/report-from-articles.ts 各有一份漂移的私有副本
 * （pipeline.ts 漏了 isGdIpoCandidate 分支，导致 SKIP_AI 下广东 IPO 媒体补位不进板块）。
 * 现统一在此，两处改为 import，杜绝再漂移。
 *
 * 无状态源架构红线（2026-08-29 用户）：板块归属一律由内容判定，采集分类只是元数据。
 * tech/ipo 是独立内容栏目按类别归栏；其余统一内容判定：
 *   广东企业 IPO 进展（名单+阶段词）→ ipo；广州锚+业务线 → gz_local；
 *   外地地名/政策动作/全国市场信号 → policy_market；否则 biz_insight。
 */
import type { ReportSectionKey } from "../types";
import {
  isGdIpoCandidate,
  isGzLocalCandidate,
  isPolicyMarketCandidate,
} from "../output/render/cards";

export function categoryToSection(cat?: string, title = "", excerpt = ""): ReportSectionKey {
  if (cat === "tech") return "tech";
  if (cat === "ipo" || cat === "gd-ipo") return "ipo";
  // 媒体源报道的广东企业 IPO 动态（注册生效/辅导备案/过会等，官方源漏抓时补位）→ 内容判定归 IPO
  if (isGdIpoCandidate(title, excerpt)) return "ipo";
  if (isGzLocalCandidate(title, excerpt)) return "gz_local";
  if (isPolicyMarketCandidate(title, excerpt)) return "policy_market";
  return "biz_insight";
}
