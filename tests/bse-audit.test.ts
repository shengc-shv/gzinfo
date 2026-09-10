import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseBseDate,
  parseBseJson,
  isGdRow,
  bseApiUrl,
  MAX_PAGES,
  localDay,
  dayGap,
  BseAuditCrawler,
  BSE_STATUS,
  type BseRow,
} from "../lib/sources/crawlers/sources/bse-audit";

/** 构造一条 BSE 原始响应行。upd 可为 YYYY-MM-DD 字符串或 Date。 */
function bseRow(opts: {
  name: string;
  upd: string; // YYYY-MM-DD
  st: string; // P01~P10
  addr?: string;
  code?: string;
  sponsor?: string;
  id?: string;
}): Record<string, unknown> {
  const d = new Date(opts.upd + "T12:00:00+08:00");
  return {
    companyName: opts.name,
    stockName: opts.name.replace(/股份有限公司$/, ""),
    stockCode: opts.code,
    registerAddress: opts.addr ?? "广东省 东莞市",
    status: opts.st,
    updateDate: { time: d.getTime() },
    sponsorOrg: opts.sponsor,
    // 每行唯一 id：否则同批样本会因 URL(含 @状态) 去重被并成 1 条
    id: opts.id ?? `BID_${opts.name}`,
  };
}

/** 包成 BSE 的 JSONP 响应 cb1([{listInfo:{totalElements,content}}]) */
function bseJson(rows: Record<string, unknown>[]): string {
  return `cb1(${JSON.stringify([{ listInfo: { totalElements: rows.length, content: rows } }])})`;
}

function asRow(o: Record<string, unknown>): BseRow {
  return o as unknown as BseRow;
}

function dayOffset(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY = dayOffset(0);
/** 7 天展示窗之外（远早于窗口，规避周末回退造成的边界抖动）。 */
const WAY_BACK = dayOffset(-14);

describe("parseBseDate", () => {
  test("{time:毫秒} → YYYY-MM-DD", () => {
    assert.equal(parseBseDate({ time: new Date("2026-09-07T00:00:00Z").getTime() }), "2026-09-07");
  });
  test("空 → 空", () => {
    assert.equal(parseBseDate(""), "");
    assert.equal(parseBseDate(undefined), "");
  });
});

describe("parseBseJson", () => {
  test("剥离 JSONP 并提取 content[]", () => {
    const rows = parseBseJson(bseJson([bseRow({ name: "尚睿科技股份有限公司", upd: TODAY, st: "P02" })]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].companyName, "尚睿科技股份有限公司");
    assert.equal(rows[0].status, "P02");
  });
  test("非法 JSON 返回空", () => {
    assert.equal(parseBseJson("<html>error</html>").length, 0);
  });
});

describe("isGdRow", () => {
  test("registerAddress 前缀 广东省", () => {
    assert.equal(isGdRow(asRow(bseRow({ name: "尚睿科技", upd: TODAY, st: "P02", addr: "广东省 东莞市" }))), true);
  });
  test("非广东（浙江省）", () => {
    assert.equal(isGdRow(asRow(bseRow({ name: "杭州某科技", upd: TODAY, st: "P02", addr: "浙江省 杭州市" }))), false);
  });
});

// —— run 集成：mock warmCookie + fetchPage(page) ——
class MockCrawler extends BseAuditCrawler {
  private pages: string[];
  private idx = 0;
  constructor(pages: string[]) {
    super();
    this.pages = pages;
  }
  protected async warmCookie(): Promise<void> {
    /* 测试跳过网络 */
  }
  protected async fetchPage(_page: number): Promise<string> {
    if (this.idx >= this.pages.length) throw new Error("no more pages");
    return this.pages[this.idx++];
  }
}

describe("BseAuditCrawler.run (窗口内过滤 + 早停)", () => {
  test("首页：广东P02 1家 + 非广东 + 窗口外 + P08终止 → 仅收1条", async () => {
    const crawler = new MockCrawler([
      bseJson([
        bseRow({ name: "尚睿科技股份有限公司", upd: TODAY, st: "P02", code: "873xxx", sponsor: "中信建投" }),
        bseRow({ name: "杭州某科技", upd: TODAY, st: "P02", addr: "浙江省 杭州市" }),
        bseRow({ name: "广东旧企业", upd: WAY_BACK, st: "P02" }),
        bseRow({ name: "广东终止企业", upd: TODAY, st: "P08" }), // 终止 → drop
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 1);
    assert.equal(res[0].title, "尚睿科技：IPO问询中（拟北交所）");
    assert.equal(res[0].sourceId, "gd-bse-audit");
    assert.equal(res[0].region, "gd");
    assert.equal(res[0].ipoStage, "stage-reviewing");
    assert.equal(res[0].publishedAt, TODAY);
    assert.match(res[0].excerpt || "", /保荐：中信建投/);
  });

  test("P05 暂缓审议 → 阶段 stage-reviewing（不丢弃）", async () => {
    const c = new MockCrawler([bseJson([bseRow({ name: "广东某材料股份有限公司", upd: TODAY, st: "P05" })])]);
    const res = await c.run();
    assert.equal(res.length, 1);
    assert.equal(res[0].ipoStage, "stage-reviewing");
    assert.match(res[0].title || "", /IPO暂缓审议/);
  });

  test("P07 注册生效 → 阶段 stage-registered（注册发行，非已上市）", async () => {
    const c = new MockCrawler([bseJson([bseRow({ name: "广东某新材料股份有限公司", upd: TODAY, st: "P07" })])]);
    const res = await c.run();
    assert.equal(res.length, 1);
    // 2026-09-10 用户拍板：注册生效 = 待发行 → 归「注册发行」栏，真实挂牌日由 listed-check 补
    assert.equal(res[0].ipoStage, "stage-registered");
    assert.match(res[0].title || "", /IPO注册生效/);
  });

  test("窗口内最早=昨天 → 续抓第2页；第2页最早<窗口 → 停", async () => {
    const yest = dayOffset(-1);
    const c = new MockCrawler([
      bseJson([
        bseRow({ name: "广东A股份", upd: TODAY, st: "P02" }),
        bseRow({ name: "广东B股份", upd: yest, st: "P02" }),
      ]),
      bseJson([
        bseRow({ name: "广东C股份", upd: yest, st: "P02" }),
        bseRow({ name: "广东D股份", upd: WAY_BACK, st: "P02" }),
      ]),
    ]);
    const res = await c.run();
    assert.equal(res.length, 3); // A,B,C 窗口内；D 不收
  });
});

describe("BSE_STATUS 对齐规格字典（防状态码错位回归）", () => {
  test("P05~P10 标签与 drop 标记", () => {
    assert.equal(BSE_STATUS["P05"].label, "IPO暂缓审议");
    assert.equal(BSE_STATUS["P06"].label, "IPO提交注册");
    assert.equal(BSE_STATUS["P07"].label, "IPO注册生效");
    assert.equal(BSE_STATUS["P08"].label, "IPO不予注册");
    assert.equal(BSE_STATUS["P09"].label, "IPO中止");
    assert.equal(BSE_STATUS["P10"].label, "IPO终止");
    assert.equal(BSE_STATUS["P05"].drop, undefined); // 暂缓审议不丢弃
    assert.equal(BSE_STATUS["P08"].drop, true);
    assert.equal(BSE_STATUS["P09"].drop, true);
    assert.equal(BSE_STATUS["P10"].drop, true);
  });
});

describe("bseApiUrl（锁住 pageSize=1 这一'新鲜度开关'，高危回归）", () => {
  test("必须显式携带 pageSize=1（缺省/改值会静默命中陈旧分桶，最长滞后 13 天）", () => {
    const u = bseApiUrl(1);
    assert.match(u, /[?&]pageSize=1(&|$)/);
    assert.doesNotMatch(u, /pageSize=20/);
  });
  test("保留排序与 JSONP 回调参数（排序丢失会退回默认序，最新退到 2020）", () => {
    const u = bseApiUrl(3);
    assert.match(u, /[?&]page=3(&|$)/);
    assert.match(u, /[?&]callback=cb1(&|$)/);
    assert.match(u, /[?&]sortfield=updateDate(&|$)/);
    assert.match(u, /[?&]sorttype=desc(&|$)/);
  });
});

describe("MAX_PAGES（锁住翻页下限，防「4 页 = 4 条」式静默漏广东）", () => {
  test("必须足够覆盖 7 天窗内条目（pageSize=1 ⇒ 页数 == 条数）", () => {
    // 2026-09-10 实测：窗内 11 条，唯一广东条目（东莞四维材料）在第 8 页。
    // 下限取 12 = 实测窗内条数 + 1（下一页用于触发早停）。
    assert.ok(MAX_PAGES >= 12, `MAX_PAGES=${MAX_PAGES} 偏小，窗口内广东条目会被截断`);
  });
  test("保留安全阀上限，防官方分桶异常时翻页失控", () => {
    assert.ok(MAX_PAGES <= 30, `MAX_PAGES=${MAX_PAGES} 过大，异常时请求数会失控`);
  });
});

describe("localDay / dayGap（哨兵时区口径与 windowFloor 一致）", () => {
  test("localDay 本地日期串", () => {
    assert.equal(localDay(new Date(2026, 8, 10)), "2026-09-10");
  });
  test("dayGap 自然日差", () => {
    assert.equal(dayGap("2026-09-03", "2026-09-10"), 7);
    assert.equal(dayGap("2026-09-10", "2026-09-10"), 0);
    assert.equal(dayGap("2026-09-10", "2026-09-08"), -2);
  });
});

describe("新鲜度哨兵 warnIfStale（防分桶策略静默变化）", () => {
  /** 包住 console.warn 收集告警文本。 */
  function capture(fn: () => void): string[] {
    const logs: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    try {
      fn();
    } finally {
      console.warn = orig;
    }
    return logs;
  }

  test("数据为今天 → 不告警", () => {
    const c = new BseAuditCrawler();
    const logs = capture(() => c.warnIfStale([dayOffset(0)]));
    assert.equal(logs.length, 0);
  });
  test("滞后 3 天以内（阈值边界）→ 不告警", () => {
    const c = new BseAuditCrawler();
    const logs = capture(() => c.warnIfStale([dayOffset(-3)]));
    assert.equal(logs.length, 0);
  });
  test("滞后 4 天 → 告警且提示分桶策略", () => {
    const c = new BseAuditCrawler();
    const logs = capture(() => c.warnIfStale([dayOffset(-4), dayOffset(-6)]));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /新鲜度告警/);
    assert.match(logs[0], /pageSize 分桶/);
  });
  test("滞后判定取最新一条（非最旧）", () => {
    const c = new BseAuditCrawler();
    const logs = capture(() => c.warnIfStale([dayOffset(-30), dayOffset(-1)]));
    assert.equal(logs.length, 0);
  });
  test("0 条日期 → 告警（接口或分桶异常）", () => {
    const c = new BseAuditCrawler();
    const logs = capture(() => c.warnIfStale([]));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /0 条日期/);
  });
});

describe("run 去重（分桶策略变化致跨页重叠时不重复入库）", () => {
  test("两页返回同一条（同 code@status）→ 只收 1 条", async () => {
    const dup = bseRow({ name: "广东重复企业股份有限公司", upd: TODAY, st: "P02", code: "873999" });
    const c = new MockCrawler([bseJson([dup]), bseJson([dup])]);
    const res = await c.run();
    assert.equal(res.length, 1);
    assert.equal(res[0].title, "广东重复企业：IPO问询中（拟北交所）");
  });
});
