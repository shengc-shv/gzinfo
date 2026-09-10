import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseSzseJson,
  isGdRow,
  SzseAuditCrawler,
  type SzseRow,
} from "../lib/sources/crawlers/sources/szse-audit";
// P2-3 收敛：windowFloor/shortName 已迁至 ipo-shared（不再挂在 szse-audit 上）。
import { windowFloor, shortName } from "../lib/sources/crawlers/sources/ipo-shared";

/** 构造一行 SZSE 响应记录（返回完整 SzseRow；直接传原始 Record 的由 apiJson 模拟接口）。 */
function row(opts: Partial<SzseRow> & { updtdt: string }): Record<string, unknown> {
  return {
    prjid: opts.prjid ?? 1,
    cmpnm: opts.cmpnm ?? "广东某科技股份有限公司",
    cmpsnm: opts.cmpsnm ?? "某科技",
    prjst: opts.prjst ?? "已问询",
    regloc: opts.regloc ?? "广东",
    sprinsts: opts.sprinsts ?? "中金公司",
    acptdt: opts.acptdt ?? "2026-01-01",
    updtdt: opts.updtdt,
    boardName: opts.boardName ?? "创业板",
  };
}

/** 转为 SzseRow（供 isGdRow 纯函数测试）。 */
function asRow(o: Record<string, unknown>): SzseRow {
  return o as unknown as SzseRow;
}

function apiJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify({ totalSize: rows.length, data: rows });
}

// 相对今日日期（Asia/Shanghai 近似，测试用本地时区足够）
function dayOffset(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY = dayOffset(0);
const YESTERDAY = dayOffset(-1);
/** 7 天展示窗之外（远早于窗口，规避周末回退造成的边界抖动）。 */
const WAY_BACK = dayOffset(-14);

describe("parseSzseJson", () => {
  test("解析 data[] 行字段", () => {
    const rows = parseSzseJson(
      apiJson([row({ updtdt: TODAY, cmpsnm: "博迈医疗", prjst: "已问询", sprinsts: "中金公司" })]),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cmpnm, "广东某科技股份有限公司");
    assert.equal(rows[0].cmpsnm, "博迈医疗");
    assert.equal(rows[0].prjst, "已问询");
    assert.equal(rows[0].updtdt, TODAY);
  });
  test("无 updtdt 的条目废弃（时间红线：不兜底抓取日）", () => {
    const rows = parseSzseJson(apiJson([row({ updtdt: "" }), row({ updtdt: TODAY })]));
    assert.equal(rows.length, 1);
  });
  test("非法 JSON 返回空", () => {
    assert.equal(parseSzseJson("<html>error</html>").length, 0);
  });
});

describe("isGdRow", () => {
  test("regloc=广东", () => {
    assert.equal(isGdRow(asRow(row({ updtdt: TODAY, regloc: "广东" }))), true);
  });
  test("regloc=深圳（省后缀去除后命中兜底城市）", () => {
    // 实测 regloc 只到省（"广东"），此处验证企业名兜底：regloc 为空但公司名含深圳
    assert.equal(isGdRow(asRow(row({ updtdt: TODAY, regloc: "", cmpnm: "深圳市某科技股份有限公司" }))), true);
  });
  test("非广东（浙江 + 无城市）", () => {
    assert.equal(isGdRow(asRow(row({ updtdt: TODAY, regloc: "浙江", cmpnm: "杭州某科技" }))), false);
  });
});

describe("windowFloor（7 天窗下界 = 今天-7 天，周末回退；口径=日差 ≤ N）", () => {
  test("周四 09-10 → 今天-7 = 09-03（周四）", () => {
    // 用户 09-10 实锤：上交所主板「广东龙行天下」updateDate=09-03（日差恰为 7）必须入窗
    const now = new Date(2026, 8, 10);
    assert.equal(windowFloor(now), "2026-09-03");
  });
  test("周三 09-09 → 今天-7 = 09-02（周三，不回退）", () => {
    const now = new Date(2026, 8, 9);
    assert.equal(windowFloor(now), "2026-09-02");
  });
  test("周一 09-07 → 今天-7 = 08-31（周一，不回退）", () => {
    const now = new Date(2026, 8, 7);
    assert.equal(windowFloor(now), "2026-08-31");
  });
  test("周日 09-13 → 09-06（周日）→ 回退 09-04（周五）", () => {
    const now = new Date(2026, 8, 13);
    assert.equal(windowFloor(now), "2026-09-04");
  });
  test("周六 09-12 → 09-05（周六）→ 回退 09-04（周五）", () => {
    const now = new Date(2026, 8, 12);
    assert.equal(windowFloor(now), "2026-09-04");
  });
  test("3 天前更新仍在窗内（用户 09-10 实锤：傲雷科技 09-07）", () => {
    const now = new Date(2026, 8, 10); // 周四
    assert.ok("2026-09-07" >= windowFloor(now), "3 天前应 ≥ 窗口下界");
  });
  test("日差恰为 7 的边界条目入窗（用户 09-10 实锤：龙行天下 09-03）", () => {
    const now = new Date(2026, 8, 10); // 周四
    assert.ok("2026-09-03" >= windowFloor(now), "日差 7 的边界条目应 ≥ 窗口下界");
  });
});

describe("shortName", () => {
  test("剥企业组织形式后缀", () => {
    assert.equal(shortName("广东博迈医疗科技股份有限公司"), "广东博迈医疗科技");
    assert.equal(shortName("博迈医疗"), "博迈医疗");
  });
});

// —— run 集成：mock fetchPage 验证窗口过滤 + 早停 + 广东过滤 ——
class MockCrawler extends SzseAuditCrawler {
  private pages: string[];
  private idx = 0;
  constructor(pages: string[]) {
    super();
    this.pages = pages;
  }
  protected async fetchPage(_p: number): Promise<string> {
    if (this.idx >= this.pages.length) throw new Error("no more pages");
    return this.pages[this.idx++];
  }
}

describe("SzseAuditCrawler.run (窗口内过滤 + 倒序早停)", () => {
  test("首页窗口内广东 1 家、最早旧于窗口 → 只抓 1 页且只收窗口内", async () => {
    const crawler = new MockCrawler([
      apiJson([
        row({ prjid: 1, cmpnm: "广东博迈医疗科技股份有限公司", cmpsnm: "博迈医疗", updtdt: TODAY, prjst: "注册生效" }),
        row({ prjid: 2, cmpnm: "北京某科技", regloc: "北京", updtdt: TODAY }), // 非广东
        row({ prjid: 3, cmpnm: "广东旧企业", updtdt: WAY_BACK }), // 窗口外（昨天之前）→ 不收
        row({ prjid: 4, cmpnm: "广东终止企业", updtdt: TODAY, prjst: "终止(撤回)" }), // 负面 → 不收
      ]),
      apiJson([row({ prjid: 5, updtdt: TODAY })]), // 不应被抓（早停）
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 1);
    assert.equal(res[0].title, "博迈医疗：IPO注册生效（拟创业板）");
    assert.equal(res[0].sourceId, "gd-szse-audit");
    assert.equal(res[0].region, "gd");
    assert.equal(res[0].registeredProvince, "广东");
    assert.equal(res[0].publishedAt, TODAY);
  });

  test("首页全部在窗口内（最早=昨天）→ 续抓第 2 页；第 2 页最早旧于窗口 → 停", async () => {
    const crawler = new MockCrawler([
      apiJson([
        row({ prjid: 1, updtdt: TODAY }),
        row({ prjid: 2, updtdt: YESTERDAY }), // 页1最早=昨天 → 续抓
      ]),
      apiJson([
        row({ prjid: 3, updtdt: YESTERDAY }),
        row({ prjid: 4, updtdt: WAY_BACK }), // 页2最早=前天 → 早停（但已在窗口内收集 3）
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 3); // 1,2,3 均在窗口内；4 不收
  });

  test("7 天窗：3 天前更新的广东企业仍进列表（原 1 天窗会丢，用户 09-10 实锤）", async () => {
    const mid = dayOffset(-3);
    const crawler = new MockCrawler([
      apiJson([
        row({ prjid: 1, cmpnm: "傲雷科技集团股份有限公司", cmpsnm: "傲雷科技", updtdt: mid, prjst: "已问询" }),
        row({ prjid: 2, cmpnm: "深圳智岩科技股份有限公司", cmpsnm: "智岩科技", updtdt: dayOffset(-12), prjst: "已问询" }), // 超 7 天窗 → 不收
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 1);
    assert.equal(res[0].title, "傲雷科技：IPO问询中（拟创业板）");
    assert.equal(res[0].publishedAt, mid);
  });

  test("title 状态词映射（上市委会议通过 → IPO过会）", async () => {
    const crawler = new MockCrawler([
      apiJson([row({ prjid: 1, cmpsnm: "佛山某", updtdt: TODAY, prjst: "上市委会议通过" })]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 1);
    assert.match(res[0].title || "", /IPO过会/);
  });
});
