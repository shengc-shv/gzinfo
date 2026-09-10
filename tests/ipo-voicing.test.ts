import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGdIpoSpoken,
  pickGdIpoCompanies,
  companyNameOf,
} from "../lib/pipeline/side-outputs/gd-ipo";
import { recordIpoVoicing, ipoShouldSkip, emptyMemory } from "../lib/memory/event-memory";
import type { ReportItem } from "../lib/types";

/** 今天的 MM/DD：口播候选有「2 天窗」，硬编码日期会随真实日期漂移而失败。 */
function todayMmdd(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function item(title: string, opts: { tags?: string[]; summary?: string } = {}): ReportItem {
  return {
    url: "https://example.com/" + encodeURIComponent(title),
    title_cn: title,
    source: "test",
    source_type: "official",
    tier: "T1",
    date: todayMmdd(),
    summary: opts.summary ?? "",
    importance: 2,
    rank: 0,
    tags: opts.tags ?? ["粤"],
    locale: "national",
  } as ReportItem;
}

test("companyNameOf 去掉（拟XX）/[派出机构]等修饰", () => {
  assert.equal(companyNameOf("尚睿科技：IPO已受理（拟A股）"), "尚睿科技");
  assert.equal(companyNameOf("粤芯半导体（广州）[派出机构]：注册生效"), "粤芯半导体");
});

test("buildGdIpoSpoken 跳过 skipCompanies 中的企业", () => {
  const items = [
    item("尚睿科技：IPO已受理（拟A股）"),
    item("粤芯半导体：注册生效（拟科创板）"),
    item("格林美：IPO问询（拟创业板）"),
  ];
  const spoken = buildGdIpoSpoken(items, { skipCompanies: new Set(["尚睿科技"]) });
  assert.ok(spoken.includes("粤芯半导体"), "未被跳过企业应出现");
  assert.ok(!spoken.includes("尚睿科技"), "被跳过企业不应出现");
});

test("pickGdIpoCompanies 返回跳过后的前 2 家", () => {
  const items = [
    item("尚睿科技：IPO已受理（拟A股）"),
    item("粤芯半导体：注册生效（拟科创板）"),
    item("格林美：IPO问询（拟创业板）"),
  ];
  const picked = pickGdIpoCompanies(items, { skipCompanies: new Set(["尚睿科技"]) });
  assert.deepEqual(picked, ["粤芯半导体", "格林美"]);
});

test("ipoShouldSkip：窗口内口播满 2 天即跳过", () => {
  let mem = emptyMemory();
  mem = recordIpoVoicing(mem, ["尚睿科技"], "2026-09-09");
  mem = recordIpoVoicing(mem, ["尚睿科技"], "2026-09-10");
  // D3：最近 2 天内已口播 2 天 → 跳过
  assert.equal(ipoShouldSkip(mem, "尚睿科技", "2026-09-11"), true);
  // 另一企业从未口播 → 不跳过
  assert.equal(ipoShouldSkip(mem, "粤芯半导体", "2026-09-11"), false);
});

test("ipoShouldSkip：仅口播 1 天不跳过（允许连续 2 天播报）", () => {
  let mem = emptyMemory();
  mem = recordIpoVoicing(mem, ["尚睿科技"], "2026-09-10");
  assert.equal(ipoShouldSkip(mem, "尚睿科技", "2026-09-11"), false);
});

test("recordIpoVoicing 超期日期被裁剪（>7 天）", () => {
  let mem = emptyMemory();
  mem = recordIpoVoicing(mem, ["尚睿科技"], "2026-09-01"); // 距 09-10 为 9 天 > 7
  const mem2 = recordIpoVoicing(mem, ["尚睿科技"], "2026-09-10");
  const dates = mem2.ipoVoicing?.["尚睿科技"] ?? [];
  assert.deepEqual(dates, ["2026-09-10"], "超期日期应被丢弃");
});
