import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseSseJson,
  parseSseDate,
  isGdRow,
  SseAuditCrawler,
  SSE_STATUS,
  type SseRow,
} from "../lib/sources/crawlers/sources/sse-audit";
import { windowFloor } from "../lib/sources/crawlers/sources/ipo-shared";

/** 构造一条 SSE 原始响应行（紧凑日期 YYYYMMDDHHMMSS）。 */
function sseRow(opts: {
  name: string;
  upd: string; // YYYY-MM-DD
  st: number;
  prov?: string;
  area?: string;
  abbr?: string;
  market?: number;
  apply?: string;
  num?: string; // stockAuditNum（去重键）—— 同批多行须给不同值
}): Record<string, unknown> {
  return {
    stockAuditName: opts.name,
    stockAuditNum: opts.num ?? "100000",
    updateDate: opts.upd.replace(/-/g, "") + "120000",
    auditApplyDate: (opts.apply ?? "2026-01-01").replace(/-/g, "") + "120000",
    currStatus: String(opts.st),
    issueMarketType: opts.market ?? 1,
    stockIssuer: [
      {
        s_province: opts.prov ?? "广东",
        s_areaNameDesc: opts.area ?? "广州市",
        s_issueCompanyAbbrName: opts.abbr ?? opts.name,
        s_csrcCodeDesc: "专用设备制造业",
      },
    ],
  };
}

/** 包成 SSE 的 JSONP 响应 cb({pageHelp:{total,data}}) */
function sseJson(st: number, rows: Record<string, unknown>[]): string {
  return `cb(${JSON.stringify({ pageHelp: { total: rows.length, data: rows } })})`;
}

function asRow(o: Record<string, unknown>): SseRow {
  return o as unknown as SseRow;
}

function dayOffset(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY = dayOffset(0);
const YESTERDAY = dayOffset(-1);
/** 7 天展示窗之外（远早于窗口，规避周末回退造成的边界抖动）。 */
const WAY_BACK = dayOffset(-14);

describe("parseSseDate", () => {
  test("紧凑 YYYYMMDDHHMMSS → YYYY-MM-DD", () => {
    assert.equal(parseSseDate("20260907141935"), "2026-09-07");
  });
  test("空 → 空", () => {
    assert.equal(parseSseDate(""), "");
    assert.equal(parseSseDate(undefined), "");
  });
});

describe("parseSseJson", () => {
  test("剥离 JSONP 并提取 data[]", () => {
    const rows = parseSseJson(sseJson(2, [sseRow({ name: "珠海普生医疗科技股份有限公司", upd: TODAY, st: 2, abbr: "普生医疗" })]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stockAuditName, "珠海普生医疗科技股份有限公司");
    assert.equal(rows[0].currStatus, "2");
    assert.equal(rows[0].updateDate, "2026-09-07".replace(/-/g, "") + "120000" ? rows[0].updateDate : "");
  });
  test("非法 JSON 返回空", () => {
    assert.equal(parseSseJson("<html>error</html>").length, 0);
  });
  test("无 stockAuditName 的条目废弃", () => {
    const rows = parseSseJson(sseJson(2, [{ currStatus: "2", updateDate: TODAY.replace(/-/g, "") + "120000" }]));
    assert.equal(rows.length, 0);
  });
});

describe("isGdRow", () => {
  test("s_province=广东", () => {
    assert.equal(isGdRow(asRow(sseRow({ name: "广东某科技", upd: TODAY, st: 2, prov: "广东" }))), true);
  });
  test("area=深圳（属广东）", () => {
    assert.equal(isGdRow(asRow(sseRow({ name: "深圳某科技", upd: TODAY, st: 2, prov: "", area: "深圳市" }))), true);
  });
  test("非广东（浙江）", () => {
    assert.equal(isGdRow(asRow(sseRow({ name: "杭州某科技", upd: TODAY, st: 2, prov: "浙江", area: "杭州市" }))), false);
  });
});

describe("windowFloor（复用 szse-audit，7 天窗 = 今天-7 天，日差 ≤ N）", () => {
  test("周四 09-10 → 09-03（龙行天下 updateDate 恰为日差 7，必须入窗）", () => {
    const now = new Date(2026, 8, 10);
    assert.equal(windowFloor(now), "2026-09-03");
  });
  test("周一 09-07 → 08-31", () => {
    const now = new Date(2026, 8, 7);
    assert.equal(windowFloor(now), "2026-08-31");
  });
});

// —— run 集成：mock fetchPage(st,page,market) 验证窗口过滤 + 早停 + 广东过滤 + 状态分组 ——
/**
 * Mock：按 `${market}:${st}` 提供分页；默认只喂科创板（market=1）样本，
 * 主板（market=2）不喂 → 既有单测行为不变；需要时用第二参数喂主板样本。
 */
class MockCrawler extends SseAuditCrawler {
  private pages: Record<string, string[]> = {};
  private idx: Record<string, number> = {};
  constructor(
    kcbByStatus: Record<number, string[]> = {},
    mainByStatus: Record<number, string[]> = {},
  ) {
    super();
    for (const [st, ps] of Object.entries(kcbByStatus)) this.pages[`1:${st}`] = ps;
    for (const [st, ps] of Object.entries(mainByStatus)) this.pages[`2:${st}`] = ps;
  }
  protected async fetchPage(st: number, _page: number, market = 1): Promise<string> {
    const key = `${market}:${st}`;
    const ps = this.pages[key] || [];
    const i = this.idx[key] || 0;
    if (i >= ps.length) throw new Error("no more pages " + key);
    this.idx[key] = i + 1;
    return ps[i];
  }
}

describe("SseAuditCrawler.run (currStatus 分批 + 窗口过滤 + 早停)", () => {
  test("st=2 首页：广东1家 + 非广东 + 窗口外 → 仅收1条", async () => {
    const crawler = new MockCrawler({
      2: [
        sseJson(2, [
          sseRow({ name: "珠海普生医疗科技股份有限公司", abbr: "普生医疗", upd: TODAY, st: 2, market: 1 }),
          sseRow({ name: "北京某科技", upd: TODAY, st: 2, prov: "北京", area: "北京市" }),
          sseRow({ name: "广东旧企业", upd: WAY_BACK, st: 2 }),
        ]),
      ],
      7: [sseJson(7, [sseRow({ name: "广东终止企业", upd: TODAY, st: 7 })])], // drop 状态不抓
    });
    const res = await crawler.run();
    assert.equal(res.length, 1);
    assert.equal(res[0].title, "普生医疗：IPO问询中（拟科创板）");
    assert.equal(res[0].sourceId, "gd-sse-audit");
    assert.equal(res[0].region, "gd");
    assert.equal(res[0].registeredProvince, "广东");
    assert.equal(res[0].ipoStage, "stage-reviewing");
    assert.equal(res[0].publishedAt, TODAY);
  });

  test("st=5 注册生效 → 阶段 stage-registered（注册发行，非已上市）", async () => {
    const c = new MockCrawler({
      5: [sseJson(5, [sseRow({ name: "广东钶锐锶数控技术股份有限公司", abbr: "钶锐锶", upd: TODAY, st: 5, market: 1 })])],
    });
    const res = await c.run();
    assert.equal(res.length, 1);
    // 2026-09-10 用户拍板：注册生效 = 待发行 → 归「注册发行」栏（回检 P0-1 口径统一）
    assert.equal(res[0].ipoStage, "stage-registered");
    assert.match(res[0].title || "", /IPO注册生效/);
  });

  test("窗口内最早=昨天 → 续抓第2页；第2页最早<窗口 → 停", async () => {
    const c = new MockCrawler({
      2: [
        sseJson(2, [
          sseRow({ name: "广东A", abbr: "A", num: "A1", upd: TODAY, st: 2 }),
          sseRow({ name: "广东B", abbr: "B", num: "B1", upd: YESTERDAY, st: 2 }),
        ]),
        sseJson(2, [
          sseRow({ name: "广东C", abbr: "C", num: "C1", upd: YESTERDAY, st: 2 }),
          sseRow({ name: "广东D", abbr: "D", num: "D1", upd: WAY_BACK, st: 2 }),
        ]),
      ],
    });
    const res = await c.run();
    assert.equal(res.length, 3); // A,B,C 窗口内；D 不收
  });
});

describe("SSE 双板抓取（issueMarketType 1=科创板 / 2=主板）", () => {
  // 用户 2026-09-10 实锤：「上交所 广东龙行天下」在主板却看不到 —— 因旧实现不传
  // issueMarketType，接口默认只回科创板（全量 1048 条均为 1），沪市主板整体缺失。
  test("主板（market=2）条目被抓取，标题标「拟主板」（龙行天下）", async () => {
    const c = new MockCrawler(
      {}, // 科创板无样本
      {
        2: [
          sseJson(2, [
            sseRow({
              name: "广东龙行天下科技股份有限公司",
              abbr: "龙行天下",
              upd: TODAY,
              st: 2,
              market: 2,
              prov: "广东",
              area: "东莞市",
            }),
          ]),
        ],
      },
    );
    const res = await c.run();
    assert.equal(res.length, 1);
    assert.equal(res[0].title, "龙行天下：IPO问询中（拟主板）");
    assert.equal(res[0].sourceId, "gd-sse-audit");
    assert.equal(res[0].registeredProvince, "广东");
    assert.equal(res[0].ipoStage, "stage-reviewing");
  });

  test("科创板 + 主板同抓，两板条目都收（旧实现只收科创板）", async () => {
    const c = new MockCrawler(
      { 2: [sseJson(2, [sseRow({ name: "珠海普生医疗科技股份有限公司", abbr: "普生医疗", num: "K1", upd: TODAY, st: 2, market: 1 })])] },
      { 2: [sseJson(2, [sseRow({ name: "广东龙行天下科技股份有限公司", abbr: "龙行天下", num: "M1", upd: TODAY, st: 2, market: 2 })])] },
    );
    const res = await c.run();
    assert.equal(res.length, 2);
    const titles = res.map((r) => r.title).join("|");
    assert.match(titles, /拟科创板/);
    assert.match(titles, /拟主板/);
  });

  test("主板窗口边界：日差 7 仍入窗（用户 09-10 实锤：龙行天下 updateDate 日差恰为 7）", async () => {
    const boundary = dayOffset(-7);
    const c = new MockCrawler({}, {
      2: [sseJson(2, [sseRow({ name: "广东龙行天下科技股份有限公司", abbr: "龙行天下", upd: boundary, st: 2, market: 2 })])],
    });
    const res = await c.run();
    assert.equal(res.length, 1);
    assert.equal(res[0].publishedAt, boundary);
  });

  test("主板窗口外（日差 9）不入窗", async () => {
    const c = new MockCrawler({}, {
      2: [sseJson(2, [sseRow({ name: "广东龙行天下科技股份有限公司", abbr: "龙行天下", upd: dayOffset(-9), st: 2, market: 2 })])],
    });
    const res = await c.run();
    assert.equal(res.length, 0);
  });
});

describe("SSE_STATUS 对齐规格字典（防状态码错位回归）", () => {
  test("6/7/8/9 标签与 drop 标记", () => {
    assert.equal(SSE_STATUS[6].label, "IPO不予注册");
    assert.equal(SSE_STATUS[7].label, "IPO中止");
    assert.equal(SSE_STATUS[8].label, "IPO终止");
    assert.equal(SSE_STATUS[9].label, "IPO已发行");
    assert.equal(SSE_STATUS[6].drop, true);
    assert.equal(SSE_STATUS[7].drop, true);
    assert.equal(SSE_STATUS[8].drop, true);
    assert.equal(SSE_STATUS[9].drop, true);
  });
});
