/**
 * 补结算：把指定日期的「暂存区 (today)」口播结算进长期记忆 (events)。
 *
 * 用途（2026-09-10 复盘）：mark-delivered 在「次日跨天 + deliverySettlementGate
 * 指纹对账」旧链路下，因同日重推导致 run id 不一致而误杀已发微信内容，
 * 使 09-08~09-10 的口播从未进长期记忆。Fix A 已将结算前置到 mark-delivered
 * （推送成功即结算），本脚本用于**补算历史日期**——把当时残留的 today 暂存结算进 events。
 *
 * 幂等：该日期暂存为空或已结算 → 无操作直接退出。
 * 重复打标：同日重复调用 → deliveries.pushedAt 覆盖更新、events 内容去重合并（无重复）。
 *
 * 用法：npm run memory:settle 2026-09-09
 */
import { loadEventMemory, saveEventMemory } from "../lib/memory/store";
import { settleTodayIntoEvents } from "../lib/memory/event-memory";

function log(msg: string) {
  console.log(`[memory:settle] ${msg}`);
}

const date = process.argv[2];
if (!date) {
  console.error("用法: npm run memory:settle <YYYY-MM-DD>");
  process.exit(1);
}

const store = loadEventMemory();
if (!store.today || store.today.date !== date) {
  log(`⚠️ 暂存区当前日期 = ${store.today?.date ?? "∅"}，与目标 ${date} 不符 → 无内容可结算（该日期口播可能已丢失或已被结算）`);
  process.exit(0);
}
const staged = store.today.entries.length;
if (staged === 0) {
  log(`⚠️ ${date} 暂存区为空，未结算`);
  process.exit(0);
}
const next = settleTodayIntoEvents(store, date);
saveEventMemory(next, { today: date });
log(`✅ 已将 ${date} 的 ${staged} 条口播结算进长期记忆（events 现 ${Object.keys(next.events).length} 条；暂存区已清空）`);
