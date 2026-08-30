/**
 * 东财在审企业表爬虫（lib/sources/crawlers/sources/eastmoney-declare.ts）单测：
 * 公司名简称 / 状态映射 / 7 天窗口 / 负面状态丢弃 / 结构化信号（region+registeredProvince）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EastMoneyDeclareCrawler, shortCompanyName } from "../lib/sources/crawlers/sources/eastmoney-declare";

test("shortCompanyName: 去掉企业组织形式后缀", () => {
  // 「技术」是行业词、属公司名一部分，不去除；只去组织形式后缀
  assert.equal(shortCompanyName("粤芯半导体技术股份有限公司"), "粤芯半导体技术");
  assert.equal(shortCompanyName("广州某某科技有限公司"), "广州某某科技");
  assert.equal(shortCompanyName("东莞某有限公司"), "东莞某");
  assert.equal(shortCompanyName("无后缀企业"), "无后缀企业");
});

test("parseArticle: 广东在审企业 → 结构化输出（region/registeredProvince/时间红线）", async () => {
  const crawler = new EastMoneyDeclareCrawler();
  const today = new Date();
  const d = (daysAgo: number) => {
    const dt = new Date(today);
    dt.setDate(dt.getDate() - daysAgo);
    return dt.toISOString().slice(0, 10);
  };
  const payload = JSON.stringify({
    result: {
      data: [
        // 窗口内（3 天前更新）：粤芯（东财表内仍为「已收到注册申请材料」状态）
        {
          DECLARE_ORG: "粤芯半导体技术股份有限公司",
          STATE: "已收到注册申请材料",
          END_DATE: `${d(3)} 00:00:00`,
          REG_ADDRESS: "广东",
          PREDICT_LISTING_MARKET: "创业板",
          RECOMMEND_ORG: "广发证券股份有限公司",
        },
        // 窗口内：注册生效
        {
          DECLARE_ORG: "珠海越亚半导体股份有限公司",
          STATE: "注册",
          END_DATE: `${d(1)} 00:00:00`,
          REG_ADDRESS: "广东",
          PREDICT_LISTING_MARKET: "科创板",
          RECOMMEND_ORG: "",
        },
        // 超窗口（10 天前更新）→ 丢弃
        {
          DECLARE_ORG: "惠州老企业股份有限公司",
          STATE: "已问询",
          END_DATE: `${d(10)} 00:00:00`,
          REG_ADDRESS: "广东",
        },
        // 终止 → 丢弃（商机视角无价值）
        {
          DECLARE_ORG: "佛山终止企业股份有限公司",
          STATE: "终止",
          END_DATE: `${d(2)} 00:00:00`,
          REG_ADDRESS: "广东",
        },
        // 无 END_DATE（时间红线）→ 丢弃，绝不回退抓取时间
        { DECLARE_ORG: "深圳无日期企业股份有限公司", STATE: "已受理" },
      ],
    },
  });
  const out = await crawler.parseArticle(payload);
  assert.equal(out.length, 2, "只保留窗口内且非负面状态条目");
  assert.equal(out[0].title, "粤芯半导体技术：注册申请材料已受理（拟创业板）");
  assert.ok(out[0].excerpt!.includes("注册地：广东"));
  assert.ok(out[0].excerpt!.includes("保荐：广发证券"));
  assert.equal(out[0].publishedAt, d(3));
  assert.equal(out[0].region, "gd");
  assert.equal(out[0].registeredProvince, "广东");
  assert.equal(out[0].sourceId, "em-declare");
  assert.equal(out[1].title, "珠海越亚半导体：IPO注册生效（拟科创板）");
});

test("parseArticle: 非法 JSON / 无数据 → 空数组（不崩溃）", async () => {
  const crawler = new EastMoneyDeclareCrawler();
  assert.deepEqual(await crawler.parseArticle("not json"), []);
  assert.deepEqual(await crawler.parseArticle(JSON.stringify({ result: {} })), []);
});

test("getUrls: 广东过滤 + 5 页分页", async () => {
  const crawler = new EastMoneyDeclareCrawler();
  const urls = await crawler.getUrls();
  assert.equal(urls.length, 5);
  for (const u of urls) {
    const url = typeof u === "string" ? u : u.url;
    assert.ok(url.includes("reportName=RPT_IPO_DECORGNEWEST"));
    assert.ok(decodeURIComponent(url).includes('REG_ADDRESS="广东"'));
  }
});
