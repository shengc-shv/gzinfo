import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseHkDate,
  isGdHk,
  HkFilingCrawler,
  type HkApp,
} from "../lib/sources/crawlers/sources/hk-filing";

/** 构造一条 HKEX 处理中申请记录。 */
function app(opts: {
  id: number;
  d: string; // DD/MM/YYYY
  a: string; // 申请人（繁体）
  w?: string;
  ls?: Array<{ d: string; nF?: string; nS1?: string; u1?: string; u2?: string }>;
  postingDate?: string;
}): HkApp {
  return {
    id: opts.id,
    d: opts.d,
    a: opts.a,
    ...(opts.w ? { w: opts.w } : {}),
    ...(opts.ls ? { ls: opts.ls } : {}),
    ...(opts.postingDate ? { postingDate: opts.postingDate } : {}),
  };
}

/** 相对今日的 DD/MM/YYYY（hk-filing 的 `d` 字段格式）——窗口收窄到 7 天后，样本须落在窗内。 */
function hkDate(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/** Mock：仅主板返回样本，GEM 返回空，避免重复计数干扰断言。 */
class MockHkFiling extends HkFilingCrawler {
  sample: HkApp[];
  constructor(sample: HkApp[]) {
    super();
    this.sample = sample;
  }
  protected override async fetchApps(url: string): Promise<HkApp[]> {
    return url.includes("gem") ? [] : this.sample;
  }
}

describe("parseHkDate", () => {
  test("DD/MM/YYYY → YYYY-MM-DD", () =>
    assert.equal(parseHkDate("17/10/2025"), "2025-10-17"));
  test("单数字带前导零", () =>
    assert.equal(parseHkDate("05/03/2026"), "2026-03-05"));
  test("非法格式 → 空", () => assert.equal(parseHkDate("2026-03-05"), ""));
  test("空 → 空", () => assert.equal(parseHkDate(""), ""));
});

describe("isGdHk", () => {
  test("繁体广东城市识别", () => {
    assert.equal(isGdHk("深圳承泰科技股份有限公司"), true);
    assert.equal(isGdHk("廣州天賜高新材料股份有限公司"), true);
    assert.equal(isGdHk("東莞某科技有限公司"), true);
  });
  test("英文兜底", () =>
    assert.equal(isGdHk("Guangzhou X Tech Limited"), true));
  test("非广东 → false", () => {
    assert.equal(isGdHk("青島特銳德電氣股份有限公司"), false);
    assert.equal(isGdHk("Beijing Y Tech"), false);
  });
});

describe("HkFilingCrawler.run()", () => {
  test("广东识别 → hk-filing-gd / 非广东 → hk-filing", async () => {
    const c = new MockHkFiling([
      app({ id: 1, d: hkDate(-1), a: "深圳承泰科技股份有限公司", w: "sehk/2025/1/w.pdf" }),
      app({ id: 2, d: hkDate(-2), a: "青島特銳德電氣股份有限公司", ls: [{ d: hkDate(-2), u1: "sehk/2026/2/x.pdf" }] }),
      app({ id: 3, d: "01/01/2020", a: "廣州某科技有限公司", w: "sehk/2020/3/w.pdf" }), // 超窗口 → 丢弃
    ]);
    const res = await c.run();
    assert.equal(res.length, 2);
    const gd = res.find((r) => r.sourceId === "hk-filing-gd")!;
    assert.ok(gd);
    assert.equal(gd.region, "gd");
    assert.equal(gd.registeredProvince, "广东");
    assert.equal(gd.ipoStage, "stage-reviewing");
    assert.match(gd.title!, /广东企业/);
    // 仅 w 可用（无 ls）→ 兜底取警示函链接并如实标注，日期回落到顶层 d
    assert.equal(gd.url, "https://www1.hkexnews.hk/app/sehk/2025/1/w.pdf");
    assert.equal(gd.publishedAt, parseHkDate(hkDate(-1)));
    const cn = res.find((r) => r.sourceId === "hk-filing")!;
    assert.ok(cn);
    assert.equal(cn.region, "cn");
    assert.equal(cn.url, "https://www1.hkexnews.hk/app/sehk/2026/2/x.pdf");
  });

  test("主链接取申請版本公告的简讯页u2(htm)，而非警示函w/保荐人委任/几百页PDF", async () => {
    const c = new MockHkFiling([
      app({
        id: 100,
        d: hkDate(-1), // 顶层 d = 最近更新日（修订保荐人公告那天）
        a: "珠海金智維人工智能股份有限公司",
        w: "sehk/2026/100/documents/warn26082102361_c.pdf",
        ls: [
          { d: hkDate(-1), nS1: "整體協調人公告－委任（經修訂）", u1: "sehk/2026/100/documents/sehk26090401356_c.pdf" },
          {
            d: hkDate(-3), // 申請版本（第一次呈交）= 真正递表日
            nF: "申請版本（第一次呈交）",
            nS1: "全文檔案",
            u1: "sehk/2026/100/documents/sehk26082102363_c.pdf",
            u2: "sehk/2026/100/2026082102360_c.htm",
          },
        ],
      }),
    ]);
    const res = await c.run();
    assert.equal(res.length, 1);
    // 必须是申請版本公告的简讯页(htm)：不是 warn 警示函、不是保荐人委任公告、不是几百页 PDF
    assert.equal(
      res[0].url,
      "https://www1.hkexnews.hk/app/sehk/2026/100/2026082102360_c.htm",
    );
    assert.equal(res[0].officialLabel, "申請版本（第一次呈交）");
    // 卡片日期必须是所选文档(申請版本)自带的递表日，而非顶层最近更新日
    assert.equal(res[0].publishedAt, parseHkDate(hkDate(-3)));
  });

  test("无 u2 简讯页时回退到申請版本 PDF(u1)，绝不用 w 警示函", async () => {
    const c = new MockHkFiling([
      app({
        id: 101,
        d: hkDate(-1),
        a: "東莞某科技有限公司",
        w: "sehk/2026/101/documents/warn26022601051_c.pdf",
        ls: [
          {
            d: hkDate(-1),
            nF: "申請版本（第一次呈交）",
            nS1: "全文檔案",
            u1: "sehk/2026/101/documents/sehk26022601053_c.pdf",
          },
        ],
      }),
    ]);
    const res = await c.run();
    assert.equal(res.length, 1);
    assert.equal(
      res[0].url,
      "https://www1.hkexnews.hk/app/sehk/2026/101/documents/sehk26022601053_c.pdf",
    );
  });

  test("时间红线：无递表日废弃", async () => {
    const c = new MockHkFiling([app({ id: 9, d: "not-a-date", a: "深圳某科技" })]);
    const res = await c.run();
    assert.equal(res.length, 0);
  });

  test("音量上限：广东/全国独立封顶，全国参考不被挤占", async () => {
    const many: HkApp[] = [];
    for (let i = 1; i <= 60; i++) {
      const gd = i <= 30; // 前 30 条广东，后 30 条全国
      many.push(
        app({
          id: i,
          d: hkDate(-1), // 全部落在 7 天窗内，验证的是封顶而非窗口
          a: gd ? `深圳第${i}科技有限公司` : `北京第${i}科技有限公司`,
        }),
      );
    }
    const c = new MockHkFiling(many);
    c.maxGd = 25;
    c.maxNational = 15;
    const res = await c.run();
    assert.equal(res.length, 40);
    const gdCount = res.filter((r) => r.region === "gd").length;
    assert.equal(gdCount, 25); // 广东封顶 25
    const cnCount = res.filter((r) => r.region !== "gd").length;
    assert.equal(cnCount, 15); // 全国参考保底 15（不被挤占为 0）
  });

  test("官方链接缺省 → url 回退板块入口", async () => {
    const c = new MockHkFiling([app({ id: 5, d: hkDate(-1), a: "深圳某科技" })]);
    const res = await c.run();
    assert.equal(res.length, 1);
    assert.match(res[0].url!, /ncms\/json\/eds\/appactive_app_sehk_c\.json/);
    assert.equal(res[0].officialUrl, undefined);
  });
});
