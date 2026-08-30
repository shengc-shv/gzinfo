import { test } from "node:test";
import assert from "node:assert/strict";
import { sameEvent } from "../lib/ingest/dedup-similar";
import { dedupeExecAgainstSections } from "../lib/output/dedupe-sections";
import { computeMarketStatus } from "../lib/pipeline/side-outputs/stock-recap";
import type { DailyReport, ReportItem } from "../lib/types";

/** 构造一条资讯板块条目 */
function mk(title_cn: string, url = `https://example.com/${encodeURIComponent(title_cn)}`): ReportItem {
  return {
    url,
    title_cn,
    source: "测试源",
    source_type: "media",
    date: "08-30",
    summary: "",
    importance: 2,
    rank: 0,
    tags: [],
    locale: "national",
  };
}

test("sameEvent: 住房贷款 vs 房贷 同义词归一后判为同一事件(房贷40年)", () => {
  // 修复前：两条仅共享 #40年（1 个）→ false → policy_market 板块内 2 条房贷40年未合并
  assert.equal(
    sameEvent(
      "个人房贷最长期限从30年延长到40年，银行会怎样跟进？",
      "两部门：个人住房贷款期限延至最长40年",
    ),
    true,
  );
  // 公积金同义词归一
  assert.equal(
    sameEvent("9月1日起广州住房公积金缴存基数下限将调整", "广州调整住房公积金最低缴存基数"),
    true,
  );
});

test("dedupeExecAgainstSections: 必读头条命中的事件，资讯板块不再重复展开", () => {
  const report: DailyReport = {
    date: "2026-08-30",
    hero_line: "楼市全链条改革叠加房贷40年新政落地",
    must_read: [{ title: "房贷最长40年新政", why: "按揭期限延长直接拉低月供", url: "https://x/40y" }],
    insights: [],
    sections: {
      policy_market: [
        mk("两部门：个人住房贷款期限延至最长40年"), // 与必读同事件 → 应被移除
        mk("密集上新 多城优化调整住房公积金政策"), // 不同事件 → 保留
        mk("三部门完善商品房销售制度 实现“所见即所得”"), // 不同事件 → 保留
      ],
      gz_local: [mk("9月1日起广州住房公积金缴存基数下限将调整")],
      biz_insight: [],
      tech: [],
      ipo: [],
    },
  };
  const out = dedupeExecAgainstSections(report);
  const titles = out.sections.policy_market.map((i) => i.title_cn);
  assert.ok(!titles.includes("两部门：个人住房贷款期限延至最长40年"), "policy_market 应移除与必读同事件的房贷40年条目");
  assert.equal(out.sections.policy_market.length, 2, "其余 2 条应保留");
  // 不动 insights（商机与政策是互补视角）
  assert.equal(out.sections.gz_local.length, 1, "gz_local 不受必读去重影响（此处无同事件）");
  // 纯函数：原对象不被 mutate
  assert.equal(report.sections.policy_market.length, 3, "原 report 不应被修改");
});

test("computeMarketStatus: 周日报告标注上一交易日休市", () => {
  const r = computeMarketStatus("2026-08-30", "2026-08-28"); // 周日
  assert.equal(r.isMarketClosed, true);
  assert.equal(r.dataDate, "2026-08-28");
  assert.match(r.note, /上一交易日/);
  assert.match(r.note, /8月28日 周五/);
});

test("computeMarketStatus: 周一报告同样标注休市（早间市场未开）", () => {
  // 2026-08-31 是周一
  const r = computeMarketStatus("2026-08-31", "2026-08-28");
  assert.equal(r.isMarketClosed, true);
  assert.match(r.note, /上一交易日/);
});

test("computeMarketStatus: 交易日(周三)无休市提示", () => {
  const r = computeMarketStatus("2026-08-26", "2026-08-25"); // 周三
  assert.equal(r.isMarketClosed, false);
  assert.equal(r.note, "");
});
