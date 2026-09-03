/**
 * 发布来源显式化（publish-state.json）纯函数测试（2026-09-03）。
 *
 * 背景：published-check 判据从「gh-pages 当天目录是否存在」改为「当天是否有
 * source=schedule 的正式首发」——manual（dispatch publish=true）覆盖 gh-pages
 * 不构成正式首发，不阻断同日 schedule 再发正式版（凌晨测试不再吞掉正式发布）。
 *
 * 纯函数测试：构造数据，不依赖 data/ 真实文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyPublishState,
  isSchedulePublishedOn,
  prunePublishState,
  recordPublish,
  type PublishState,
} from "../lib/publish-state";

function sampleState(): PublishState {
  return {
    version: 1,
    updatedAt: "2026-09-03",
    reports: {
      "2026-09-01": { source: "schedule", runId: "100", publishedAt: "2026-09-01T07:05:00+08:00" },
      "2026-09-02": { source: "manual", runId: "200", publishedAt: "2026-09-02T14:30:00+08:00" },
    },
  };
}

test("emptyPublishState：空库初始化", () => {
  const s = emptyPublishState();
  assert.equal(s.version, 1);
  assert.deepEqual(s.reports, {});
  assert.equal(s.updatedAt, "");
});

test("recordPublish：跨日新增、同日覆盖（最后一次发布为准）", () => {
  let s = emptyPublishState();
  s = recordPublish(s, "2026-09-03", { source: "manual", runId: "r1", publishedAt: "2026-09-03T00:30:00+08:00" });
  s = recordPublish(s, "2026-09-03", { source: "schedule", runId: "r2", publishedAt: "2026-09-03T07:07:00+08:00" }); // 同日覆盖
  s = recordPublish(s, "2026-09-04", { source: "schedule", runId: "r3", publishedAt: "2026-09-04T07:10:00+08:00" });
  assert.equal(Object.keys(s.reports).length, 2, "同日覆盖不新增，跨日才新增");
  assert.equal(s.reports["2026-09-03"].source, "schedule", "同日重复发布以最后一次为准");
  assert.equal(s.reports["2026-09-03"].runId, "r2");
  assert.equal(s.reports["2026-09-04"].runId, "r3");
});

test("isSchedulePublishedOn：只认 source=schedule 的正式首发", () => {
  const s = sampleState(); // 09-01=schedule、09-02=manual
  assert.equal(isSchedulePublishedOn(s, "2026-09-01"), true, "schedule 记录 → 已正式首发");
  assert.equal(isSchedulePublishedOn(s, "2026-09-02"), false, "manual 覆盖不构成正式首发");
  assert.equal(isSchedulePublishedOn(s, "2026-09-03"), false, "无记录 → 未首发");
});

test("isSchedulePublishedOn：容错——null / 结构缺失一律视为未发布", () => {
  assert.equal(isSchedulePublishedOn(undefined, "2026-09-03"), false);
  assert.equal(isSchedulePublishedOn(null, "2026-09-03"), false);
  // 损坏结构：reports 缺失
  assert.equal(isSchedulePublishedOn({ version: 1, updatedAt: "", reports: {} }, "2026-09-03"), false);
  // 记录存在但缺 source 字段（脏数据，模拟 JSON.parse 未经校验的原始值）
  const dirty = {
    version: 1,
    updatedAt: "",
    reports: { "2026-09-03": { runId: "x" } },
  } as unknown as PublishState;
  assert.equal(isSchedulePublishedOn(dirty, "2026-09-03"), false, "脏记录不算正式首发");
});

test("prunePublishState：仅保留最近 keepDays 个日期条目", () => {
  let s = emptyPublishState();
  for (let i = 1; i <= 10; i++) {
    const day = `2026-08-${String(i).padStart(2, "0")}`;
    s = recordPublish(s, day, { source: "schedule", runId: `r${i}`, publishedAt: `${day}T07:00:00+08:00` });
  }
  const pruned = prunePublishState(s, 7, "2026-09-01");
  const dates = Object.keys(pruned.reports).sort();
  assert.equal(dates.length, 7, "只保留最近 7 个日期");
  assert.equal(dates[0], "2026-08-04", "保留最旧边界");
  assert.equal(dates[dates.length - 1], "2026-08-10", "保留最新");
  assert.equal(pruned.updatedAt, "2026-09-01");
  assert.ok(!pruned.reports["2026-08-01"], "更早记录被裁剪");
});

test("prunePublishState：keepDays 至少保留 1 条（防御 0/负数）", () => {
  const s = sampleState();
  const pruned = prunePublishState(s, 0, "2026-09-03");
  assert.equal(Object.keys(pruned.reports).length, 1, "0 → 至少保留最新 1 条");
});
