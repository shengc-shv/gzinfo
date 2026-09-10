import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseSseListings,
  parseBseListings,
  parseSzseListings,
  parseListedDate,
  ListedChecker,
} from "../lib/sources/crawlers/sources/listed-check";

const CUTOFF = "2026-05-13"; // 约今天-120天

function sseJson(rows: unknown[]): string {
  return `cb(${JSON.stringify({ pageHelp: { total: rows.length, data: rows } })})`;
}
function bseJson(rows: unknown[]): string {
  return `cb(${JSON.stringify([{ listInfo: { totalElements: rows.length, content: rows } }])})`;
}
function szseJson(rows: unknown[]): string {
  return JSON.stringify([{ metadata: { pagecount: 1, recordcount: rows.length }, data: rows }]);
}

describe("parseListedDate", () => {
  test("YYYY-MM-DD 原样返回", () => assert.equal(parseListedDate("2019-07-22"), "2019-07-22"));
  test("带时分秒", () => assert.equal(parseListedDate("2026-08-15 00:00:00"), "2026-08-15"));
  test("8位 YYYYMMDD（上交所 LIST_DATE）", () => assert.equal(parseListedDate("20020409"), "2002-04-09"));
  test("空 → 空", () => assert.equal(parseListedDate(""), ""));
});

describe("parseSseListings（B1 上交所，含AREA）", () => {
  test("广东+近窗口 → 命中；非广东/超窗口 → 过滤", () => {
    const text = sseJson([
      { FULL_NAME: "广东某某科技股份有限公司", COMPANY_ABBR: "某某", A_STOCK_CODE: "688001", LIST_DATE: "2026-08-15 00:00:00", AREA_NAME_DESC: "广东省深圳市" },
      { FULL_NAME: "北京某科技", A_STOCK_CODE: "688002", LIST_DATE: "2026-08-16 00:00:00", AREA_NAME_DESC: "北京市" },
      { FULL_NAME: "广东老企业", A_STOCK_CODE: "688003", LIST_DATE: "2019-01-01", AREA_NAME_DESC: "广东省广州市" },
    ]);
    const ls = parseSseListings(text, CUTOFF).listings;
    assert.equal(ls.length, 1);
    assert.equal(ls[0].code, "688001");
    assert.equal(ls[0].exchange, "SSE");
    assert.equal(ls[0].listedDate, "2026-08-15");
  });
  test("非法 JSON → 空", () => assert.equal(parseSseListings("<html>", CUTOFF).listings.length, 0));
});

describe("parseBseListings（B3 北交所，issueResultDate）", () => {
  test("registerAddress 广东省 + issueResultDate → 命中", () => {
    const text = bseJson([
      { companyName: "广东北交所某股份有限公司", stockCode: "889001", registerAddress: "广东省 东莞市", issueResultDate: "2026-09-01" },
      { companyName: "浙江某", stockCode: "889002", registerAddress: "浙江省 杭州市", issueResultDate: "2026-09-02" },
    ]);
    const ls = parseBseListings(text, CUTOFF).listings;
    assert.equal(ls.length, 1);
    assert.equal(ls[0].code, "889001");
    assert.equal(ls[0].exchange, "BSE");
    assert.equal(ls[0].listedDate, "2026-09-01");
  });
});

describe("parseSzseListings（B2 深交所，无AREA）", () => {
  test("清洗 agjc HTML 标签；不过滤地区", () => {
    const text = szseJson([
      { agdm: "301001", agjc: "<span>广东创业某</span>", agssrq: "2026-07-20", bk: "创业板", sshymc: "专用设备" },
    ]);
    const ls = parseSzseListings(text, CUTOFF).listings;
    assert.equal(ls.length, 1);
    assert.equal(ls[0].code, "301001");
    assert.equal(ls[0].name, "广东创业某");
    assert.equal(ls[0].listedDate, "2026-07-20");
  });
});

// —— 集成：mock fetch，验证发现 + 复核升级 ——

/**
 * 动态上市日（相对今天）：合规窗口 2026-09-10 起由 120 天收窄为 **7 天**
 * （与底部「广东IPO动态」展示窗对齐，回检 P1-2），硬编码日期会随真实日期漂移失败。
 */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const SSE_LISTED = daysAgo(3);
const SZSE_LISTED = daysAgo(5);
const BSE_LISTED = daysAgo(2);

class MockChecker extends ListedChecker {
  async fetchSse(page: number): Promise<string> {
    if (page > 1) return sseJson([]);
    return sseJson([
      { FULL_NAME: "广东某某科技股份有限公司", COMPANY_ABBR: "某某", A_STOCK_CODE: "688001", LIST_DATE: `${SSE_LISTED} 00:00:00`, AREA_NAME_DESC: "广东省深圳市" },
    ]);
  }
  async fetchSzse(page: number): Promise<string> {
    if (page > 1) return szseJson([]);
    // 深交所无地区字段，仅用于代码匹配：提供一条广东创业某 301001 的近期上市
    return szseJson([{ agdm: "301001", agjc: "<span>广东创业某</span>", agssrq: SZSE_LISTED, bk: "创业板", sshymc: "专用设备" }]);
  }
  async fetchBse(page: number): Promise<string> {
    if (page > 1) return bseJson([]);
    return bseJson([
      { companyName: "广东北交所某股份有限公司", stockCode: "889001", registerAddress: "广东省 东莞市", issueResultDate: BSE_LISTED },
    ]);
  }
}

describe("ListedChecker.run（候选复核：发现 + 升级）", () => {
  test("发现广东近期上市 + 按代码复核升级候选", async () => {
    const checker = new MockChecker();
    // 今日候选：1) SSE 688001 已注册生效（无 listedDate） 2) SZSE 301001 过会候选
    const ipo = [
      { title: "某某：IPO注册生效（拟科创板）", sourceId: "gd-sse-audit", region: "gd", stockCode: "688001", ipoStage: "stage-registered" } as any,
      { title: "广东创业某：IPO过会（拟创业板）", sourceId: "gd-szse-audit", region: "gd", stockCode: "301001", ipoStage: "stage-registered" } as any,
    ];
    const discovered = await checker.run(ipo as any);
    // 发现：B1(688001 广东) + B3(889001 广东) = 2 条（SZSE 无地区不单独发现）
    assert.equal(discovered.length, 2);
    assert.ok(discovered.every((d) => d.ipoStage === "stage-listed"));
    // 复核升级：候选命中上市字典 → 补 listedDate（并升级为已上市）
    const sseHit = ipo[0];
    const szseHit = ipo[1];
    assert.equal(sseHit.listedDate, SSE_LISTED);
    assert.equal(szseHit.listedDate, SZSE_LISTED);
    assert.equal(szseHit.ipoStage, "stage-listed");
  });

  test("非广东候选不升级；超窗口不发现", async () => {
    const checker = new MockChecker();
    const ipo = [{ title: "北京某：IPO过会", region: "gd", stockCode: "688999", ipoStage: "stage-registered" } as any];
    const discovered = await checker.run(ipo as any);
    // 北京 688999 不在字典（字典只有广东代码）→ 不升级
    assert.equal(ipo[0].listedDate, undefined);
    // 发现仍来自字典中的广东条目（688001/889001）
    assert.equal(discovered.length, 2);
  });
});
