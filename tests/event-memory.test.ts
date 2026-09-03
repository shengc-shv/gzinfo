/**
 * 内容记忆与去重（Content Memory）回归测试（2026-09-02）。
 *
 * 覆盖用户需求六要点：
 *  1. 事件级记忆（指纹 + 主题标签，非文本完全匹配；可持久化结构）
 *  2. 判定规则（新进展 progress vs 重复表述 duplicate 的量化区分）
 *  3. 冷却与衰减（重大政策冷却更长；高重要性可打破冷却）
 *  4. 角度轮换（必须重播时强制切换新切入角度）
 *  5. 板块差异化（四板块参数互不相同、行为互不相同）
 *  6. 兜底策略（候选全命中去重时板块不空）
 *
 * 另覆盖工程关键性质：同日多跑幂等（today 暂存区 + 跨天结算 beginDay）、
 * 持久化层 load/save/prune、LLM 记忆提示格式化。
 *
 * 2026-09-03 语义更新：跨天结算闸门从「9:00 启发式」改为「交付信号」——
 * beginDay 只在「昨天存在人工确认推送（deliveries）」时才结算昨天播报。
 * 结算类用例通过 appendDelivery 显式标记交付，不再依赖注入时刻。
 *
 * 纯函数测试：全部用构造数据，不依赖 data/ 真实历史库。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  emptyMemory,
  rememberBroadcast,
  beginDay,
  appendDelivery,
  deliverySettlementGate,
  evaluateCandidate,
  computeNovelty,
  effectiveCooldownDays,
  decayedThreshold,
  canBreakCooldown,
  nextAngle,
  findMatchingEvent,
  diffDays,
  pruneMemory,
  extractFacts,
  classifyKind,
  buildMemoryBrief,
  formatMemoryBrief,
  SECTION_POLICY,
  BASE_COOLDOWN_DAYS,
  MAX_COOLDOWN_DAYS,
  type EventMemoryStore,
  type EventRecord,
  type MemoryCandidate,
} from "../lib/memory/event-memory";
import { loadEventMemory, saveEventMemory, isEventMemoryEnabled } from "../lib/memory/store";
import { applyMemoryGuard, type GuardPoolItem } from "../lib/memory/exec-guard";
import { broadcastAtFromDateAndSeconds, memoryTimeZone } from "../lib/memory/broadcast-time";
import type { ExecutiveSummary, ExecInsight } from "../lib/ai/executive-summary";

/**
 * 固定时刻工具：构造「某天某时刻」的 ISO 时间戳。
 * 2026-09-03 起结算不再看时刻（交付信号驱动），这里仅用于给 broadcastAt
 * 填一个可读的确定性时间（溯源字段），并显式验证「9 点后的播报在已交付
 * 的前提下同样会被结算」。
 */
const atTime = (date: string, h = 7, mi = 30) =>
  broadcastAtFromDateAndSeconds(date, h * 3600 + mi * 60, memoryTimeZone());

/** 快捷：给 store 标记「date 当天已人工确认推送」（结算闸门所需交付信号）。 */
function markDelivered(store: EventMemoryStore, date: string, pushedHour = 8): EventMemoryStore {
  return appendDelivery(store, { date, pushedAt: atTime(date, pushedHour, 15) });
}

/** 手搓一条已入长期记忆的事件记录（跨天结算后形态）。 */
function mkRecord(partial: Partial<EventRecord> & { id: string }): EventRecord {
  return {
    topicTags: ["住房金融"],
    anchors: ["房贷", "#40年"],
    kind: "policy",
    firstBroadcastAt: "2026-08-25",
    lastBroadcastAt: "2026-08-25",
    broadcastCount: 1,
    sections: ["must_read"],
    anglesUsed: [],
    samples: [
      {
        date: "2026-08-25",
        section: "must_read",
        title: "住建部：住房贷款期限最长延至40年",
        text: "住建部：住房贷款期限最长延至40年",
        facts: ["#40年", "!出台", "@住建部"],
      },
    ],
    broadcastedTexts: ["住建部：住房贷款期限最长延至40年"],
    broadcastedFacts: ["#40年", "!出台", "@住建部"],
    peakScore: 92,
    ...partial,
  };
}

/** 把 store 塞进一条（或几条）已有事件（模拟「昨天播过」）。 */
function storeWith(records: EventRecord[]): EventMemoryStore {
  const events: Record<string, EventRecord> = {};
  for (const r of records) events[r.id] = r;
  return { version: 1, updatedAt: records[0]?.lastBroadcastAt ?? "2026-08-25", events };
}

const D = "2026-08-30"; // 判定日（距 mkRecord.lastBroadcastAt = 5 天）

// ===========================================================================
// 1) 事件级记忆：指纹匹配（非文本完全匹配）
// ===========================================================================

test("同事件不同措辞可通过锚点指纹匹配（房贷40年 vs 住房贷款…40年）", () => {
  const store = storeWith([mkRecord({ id: "e1" })]);
  const cand: MemoryCandidate = { title: "房贷期限从30年延长至40年新规落地", text: "多家银行开始执行" };
  const m = findMatchingEvent(cand, store);
  assert.ok(m, "应命中记忆库中的事件");
  assert.equal(m!.id, "e1");
  assert.ok(m!.similarity >= 0.5);
});

test("URL 精确命中 = 最强信号（同一篇文章再次被选中）", () => {
  const rec = mkRecord({
    id: "e1",
    samples: [
      {
        date: "2026-08-25",
        section: "must_read",
        title: "某条新闻",
        url: "https://example.com/a/123",
      },
    ],
  });
  const store = storeWith([rec]);
  const cand: MemoryCandidate = {
    title: "完全不同标题",
    text: "正文也完全不同",
    url: "https://example.com/a/123",
  };
  const m = findMatchingEvent(cand, store);
  assert.ok(m, "URL 命中应视为同一事件");
  assert.equal(m!.similarity, 1);
});

test("主题标签共享 ≥2 但硬信号缺失不误并（不同事件判 new）", () => {
  // 历史事件：住房金融 + 利率流动性两个宽泛主题
  const store = storeWith([
    mkRecord({ id: "e1", topicTags: ["住房金融", "利率流动性"] }),
  ]);
  // 候选标题/锚点都与历史完全不同（公积金、LPR、存款），仅共享 2 个宽泛主题标签：
  // 修复前会误判为同一事件（串味合并，把「公积金额度上调」并入「房贷40年」）；
  // 修复后必须判 new，避免不同事件被误并。
  const cand: MemoryCandidate = {
    title: "公积金贷款额度上调 LPR下调 存款利率下行",
    text: "公积金 存款 LPR",
  };
  const m = findMatchingEvent(cand, store);
  assert.equal(m, null, "仅共享宽泛标签、无硬信号支撑应判为新事件");
});

test("主题标签共享 ≥2 且硬信号达置信 → 软命中合并（同一主题不同切入）", () => {
  // 历史事件锚点含「房贷」「#40年」；候选与历史共享「房贷」锚点（hard 落入软命中区间），
  // 且共享 ≥2 主题标签 → 仍应合并（保留「同一主题不同切入」的软重复兜底）。
  // 对照：同一候选若历史只共享 1 个标签则不合并（见「主题标签共享 1 个不误报」），
  // 证明是「硬信号 + 标签」共同把相似度抬到合并阈，而非标签单独生效。
  const store = storeWith([mkRecord({ id: "e1", topicTags: ["住房金融", "利率流动性"] })]);
  const cand: MemoryCandidate = {
    title: "房贷期限调整 利率下行",
    text: "房贷期限调整 利率下行",
  };
  const m = findMatchingEvent(cand, store);
  assert.ok(m, "硬信号达置信 + 共享≥2标签应软命中同一主题");
  assert.equal(m!.id, "e1");
});

test("computeNovelty：历史无事实锚点时不给满分（封顶 0.5 防虚高）", () => {
  // 首播为纯政策表述（抽不出数字/机构/进展动词），broadcastedFacts 为空。
  const rec = mkRecord({
    id: "e1",
    broadcastedFacts: [],
    broadcastedTexts: ["住房金融政策备受关注"],
    samples: [{ date: "2026-08-25", section: "must_read", title: "住房金融政策备受关注", text: "住房金融政策备受关注", facts: [] }],
  });
  // 后续带事实报道：新增 1000万户 / 500亿元 等事实
  const cand: MemoryCandidate = {
    title: "住房金融政策备受关注 惠及1000万户 投入500亿元",
    text: "住房金融政策备受关注 惠及1000万户 投入500亿元",
  };
  const n = computeNovelty(cand, rec);
  assert.ok(n.newFacts.length > 0, "候选应抽到新事实");
  // 历史无事实基线 → 即便候选全为新事实，novelty 也不应被事实项拉满：
  // 修复后新事实占比封顶 0.5（事实项贡献 ≤0.225），novelty 应 < 0.5；
  // 若封顶失效（newFactRatio=1）则 fact 贡献 0.45、novelty 将 > 0.5。
  assert.ok(n.novelty < 0.5, `历史无基线时 novelty 应被封顶（<0.5），实际 ${n.novelty}`);
});

test("主题标签共享 1 个不误报（仅强信号不够时）", () => {
  const store = storeWith([mkRecord({ id: "e1", topicTags: ["住房金融", "利率流动性"] })]);
  // 只共享「住房金融」1 个标签，且标题/锚点无重叠 → 不匹配（新事件）
  const cand: MemoryCandidate = {
    title: "广州发布城中村改造实施方案",
    text: "广州 城中村 拆迁补偿",
  };
  const m = findMatchingEvent(cand, store);
  assert.equal(m, null);
});

test("peakScore：hero 播报跨天结算保留真实分行相关性分（非恒为 0）", () => {
  // 修复前：exec-guard 的 hero/risk 候选不带 score，rememberBroadcast 也不透传，
  // 跨天结算时 cand.score=undefined → peakScore 恒为 0，重大事件无法享受「≥60 双倍保留」。
  // 修复后：score 经 BroadcastSample 透传到 upsertEvent。
  const hero: MemoryCandidate = {
    title: "房贷期限最长延至40年",
    score: 95,
    override: true,
  };
  let s: EventMemoryStore = { version: 1, events: {}, today: { date: "2026-08-25", entries: [] } };
  s = rememberBroadcast(s, {
    cand: hero,
    section: "hero",
    date: "2026-08-25",
    novelty: 1,
    broadcastAt: atTime("2026-08-25"),
  });
  s = markDelivered(s, "2026-08-25"); // 昨天已人工推送 → 交付信号允许结算
  const settled = beginDay(s, "2026-08-26");
  const rec = Object.values(settled.events)[0];
  assert.ok(rec, "应结算出一条长期记忆");
  assert.equal(rec.peakScore, 95, "hero 播报的 peakScore 应透传为真实分行分（非恒为 0）");
});

test("无交付记录 → 昨天的播报不结算（宁漏勿误，次日允许重播）", () => {
  // 微信推送改手动后：当天从未被人工推送（或全是测试/验证 run）→ 无交付信号，
  // 即使播报发生在 9:00 前也不结算 —— 9 点启发式退役，时刻不再决定是否正式。
  const hero: MemoryCandidate = { title: "房贷期限最长延至40年", score: 95, override: true };
  let s: EventMemoryStore = { version: 1, events: {}, today: { date: "2026-08-25", entries: [] } };
  s = rememberBroadcast(s, {
    cand: hero,
    section: "hero",
    date: "2026-08-25",
    novelty: 1,
    broadcastAt: atTime("2026-08-25", 7, 0), // 9 点前播的，但没有交付 → 仍不结算
  });
  const settled = beginDay(s, "2026-08-26");
  assert.equal(Object.keys(settled.events ?? {}).length, 0, "无交付信号 → 不结算");
});

test("9 点后的人工补发：有交付信号同样结算（时刻不再判定正式性）", () => {
  // 用户 9:30 手动强制重发（dispatch publish=true）并核对后手动推微信 → 真交付。
  const cand: MemoryCandidate = { title: "40年房贷新政重发版", text: "落地 实施" };
  let s: EventMemoryStore = { version: 1, events: {}, today: { date: "2026-09-02", entries: [] } };
  s = rememberBroadcast(s, {
    cand,
    section: "must_read",
    date: "2026-09-02",
    novelty: 0.9,
    broadcastAt: atTime("2026-09-02", 9, 45), // 9 点后播报
  });
  s = markDelivered(s, "2026-09-02", 10); // 10:15 人工推送成功
  const settled = beginDay(s, "2026-09-03");
  assert.equal(Object.keys(settled.events ?? {}).length, 1, "9 点后播报 + 已交付 → 应结算");
});

test("appendDelivery：同日重复推送覆盖 pushedAt，跨日追加新记录", () => {
  let s = emptyMemory();
  s = appendDelivery(s, { date: "2026-09-02", pushedAt: "2026-09-02T08:15:00+08:00" });
  s = appendDelivery(s, { date: "2026-09-02", pushedAt: "2026-09-02T10:20:00+08:00" }); // 同日覆盖
  s = appendDelivery(s, { date: "2026-09-03", pushedAt: "2026-09-03T08:02:00+08:00", runId: "r1" });
  assert.equal(s.deliveries?.length, 2, "同日前覆盖不新增，跨日才新增");
  const d02 = s.deliveries?.find((d) => d.date === "2026-09-02");
  assert.equal(d02?.pushedAt, "2026-09-02T10:20:00+08:00", "同日重复推送以最后一次为准");
  assert.equal(s.deliveries?.find((d) => d.date === "2026-09-03")?.runId, "r1");
});

test("结算指纹校验：交付版本 run == 落盘版本 run → 正常结算", () => {
  // 正常流程：schedule run 123 发布 + 落盘 today（runId=123）→ 人工推送时 gh-pages
  // 就是 run 123 的产物 → mark-delivered 反查到 reportRunId=123 → 次日结算无阻。
  let s: EventMemoryStore = {
    version: 1,
    events: {},
    today: { date: "2026-09-02", entries: [], runId: "123" },
    deliveries: [{ date: "2026-09-02", pushedAt: "2026-09-02T08:15:00+08:00", reportRunId: "123", reportSha: "abc123" }],
  };
  s = rememberBroadcast(s, {
    cand: { title: "房贷期限最长延至40年" },
    section: "hero",
    date: "2026-09-02",
    novelty: 0.9,
    broadcastAt: atTime("2026-09-02"),
  });
  const gate = deliverySettlementGate(s, "2026-09-02");
  assert.deepEqual(gate, { settle: true, reason: "delivered" });
  const settled = beginDay(s, "2026-09-03");
  assert.equal(Object.keys(settled.events ?? {}).length, 1, "指纹一致 → 应结算");
});

test("结算指纹校验：交付版本 run ≠ 落盘版本 run → 不结算（宁漏勿误）", () => {
  // 漏洞 D 场景：schedule run 123 发布落盘后，dispatch publish=true run 456 覆盖了
  // gh-pages 但落盘未跟随（或反之）→ 人工推送的是 run 456 产物，today 暂存却是
  // run 123 → 结算会把「没推送的版本」当已播 → 必须拦截。
  let s: EventMemoryStore = {
    version: 1,
    events: {},
    today: { date: "2026-09-02", entries: [], runId: "123" },
    deliveries: [{ date: "2026-09-02", pushedAt: "2026-09-02T10:20:00+08:00", reportRunId: "456", reportSha: "def456" }],
  };
  s = rememberBroadcast(s, {
    cand: { title: "房贷期限最长延至40年" },
    section: "hero",
    date: "2026-09-02",
    novelty: 0.9,
    broadcastAt: atTime("2026-09-02"),
  });
  const gate = deliverySettlementGate(s, "2026-09-02");
  assert.equal(gate.settle, false);
  assert.equal(gate.reason, "fingerprint-mismatch");
  const settled = beginDay(s, "2026-09-03");
  assert.equal(Object.keys(settled.events ?? {}).length, 0, "指纹不一致 → 不结算（次日允许重播）");
});

test("结算指纹校验：任一侧缺指纹（旧记录/反查失败）→ 按信任交付结算", () => {
  // deliveries 无 reportRunId（mark-delivered 反查失败 / 升级前记录）或 today 无 runId
  // （旧文件）→ 无法证伪不一致，与既有「有交付即结算」行为保持一致。
  let s: EventMemoryStore = {
    version: 1,
    events: {},
    today: { date: "2026-09-02", entries: [], runId: "123" },
    deliveries: [{ date: "2026-09-02", pushedAt: "2026-09-02T08:15:00+08:00" }], // 无指纹
  };
  s = rememberBroadcast(s, {
    cand: { title: "房贷期限最长延至40年" },
    section: "hero",
    date: "2026-09-02",
    novelty: 0.9,
    broadcastAt: atTime("2026-09-02"),
  });
  assert.equal(deliverySettlementGate(s, "2026-09-02").reason, "delivered");
  const settled = beginDay(s, "2026-09-03");
  assert.equal(Object.keys(settled.events ?? {}).length, 1, "无指纹 → 信任交付结算");
});

test("无关事件不误匹配（新事件 verdict=new）", () => {
  const store = storeWith([mkRecord({ id: "e1" })]);
  const cand: MemoryCandidate = { title: "美联储加息75个基点", text: "美股收跌" };
  const d = evaluateCandidate({ cand, section: "must_read", today: D, store });
  assert.equal(d.verdict, "new");
  assert.equal(d.allow, true);
});

// ===========================================================================
// 2) 判定规则：信息增量的量化区分
// ===========================================================================

test("无增量重复表述 → duplicate（不因措辞略变就放行）", () => {
  const rec = mkRecord({ id: "e1" });
  // 与已播内容几乎一致的「新」报道
  const cand: MemoryCandidate = {
    title: "住建部表示住房贷款期限最长延至40年",
    text: "住建部：住房贷款期限最长延至40年",
  };
  const n = computeNovelty(cand, rec);
  assert.ok(n.novelty < 0.15, `纯重复 novelty 应 < 0.15，实际 ${n.novelty}`);
  assert.equal(n.newFacts.length, 0, "无新事实");
  const d = evaluateCandidate({ cand, section: "must_read", today: D, store: storeWith([rec]) });
  assert.equal(d.verdict, "duplicate");
  assert.equal(d.allow, false);
});

test("有新事实/阶段推进 → progress（放行）", () => {
  const rec = mkRecord({ id: "e1" });
  // 新进展：出现「首批落地 30 城 + 执行利率 3.1%」等新数字新阶段
  const cand: MemoryCandidate = {
    title: "房贷40年新政首批落地：30城开始执行",
    text: "30城开始执行 执行利率3.1% 正式实施",
  };
  const n = computeNovelty(cand, rec);
  assert.ok(n.newFacts.length > 0, "应识别出新事实");
  assert.ok(n.novelty >= 0.35, `新进展 novelty 应 ≥ 0.35，实际 ${n.novelty}`);
  const d = evaluateCandidate({ cand, section: "must_read", today: D, store: storeWith([rec]) });
  // 距上次 5 天 < 冷却（policy 6 天）→ 需打破冷却；novelty ≥0.35 但 < 0.45(noveltyToBreak)
  // 且候选无 override/tier → 冷却期内中等增量 → 期望 cooldown（非 duplicate、非放行）
  // 说明：本断言验证「量化区分」成立——同样的增量在冷却期内不能随便放行；
  // progress 放行的完整路径由下一组测试覆盖（冷却结束后）。
  assert.notEqual(d.verdict, "new");
  assert.ok(["cooldown", "progress"].includes(d.verdict), `verdict=${d.verdict}`);
});

test("冷却结束后有实质进展 → progress 放行", () => {
  const rec = mkRecord({ id: "e1", lastBroadcastAt: "2026-08-10" }); // 距 D=20 天 > 冷却
  const cand: MemoryCandidate = {
    title: "房贷40年新政落地满月：30城执行利率3.1%",
    text: "30城执行 利率3.1% 数据验证",
  };
  const d = evaluateCandidate({ cand, section: "must_read", today: D, store: storeWith([rec]) });
  assert.equal(d.verdict, "progress");
  assert.equal(d.allow, true);
  assert.ok(d.requiredAngle, "progress 也应给出建议角度");
});

// ===========================================================================
// 3) 冷却与衰减
// ===========================================================================

test("冷却期内无进展 → cooldown/duplicate 过滤；超过冷却后可 refresh", () => {
  const rec = mkRecord({ id: "e1", lastBroadcastAt: "2026-08-25" }); // 距 D = 5 天
  const cooldown = effectiveCooldownDays(rec, "must_read");
  assert.equal(cooldown, 6, "policy 6 天 × must_read scale 1.0 = 6");

  // 冷却期内（5 < 6）
  const inCand: MemoryCandidate = {
    title: "多家媒体报道房贷40年新政细则",
    text: "细则出台",
  };
  const inD = evaluateCandidate({ cand: inCand, section: "must_read", today: D, store: storeWith([rec]) });
  assert.ok(["cooldown", "duplicate"].includes(inD.verdict), `冷却内 verdict=${inD.verdict}`);
  assert.equal(inD.allow, false);

  // 冷却结束后（模拟 lastBroadcastAt=2026-08-15 → 15 天 > 6）
  const rec2 = mkRecord({ id: "e1", lastBroadcastAt: "2026-08-15" });
  const outD = evaluateCandidate({ cand: inCand, section: "must_read", today: D, store: storeWith([rec2]) });
  assert.equal(outD.verdict, "refresh", "冷却结束后增量有限 → 换角度重播");
  assert.equal(outD.allow, true);
  assert.ok(outD.requiredAngle, "refresh 必须带建议角度");
});

test("重大政策冷却更长；播报越多次冷却越长（上限 14 天）", () => {
  const rec = mkRecord({ id: "e1" });
  assert.ok(BASE_COOLDOWN_DAYS.policy >= BASE_COOLDOWN_DAYS.market, "政策类基础冷却 ≥ 市场类");
  const once = effectiveCooldownDays(rec, "must_read");
  const rec2 = mkRecord({ id: "e1", broadcastCount: 3, lastBroadcastAt: "2026-08-25" });
  const thrice = effectiveCooldownDays(rec2, "must_read");
  assert.ok(thrice > once, `播报 3 次后冷却应更长（${thrice} > ${once}）`);
  const rec9 = mkRecord({ id: "e1", broadcastCount: 9 });
  const capped = effectiveCooldownDays(rec9, "must_read");
  assert.ok(capped <= MAX_COOLDOWN_DAYS, "不超过 14 天上限");
});

test("门槛随时间衰减：冷却后越久越易放行，但不低于地板", () => {
  const p = SECTION_POLICY.must_read;
  const inC = decayedThreshold("must_read", 3, 6);
  const right = decayedThreshold("must_read", 6, 6);
  const long = decayedThreshold("must_read", 30, 6);
  assert.ok(inC > right, "冷却内门槛高于冷却结束");
  assert.ok(right > long, "时间越久门槛越低");
  assert.ok(long >= p.noveltyFloor, "不低于地板");
});

test("高重要性突发事件可打破冷却（override / 高分 / 风险新证据）", () => {
  // 单元：canBreakCooldown 判定门槛
  assert.equal(canBreakCooldown({ title: "x" }, "must_read", 0.3, 1), false, "普通候选不能打破");
  assert.equal(canBreakCooldown({ title: "x" }, "must_read", 0.2, 1), false, "增量太低（<0.25）不打破");
  assert.equal(
    canBreakCooldown({ title: "x", override: true }, "must_read", 0.3, 1),
    true,
    "命中评分器硬规则（override）可打破",
  );
  assert.equal(
    canBreakCooldown({ title: "x", score: 85, tier: "must_read" }, "must_read", 0.3, 1),
    true,
    "高分必读事件可打破",
  );
  assert.equal(canBreakCooldown({ title: "x" }, "risk", 0.3, 1), true, "风险板块出现新证据可打破");

  // 集成：冷却期内 override 候选 → progress + brokeCooldown 标记
  const rec = mkRecord({ id: "e1", lastBroadcastAt: "2026-08-25" }); // 冷却内
  const d = evaluateCandidate({
    cand: { title: "住建部：住房贷款期限最长延至40年 细则落地", text: "细则落地 8城实施", override: true, score: 95, tier: "must_read" },
    section: "must_read",
    today: D,
    store: storeWith([rec]),
  });
  assert.equal(d.verdict, "progress");
  assert.equal(d.brokeCooldown, true, "override 应标记打破冷却");
  assert.equal(d.allow, true);

  // 集成：风险板块出现新事实（历史无该处罚阶段）→ 打破冷却继续预警
  const recR = mkRecord({
    id: "r1",
    kind: "enforcement",
    sections: ["risk"],
    lastBroadcastAt: "2026-08-29", // 昨天刚预警过 → 今天处于冷却内
    topicTags: ["监管合规"],
    anchors: ["处罚", "违规", "理财"],
    broadcastedTexts: ["某银行理财违规被罚"],
    broadcastedFacts: ["!处罚"],
    samples: [
      { date: "2026-08-29", section: "risk", title: "某银行理财违规被罚", text: "某银行理财违规被罚", facts: ["!处罚"] },
    ],
  });
  const byRisk = evaluateCandidate({
    cand: { title: "某银行理财违规被罚", text: "被监管约谈 罚款 处罚升级", score: 90, tier: "must_read" },
    section: "risk",
    today: D,
    store: storeWith([recR]),
  });
  assert.equal(byRisk.verdict, "progress");
  assert.equal(byRisk.brokeCooldown, true, "风险板块新证据应打破冷却");
  assert.equal(byRisk.allow, true);
});

// ===========================================================================
// 4) 角度轮换
// ===========================================================================

test("角度按固定顺序轮换，未用过的优先，用尽后回到最早", () => {
  const rec = mkRecord({ id: "e1" });
  assert.equal(nextAngle(rec), "政策变化", "未用任何角度 → 第一个");
  const rec2 = mkRecord({ id: "e1", anglesUsed: ["政策变化"] });
  assert.equal(nextAngle(rec2), "市场反应");
  const rec3 = mkRecord({ id: "e1", anglesUsed: ["政策变化", "市场反应", "受影响人群", "数据验证", "同业动作", "客户行动"] });
  assert.equal(nextAngle(rec3), "政策变化", "全部用尽 → 回到最早");
});

test("refresh 判定必须携带 requiredAngle 且不同于已用角度", () => {
  const rec = mkRecord({ id: "e1", anglesUsed: ["政策变化"], lastBroadcastAt: "2026-08-15" });
  const cand: MemoryCandidate = { title: "房贷40年细则媒体综述", text: "细则 综述" };
  const d = evaluateCandidate({ cand, section: "must_read", today: D, store: storeWith([rec]) });
  assert.equal(d.verdict, "refresh");
  assert.ok(d.requiredAngle && d.requiredAngle !== "政策变化", "强制换到新角度");
});

// ===========================================================================
// 5) 板块差异化
// ===========================================================================

test("四板块策略参数互不相同且取向符合设计", () => {
  const keys = ["hero", "must_read", "insights", "risk"] as const;
  // 冷却缩放：risk 最宽容（最小），hero 最严格（最大）
  assert.ok(SECTION_POLICY.hero.cooldownScale > SECTION_POLICY.risk.cooldownScale);
  // 增量地板：hero 最严（最高），risk 最宽（最低）
  assert.ok(SECTION_POLICY.hero.noveltyFloor > SECTION_POLICY.risk.noveltyFloor);
  // 重复容忍度：risk 上限最高，hero 上限最低
  assert.ok(SECTION_POLICY.risk.maxRepeat > SECTION_POLICY.hero.maxRepeat);
  // hero 不接受「换角度重播」式刷新，其余板块接受
  assert.equal(SECTION_POLICY.hero.allowRefresh, false);
  assert.ok(SECTION_POLICY.must_read.allowRefresh && SECTION_POLICY.insights.allowRefresh);
  // 去重优先级数值互不相同
  const prios = keys.map((k) => SECTION_POLICY[k].dedupePriority);
  assert.equal(new Set(prios).size, 4, "去重优先级应互不相同");
});

test("同一天内跨板块共享同一事件不算重复计数（broadcastCount = 播报天数）", () => {
  // 同一天 hero + must_read + insights 都讲房贷40年 → 结算后 broadcastCount 应为 1
  let st = emptyMemory();
  const day = "2026-08-29";
  st = rememberBroadcast(st, {
    cand: { title: "房贷期限延长至40年" },
    section: "hero",
    date: day,
    novelty: 0.9,
    broadcastAt: atTime(day),
  });
  st = rememberBroadcast(st, {
    cand: { title: "住房贷款最长可贷40年" },
    section: "must_read",
    date: day,
    novelty: 0.5,
    broadcastAt: atTime(day),
  });
  st = rememberBroadcast(st, {
    cand: { title: "40年房贷新政解读" },
    section: "insights",
    date: day,
    novelty: 0.3,
    broadcastAt: atTime(day),
  });
  // 跨天结算（先标记 2026-08-29 已人工推送 → 交付信号放行结算）
  st = markDelivered(st, day);
  st = beginDay(st, "2026-08-30");
  const events = Object.values(st.events ?? {});
  assert.equal(events.length, 1, "同日三条应并入同一事件");
  assert.equal(events[0].broadcastCount, 1, "同一天多次呈现只算 1 次播报");
  assert.deepEqual([...events[0].sections].sort(), ["hero", "insights", "must_read"]);
});

test("hero 板块不允许 refresh（增量不足 → 宁可过滤也不换角度重播）", () => {
  const rec = mkRecord({ id: "e1", lastBroadcastAt: "2026-08-15" }); // 冷却已结束
  const cand: MemoryCandidate = { title: "房贷40年媒体综述", text: "综述" };
  const dHero = evaluateCandidate({ cand, section: "hero", today: D, store: storeWith([rec]) });
  assert.ok(!dHero.allow, "hero 不接受 refresh");
  const dMust = evaluateCandidate({ cand, section: "must_read", today: D, store: storeWith([rec]) });
  assert.ok(dMust.allow, "同候选在 must_read 可 refresh");
});

// ===========================================================================
// 6) 兜底策略（exec-guard 三级兜底）
// ===========================================================================

/** 构造一条命中「房贷40年」记忆的 exec。 */
function mkExec(overrides?: Partial<ExecutiveSummary>): ExecutiveSummary {
  return {
    hero_line: "房贷期限从30年延长至40年落地",
    spoken_hero: "今天房贷期限延长到40年的政策正式落地",
    must_read: [
      { title: "住建部：住房贷款期限最长延至40年", why: "购房门槛降低，利好按揭客群", url: "https://x.com/1" },
    ],
    insights: [
      { topic: "房贷40年新政下客户换房需求上升", impact: "对按揭业务有影响", action: "建议关注", tag: ["住房金融"], sources: [{ title: "s", url: "https://x.com/2" }] },
    ],
    risk: { topic: "房贷40年新政银行风控承压", evidence: "部分银行开始收紧", impact: "不良可能上升", action: "关注" },
    ...overrides,
  };
}

const POOL: GuardPoolItem[] = [
  { title: "央行下调LPR 25个基点", summary: "LPR下调 存款利率", url: "https://pool.com/lpr", category: "finance", subcategory: "macro" },
  { title: "广州发放数字人民币消费券", summary: "广州 消费券", url: "https://pool.com/gz", category: "gz", subcategory: "gz-local" },
];

test("exec 全命中去重记忆 → guard 后必读/商机仍非空（L1/L2 兜底）", () => {
  const rec = mkRecord({ id: "e1", lastBroadcastAt: "2026-08-29" }); // 昨天播过 → 今天全过滤
  const store = storeWith([rec]);
  const exec = mkExec();
  const out = applyMemoryGuard({ exec, store, today: D, pool: POOL });
  // 定调被去重后从池补位 → 非空
  assert.ok(out.exec.hero_line && out.exec.hero_line.length > 0, "定调不空");
  // 必读：原 1 条被过滤 → L1 释放或 L2 补位 → 达到 minKeep
  assert.ok(out.exec.must_read && out.exec.must_read.length >= SECTION_POLICY.must_read.minKeep, "必读达到 minKeep");
  // 商机同理
  assert.ok(out.exec.insights && out.exec.insights.length >= 1, "商机不空");
  // 日志留痕
  assert.ok(out.log.length > 0);
});

test("昨日已预警风险，今日纯重复无新证据 → risk 清空不重复预警", () => {
  const recR = mkRecord({
    id: "r1",
    kind: "enforcement",
    sections: ["risk"],
    lastBroadcastAt: "2026-08-29", // 昨天刚预警
    broadcastedTexts: ["某银行理财违规被罚 通报"],
    broadcastedFacts: ["!处罚", "!通报"],
    anchors: ["某银行", "理财", "违规"],
    samples: [
      { date: "2026-08-29", section: "risk", title: "某银行理财违规被罚", text: "某银行理财违规被罚 通报", facts: ["!处罚", "!通报"] },
    ],
  });
  const store = storeWith([recR]);
  const exec = mkExec({
    risk: { topic: "某银行理财违规被罚", evidence: "被处罚通报", impact: "合规风险", action: "关注" },
  });
  const out = applyMemoryGuard({ exec, store, today: D, pool: POOL });
  assert.equal(out.exec.risk, undefined, "昨日刚预警且今日无新证据 → 不重复预警");
  assert.ok(out.log.some((l) => l.includes("风险命中去重")), "日志应记录风险去重");
});

test("候选无任何新事件时 L3 保留原产出（宁可重复不留空）", () => {
  const rec = mkRecord({ id: "e1", lastBroadcastAt: "2026-08-29" });
  const store = storeWith([rec]);
  const exec = mkExec();
  const out = applyMemoryGuard({ exec, store, today: D, pool: [] }); // 无池可补位
  // 定调：池空 → 保留原定调
  assert.ok(out.exec.hero_line && out.exec.hero_line.length > 0);
  // 必读/商机：releaseToMin 释放被过滤项
  assert.ok(out.exec.must_read && out.exec.must_read.length >= 1);
  assert.ok(out.exec.insights && out.exec.insights.length >= 1);
});

test("全新事件不受影响（verdict=new 全放行）", () => {
  const store = emptyMemory();
  const exec = mkExec({
    hero_line: "央行下调LPR 25个基点",
    must_read: [{ title: "央行下调LPR", why: "利好信贷", url: "https://x.com/new" }],
  });
  const out = applyMemoryGuard({ exec, store, today: D, pool: POOL });
  assert.ok(out.exec.must_read!.some((m) => m.title.includes("LPR")), "新事件保留");
  const nv = out.log.filter((l) => l.includes("new") || l.includes("新事件"));
  assert.ok(nv.length > 0);
});

// ===========================================================================
// 幂等与生命周期
// ===========================================================================

test("同日两次运行幂等：beginDay 后判定输入一致，结果可复现", () => {
  // 第一次运行（当天）产生播报 → 存 today 暂存
  let st = emptyMemory();
  st = beginDay(st, "2026-08-30");
  st = rememberBroadcast(st, {
    cand: { title: "房贷40年新政", text: "落地 实施" },
    section: "hero",
    date: "2026-08-30",
    novelty: 0.9,
  });
  // 第二次运行（同一天）：beginDay 清空暂存区 → 记忆回到「空」
  const st2 = beginDay(st, "2026-08-30");
  assert.equal(Object.keys(st2.events ?? {}).length, 0, "同一天不结算进长期记忆");
  assert.deepEqual(st2.today?.entries, [], "当天暂存区被清空");
  // 判定结果：与第一次运行开始时一致（new）
  const d = evaluateCandidate({
    cand: { title: "房贷40年新政", text: "落地 实施" },
    section: "hero",
    today: "2026-08-30",
    store: st2,
  });
  assert.equal(d.verdict, "new", "同日重跑判定不受上一次影响");
});

test("跨天结算：昨天的播报进入长期记忆并开始生效冷却", () => {
  let st = emptyMemory();
  st = beginDay(st, "2026-08-29");
  st = rememberBroadcast(st, {
    cand: { title: "房贷期限延长至40年", text: "落地 实施" },
    section: "hero",
    date: "2026-08-29",
    novelty: 0.9,
    broadcastAt: atTime("2026-08-29"),
  });
  st = markDelivered(st, "2026-08-29"); // 昨天已人工推送 → 允许结算
  st = beginDay(st, "2026-08-30"); // 跨天 → 结算
  const events = Object.values(st.events ?? {});
  assert.equal(events.length, 1);
  assert.equal(events[0].lastBroadcastAt, "2026-08-29");
  assert.equal(events[0].broadcastCount, 1);
  // 第二天再来同事件 → 不再判 new
  const d = evaluateCandidate({
    cand: { title: "住房贷款期限延至40年", text: "落地" },
    section: "hero",
    today: "2026-08-30",
    store: st,
  });
  assert.notEqual(d.verdict, "new");
  assert.equal(d.allow, false, "连续两天同事件 → 被冷却挡住");
});

test("pruneMemory：过期事件淘汰、高重要事件双倍保留、总量封顶", () => {
  const recOld = mkRecord({ id: "old", lastBroadcastAt: "2026-06-01", peakScore: 30 });
  const recKeep = mkRecord({ id: "keep", lastBroadcastAt: "2026-08-25", peakScore: 92 });
  const recImpOld = mkRecord({ id: "imp", lastBroadcastAt: "2026-07-01", peakScore: 85 }); // 45 天前但高分
  const st = storeWith([recOld, recKeep, recImpOld]);
  const pruned = pruneMemory(st, "2026-08-30", { retainDays: 45, maxEvents: 100 });
  const ids = Object.keys(pruned.events ?? {});
  assert.ok(!ids.includes("old"), ">45 天且低分 → 淘汰");
  assert.ok(ids.includes("keep"), "近期播报保留");
  assert.ok(ids.includes("imp"), "高分事件保留 90 天");
});

// ===========================================================================
// 持久化层 & LLM 记忆提示
// ===========================================================================

test("load/save 落盘往返一致（含 today 暂存区）", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "evmem-"));
  try {
    const p = path.join(base, "data");
    fs.mkdirSync(p, { recursive: true });
    const t = { title: "房贷40年", date: "2026-08-30", section: "hero" as const };
    const st: EventMemoryStore = { version: 1, events: { e1: mkRecord({ id: "e1" }) } };
    st.today = { date: "2026-08-30", entries: [t] };
    saveEventMemory(st, { baseDir: base, today: "2026-08-30" });
    const back = loadEventMemory({ baseDir: base });
    assert.equal(Object.keys(back.events ?? {}).length, 1);
    assert.ok(back.today, "today 暂存区应保留");
    assert.equal(back.today!.entries[0].title, "房贷40年");
    // prune 在保存时执行：把事件改成超期 → 再存一次应被清掉
    const stale: EventMemoryStore = {
      version: 1,
      events: { e2: mkRecord({ id: "e2", lastBroadcastAt: "2026-01-01", peakScore: 10 }) },
    };
    saveEventMemory(stale, { baseDir: base, today: "2026-08-30" });
    const back2 = loadEventMemory({ baseDir: base });
    assert.equal(Object.keys(back2.events ?? {}).length, 0, "超期事件保存时被 prune");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("load 容错：损坏/缺失文件返回空库不抛错", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "evmem-bad-"));
  try {
    const p = path.join(base, "data");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "event-memory.json"), "{broken json", "utf8");
    const st = loadEventMemory({ baseDir: base });
    assert.deepEqual(st.events, {});
    // 缺失文件同样空库
    const base2 = fs.mkdtempSync(path.join(os.tmpdir(), "evmem-miss-"));
    const st2 = loadEventMemory({ baseDir: base2 });
    assert.deepEqual(st2.events, {});
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("buildMemoryBrief / formatMemoryBrief 提示语：只列近期事件 + 建议角度", () => {
  const rec = mkRecord({ id: "e1", lastBroadcastAt: "2026-08-25", anglesUsed: ["政策变化"] });
  const st = storeWith([rec]);
  const brief = buildMemoryBrief(st, "2026-08-30", { lookbackDays: 10, limit: 8 });
  assert.equal(brief.length, 1);
  assert.equal(brief[0].suggestedAngle, "市场反应", "已用政策变化 → 建议市场反应");
  const text = formatMemoryBrief(brief);
  assert.ok(text.includes("市场反应"), "提示语应包含建议角度");
  assert.ok(text.includes("5 天前播报过"));
  // 太久远的事件不进提示
  const far = mkRecord({ id: "e2", lastBroadcastAt: "2026-06-01", peakScore: 10 });
  const briefFar = buildMemoryBrief(storeWith([far]), "2026-08-30", { lookbackDays: 10, limit: 8 });
  assert.equal(briefFar.length, 0);
});

// ===========================================================================
// 辅助性质与开关
// ===========================================================================

test("isEventMemoryEnabled 默认开，EVENT_MEMORY=0 关", () => {
  delete process.env.EVENT_MEMORY;
  assert.equal(isEventMemoryEnabled(), true);
  process.env.EVENT_MEMORY = "0";
  assert.equal(isEventMemoryEnabled(), false);
  delete process.env.EVENT_MEMORY;
});

test("extractFacts 抓三类锚点（数字/阶段/主体）", () => {
  const f = extractFacts("央行下调LPR 40个基点，金融监管总局处罚某银行，广州落地实施");
  assert.ok(f.some((x) => x.startsWith("#")), "数字锚点");
  assert.ok(f.some((x) => x.startsWith("!")), "进展动词");
  assert.ok(f.some((x) => x.startsWith("@")), "主体机构");
});

test("classifyKind 区分政策/监管/IPO/本地/市场", () => {
  assert.equal(classifyKind("央行发布新规 试点 施行"), "policy");
  assert.equal(classifyKind("证监会处罚某券商 罚款"), "enforcement");
  assert.equal(classifyKind("某公司IPO过会 注册生效"), "ipo");
  assert.equal(classifyKind("广州南沙 大湾区"), "local");
  assert.equal(classifyKind("A股收评 上证指数涨"), "market");
  assert.equal(classifyKind("某公司发布年报"), "generic");
});

test("diffDays 纯字符串日期差（规避时区）", () => {
  assert.equal(diffDays("2026-08-30", "2026-08-30"), 0);
  assert.equal(diffDays("2026-08-29", "2026-08-30"), 1);
  assert.equal(diffDays("2026-08-30", "2026-08-29"), -1);
});
