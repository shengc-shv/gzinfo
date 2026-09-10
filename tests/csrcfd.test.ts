import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCoachRows,
  extractDisclosureDate,
  isGuangdong,
  decidePage,
  CsrcCoachCrawler,
  type CoachRow,
} from "../lib/sources/crawlers/sources/csrcfd";

/** 构造一行辅导库 HTML（8 个 td + 行内 downloadPdf1 调用）。 */
function coachTr(opts: {
  company: string;
  dispatchOrg?: string;
  /** 披露日期 YYYY-MM-DD，用于拼 PDF 路径；空 = 无 PDF 路径（stale 场景） */
  disclosure?: string;
  recordDate?: string;
  status?: string;
  tutorOrg?: string;
}): string {
  const { company, dispatchOrg = "广东证监局", disclosure, recordDate = disclosure || "", status = "辅导备案", tutorOrg = "兴业证券" } = opts;
  const pdf = disclosure
    ? `<script>downloadPdf1('/mnt/storage/stock/pre_ipo/${disclosure.replace(/-/g, "/")}/x.pdf')</script>`
    : "";
  return `<tr><td>1</td><td>${company}</td><td>${tutorOrg}</td><td>${recordDate}</td><td>${status}</td><td>${dispatchOrg}</td><td>辅导备案报告</td><td>title${pdf}</td></tr>`;
}

function pageHtml(rows: string[]): string {
  return `<table class="m-table2"><tbody>${rows.join("")}</tbody></table>`;
}

// 相对今日的日期串
function dayOffset(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY = dayOffset(0);
const YESTERDAY = dayOffset(-1);
const BEFORE_YESTERDAY = dayOffset(-2);

describe("parseCoachRows", () => {
  test("解析 8 列表格", () => {
    const html = pageHtml([
      coachTr({ company: "广东东岛新能源股份有限公司", disclosure: TODAY }),
    ]);
    const rows = parseCoachRows(html);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].company, "广东东岛新能源股份有限公司");
    assert.equal(rows[0].tutorOrg, "兴业证券");
    assert.equal(rows[0].dispatchOrg, "广东证监局");
    assert.equal(rows[0].status, "辅导备案");
  });

  test("无表格返回空", () => {
    assert.equal(parseCoachRows("<div>no table</div>").length, 0);
  });
});

describe("extractDisclosureDate", () => {
  test("从 PDF 路径提取 YYYY-MM-DD", () => {
    const r: CoachRow = { company: "", tutorOrg: "", recordDate: "", status: "", dispatchOrg: "", reportType: "", reportTitle: "", pdfPath: "/mnt/storage/stock/pre_ipo/2026/8/28/x.pdf" };
    assert.equal(extractDisclosureDate(r), "2026-08-28");
  });
  test("无 PDF 路径返回 null", () => {
    const r: CoachRow = { company: "", tutorOrg: "", recordDate: "", status: "", dispatchOrg: "", reportType: "", reportTitle: "", pdfPath: "" };
    assert.equal(extractDisclosureDate(r), null);
  });
});

describe("isGuangdong", () => {
  test("派出机构=广东证监局", () => {
    assert.equal(isGuangdong({ dispatchOrg: "广东证监局" } as CoachRow), true);
  });
  test("派出机构=深圳证监局（单列归广东）", () => {
    assert.equal(isGuangdong({ dispatchOrg: "深圳证监局" } as CoachRow), true);
  });
  test("企业名含广东城市（广州）", () => {
    assert.equal(isGuangdong({ company: "广州某科技股份有限公司" } as CoachRow), true);
  });
  test("非广东（派出机构+无城市）", () => {
    assert.equal(isGuangdong({ dispatchOrg: "北京证监局", company: "北京某某" } as CoachRow), false);
  });
});

describe("decidePage", () => {
  const mk = (disclosure?: string): CoachRow => ({
    company: "x", tutorOrg: "", recordDate: "", status: "", dispatchOrg: "", reportType: "", reportTitle: "",
    pdfPath: disclosure ? `/pre_ipo/${disclosure.replace(/-/g, "/")}/x.pdf` : "",
  });

  test("页内最早 < 昨天 → 停止", () => {
    // 倒序：第一条最新、最后一条最早。最后一条早于昨天 → stop
    const rows = [mk(TODAY), mk(BEFORE_YESTERDAY)];
    assert.deepEqual(decidePage(rows, YESTERDAY), { stop: true, staleHit: false });
  });

  test("页内最早 = 昨天 → 继续（不停止）", () => {
    const rows = [mk(TODAY), mk(YESTERDAY)];
    assert.deepEqual(decidePage(rows, YESTERDAY), { stop: false, staleHit: false });
  });

  test("页内最早 = 今天 → 继续", () => {
    const rows = [mk(TODAY), mk(TODAY)];
    assert.deepEqual(decidePage(rows, YESTERDAY), { stop: false, staleHit: false });
  });

  test("全页无有效披露日期 → staleHit", () => {
    const rows = [mk(), mk()];
    assert.deepEqual(decidePage(rows, YESTERDAY), { stop: false, staleHit: true });
  });

  test("末几行无日期但前面有 → 取最后有效日期判定", () => {
    const rows = [mk(TODAY), mk(), mk(BEFORE_YESTERDAY)];
    assert.deepEqual(decidePage(rows, YESTERDAY), { stop: true, staleHit: false });
  });
});

// —— run 集成测试：用 mock fetchPage 验证倒序早停 + 广东过滤 + stale 兜底 ——
class MockCrawler extends CsrcCoachCrawler {
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

describe("run (倒序早停 + 广东过滤)", () => {
  test("页内最早=前天 → 只抓 1 页即停", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "广州A", disclosure: TODAY }),
        coachTr({ company: "深圳B", disclosure: YESTERDAY }),
        coachTr({ company: "东莞C", disclosure: BEFORE_YESTERDAY }), // 最早→触发早停
      ]),
    ]);
    const res = await crawler.run();
    // 全为广东企业，但早停只抓了 1 页（3 条）
    assert.equal(res.length, 3);
    assert.ok(res.every((r) => r.region === "gd"));
  });

  test("sourceId=gd-csrc-tutoring（IPO 体系重设计，弃用 em-ipo 防 render 白名单静默丢弃）", async () => {
    const crawler = new MockCrawler([
      pageHtml([coachTr({ company: "广州A", disclosure: TODAY })]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 1);
    assert.equal(res[0].sourceId, "gd-csrc-tutoring");
    assert.notEqual(res[0].sourceId, "em-ipo");
  });

  test("页内最早=昨天 → 续抓第 2 页（第2页含前天→停）", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "广州A", disclosure: TODAY }),
        coachTr({ company: "佛山B", disclosure: YESTERDAY }), // 页1最早=昨天→续抓
      ]),
      pageHtml([
        coachTr({ company: "珠海C", disclosure: YESTERDAY }),
        coachTr({ company: "中山D", disclosure: BEFORE_YESTERDAY }), // 页2最早=前天→停
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 4);
  });

  test("混合全国+广东 → 仅保留广东", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "北京X", dispatchOrg: "北京证监局", disclosure: TODAY }),
        coachTr({ company: "广州Y", disclosure: TODAY }),
        coachTr({ company: "上海Z", dispatchOrg: "上海证监局", disclosure: YESTERDAY }),
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 1);
    assert.match(res[0].title || "", /广州Y/);
  });

  test("连续 2 页无有效披露日期 → 兜底停止", async () => {
    const crawler = new MockCrawler([
      pageHtml([coachTr({ company: "广州A", recordDate: TODAY }), coachTr({ company: "深圳B", recordDate: TODAY })]), // 无 disclosure（staleHit）
      pageHtml([coachTr({ company: "东莞C", recordDate: TODAY }), coachTr({ company: "佛山D", recordDate: TODAY })]), // 无 disclosure → 第2页触发停
      pageHtml([coachTr({ company: "珠海E", disclosure: TODAY })]), // 不应被抓
    ]);
    const res = await crawler.run();
    // 仅前 2 页（4 条，全广东，recordDate 兜底 publishedAt），第 3 页未被抓
    assert.equal(res.length, 4);
  });

  test("时间真实性红线：无披露且无备案时间 → 废弃（不产出）", async () => {
    const crawler = new MockCrawler([
      pageHtml([coachTr({ company: "广州A", disclosure: "", recordDate: "" })]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 0);
  });
});
