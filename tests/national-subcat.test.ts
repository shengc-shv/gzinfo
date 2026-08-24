/**
 * #33 回归（2026-08-21 三次更新）：全国 cn-wealth/cn-credit/cn-private 业务线报道
 * 移入广州商机(gz)面板。gz 面板合并为单一 gz-all 合并流（「广州能参考的商机」），
 * 面板内仅按「官方政府 / 媒体智库」两类 tab 展现（不再按业务线/本地全国分层）。
 *
 * 渲染契约（新管线 schema）：renderHtml 消费 report.sections，由上游管线（PASS1
 * locale=gz 判定）决定条目进入 gz_local（广州本地）还是 biz_insight（业务启示）。
 * 本文件锁定：① 渲染板块契约（gz_local 进广州本地 / biz_insight 进业务启示）；
 * ② LLM 候选清单含三项；③ i18n 子标签名保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../lib/output/render";
import { SUBCATEGORY_ORDER, SUBCATEGORY_LABELS } from "../lib/output/render/i18n";
import { RULES } from "../lib/ai/item-classifier";
import type { DailyReport, ReportItem } from "../lib/types";

const REPORT_DATE = "2026-08-19";

const mk = (over: Partial<ReportItem>): ReportItem => ({
  url: "https://x/u",
  title_cn: "标题",
  source: "源",
  source_type: "media",
  date: "08/19",
  summary: "摘要",
  importance: 2,
  rank: 1,
  tags: [],
  locale: "national",
  ...over,
});

const report = (): DailyReport => ({
  date: "",
  hero_line: "",
  must_read: [],
  insights: [],
  sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
});

test("#33 渲染契约：gz 面板合并为单一 gz-all 合并流", () => {
  const order = SUBCATEGORY_ORDER.gz ?? [];
  assert.deepEqual(order, ["gz-all"], "gz 面板应为单一 gz-all 子标签");
  assert.equal(SUBCATEGORY_LABELS["gz-all"], "广州商机");
});

test("#33 渲染契约：cn-* 标签名保留（全国财富/全国零售信贷/全国私行）", () => {
  assert.equal(SUBCATEGORY_LABELS["cn-wealth"], "全国财富");
  assert.equal(SUBCATEGORY_LABELS["cn-credit"], "全国零售信贷");
  assert.equal(SUBCATEGORY_LABELS["cn-private"], "全国私行");
});

test("#33 LLM 候选清单：RULES 已移除全国三项业务线子标签（2026-08-24 用户：来源路由名不合适）", () => {
  assert.ok(!RULES.includes("cn-wealth"), "LLM 候选应已移除 全国财富（过期指令）");
  assert.ok(!RULES.includes("cn-credit"), "LLM 候选应已移除 全国零售信贷（过期指令）");
  assert.ok(!RULES.includes("cn-private"), "LLM 候选应已移除 全国私行（过期指令）");
  assert.ok(
    !RULES.includes("cn-wealth/cn-credit/cn-private"),
    "口诀不应再引导全国性报道按业务线细分归 cn-*",
  );
  assert.ok(RULES.includes("cn-finance"), "RULES 仍应保留 cn-finance（全国综合财经）");
  assert.ok(RULES.includes("gz-"), "RULES 仍应保留 gz-* 广州本地业务线");
});

test("#33/#9 端到端：gz_local 文章进广州本地、biz_insight 文章进业务启示（新 schema 渲染契约）", () => {
  const r: DailyReport = {
    ...report(),
    sections: {
      ...report().sections,
      gz_local: [
        mk({
          url: "https://x/g1",
          title_cn: "广州市政府发布金融支持政策",
          source: "广州市政府",
          source_type: "official",
          tags: ["政银"],
          importance: 3,
          locale: "gz",
          locale_evidence: "广州市",
        }),
      ],
      biz_insight: [
        mk({ url: "https://x/w1", title_cn: "全国理财市场规模突破新高", tags: ["财富"] }),
        mk({ url: "https://x/c1", title_cn: "全国消费贷利率下调", tags: ["信贷"] }),
      ],
    },
  };
  const html = renderHtml(r, REPORT_DATE);
  // 单层 tab：广州本地 + 业务启示
  assert.ok(html.includes('data-target="p-gz"') && html.includes("广州本地"), "应渲染 广州本地 tab");
  assert.ok(html.includes('data-target="p-biz"') && html.includes("业务启示"), "应渲染 业务启示 tab");
  // 广州锚文章进 广州本地 面板；全国文章进 业务启示 面板
  const gzPanel = html.split('id="p-gz"')[1]?.split('id="p-biz"')[0] ?? "";
  const bizPanel = html.split('id="p-biz"')[1]?.split('id="p-pol"')[0] ?? "";
  assert.ok(gzPanel.includes("广州市政府发布金融支持政策"), "广州锚文章应在 广州本地 面板");
  assert.ok(
    bizPanel.includes("全国理财市场规模突破新高") && bizPanel.includes("全国消费贷利率下调"),
    "全国文章应在 业务启示 面板",
  );
});
