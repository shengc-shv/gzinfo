import { runLlm } from "./llm";
import { extractJson } from "./json-util";

/**
 * 条目级 LLM 分类（并入 daily 流程）
 *
 * 对新增条目批量调用 LLM，输出 { relevant(是否与银行业务相关), subcategories(业务线多标签),
 * summary(银行视角摘要) }。subcategories 为多值数组（≤3）：一条信息可能同时影响多个
 * 业务线/场景，AI 应打多个标签，渲染层据此多归桶（同一 URL 进多个业务线面板）。
 * 任何失败（余额不足 402 / 网络 / 解析）→ 返回空 Map，调用方降级到启发式/注册表，绝不影响 daily 主流程。
 */

export interface ItemClassifyResult {
  relevant: boolean;
  /** 业务线多标签（按影响程度排序，≤3；至少 1 个）。 */
  subcategories: string[];
  summary: string;
}

const SYSTEM_PROMPT =
  "你是股份行广州分行零售决策简报编辑。逐条判断相关性、归类业务线子标签（可多标签）、写银行视角摘要，严格按用户要求输出 JSON。";

export const RULES = `你是股份行广州分行零售决策简报编辑。对每条信息逐条判断，输出 JSON。

每条输入含 category 字段，必须按对应类别的标签体系选 subcategories（禁止跨体系混用）。
一条信息可能同时影响多个业务线/场景（例如"广州房贷利率下调"同时影响 个人信贷 与 财富管理）：
- subcategories 输出 JSON 字符串数组，最多 3 个，按影响程度从大到小排序；
- 只影响一个业务线时输出单元素数组；不影响任何业务线时输出空数组 []。
- 涉及广州本地落地才归 gz-*；银行业综合/宏观归 cn-finance，国际归 news，政策归 cn-policy。

=== gz / finance 标签体系 ===
1. relevant(bool)：对银行零售业务（财富管理/个人信贷/零售客群/私行业务）或分行经营决策是否有参考价值。
   - 无关(false)：历史建筑保护、门前三包、交通管制、环保、司法行政、招聘、纯个股行情、娱乐八卦等。
   - 相关(true)：经济数据、金融信贷政策、房地产/房贷、产业扶持招商、企业IPO/融资、消费客群、理财/基金/保险/黄金、银行经营监管。
   - 国际宏观(news)特别规则：涉及「美联储 / 利率 / 流动性 / 货币政策 / 美债收益率 / 美元或人民币汇率 / 黄金价格 / 大宗商品」的，对零售信贷(房贷/消费贷利率)与财富管理(理财/黄金/债基)有直接影响，判 relevant=true（subcategories 含 news，必要时并 cn-finance）；纯国际时政、地缘冲突、海外企业个股、娱乐体育等无银行零售参考价值的，判 relevant=false。
2. subcategories 候选（可多选，≤3）：
   - cn-finance：全国性综合财经资讯（银行业监管/货币宏观/市场综述等）不明确归属上述某业务线、又不涉及广州本地的报道；
   - gz-wealth：财富管理（理财/基金/保险/黄金/存款/利率），仅限明确涉及广州/南沙/湛江/清远本地；
   - gz-credit：个人信贷（房贷/消费贷/经营贷/普惠），仅限广州本地；
   - gz-customer：零售客群（广州居民消费/社零/收入/人口/就业）；
   - gz-private：私行业务（广州家族企业/股权/企业主/高端产业扶持）；
   - gz-ipo：广州辖区企业 IPO/上市/融资/辅导；
   - gz-policy：广州市级/南沙政府政策文件；
   - gz-media：广州本地媒体（大洋网/南方经济/中新网广东/央广网广东等）对广州/广东经济民生的报道，涉及广州本地即归此（2026-08-21 第一梯队新源）；
   - cn-policy：国家级宏观政策（国务院/央行/部委）；
   - news：国际宏观。
   口诀：涉及广州本地落地才归 gz-*；银行业综合/宏观/不明确归某线的归 cn-finance，国际归 news，政策归 cn-policy；一条可同时归多个。

=== tech 标签体系（relevant 固定 true）===
subcategories 候选：cn-tech（综合科技产业/政策/国内大厂动态）/ overseas-tech（国外技术，含金融科技/AI 监管）。

=== ipo 标签体系（relevant 固定 true）===
subcategories 候选（按上市地）：hkex（港交所）/ sse（上交所）/ szse（深交所）/ bse（北交所）。

=== gd-ipo 标签体系（relevant 固定 true）===
subcategories 候选：hkex（港交所）/ overseas（海外上市）/ foreign（外资/境外）。
（注：实际渲染路由由三道闸区域分类器最终裁定，此处仅作 AI 初步标注）

3. summary：30-50 字中文摘要，站在银行零售业务视角点出这条信息意味着什么、对分行有什么启示（tech/ipo 等参考区也站在"对分行有什么参考价值"角度写）。
   - **摘要首句直接给结论/落点（"所以呢"）**：先讲对分行/业务的启示，再补事实细节；禁止「复述标题+对XX有参考」八股（#24 2026-08-21 重构）
   - **事实校验（#25）**：地区归属（广东/广州/某省）必须以输入信息为依据，注册地/事发地不明的禁止臆断属地

输出 STRICTLY 一个 JSON 对象（无 markdown 代码块）：
{"items":[{"url":"<必须原样回填输入的url>","relevant":true,"subcategories":["gz-credit","gz-wealth"],"summary":"..."}]}

注意：summary 内的引号请用单引号或中文引号，禁止裸双引号。`;

/** 解析多标签：兼容 AI 输出数组或旧单值 subcategory，去重、截断 ≤3。 */
function parseSubcategories(x: {
  subcategories?: unknown;
  subcategory?: unknown;
}): string[] {
  const raw = Array.isArray(x.subcategories)
    ? x.subcategories
    : x.subcategory !== undefined
      ? [x.subcategory]
      : [];
  const seen: string[] = [];
  for (const v of raw) {
    const s = String(v ?? "").trim();
    if (s && !seen.includes(s)) seen.push(s);
    if (seen.length >= 3) break;
  }
  return seen;
}

export async function classifyItemsWithLlm(
  items: Array<{ url: string; title: string; source?: string; category?: string }>,
  batchSize = 40,
): Promise<Map<string, ItemClassifyResult>> {
  const result = new Map<string, ItemClassifyResult>();
  if (items.length === 0) return result;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const userPrompt = [
      RULES,
      "",
      `候选条目（共 ${batch.length} 条，JSON 数组，每条含 url/title/source）：`,
      JSON.stringify(batch),
      "",
      "请逐条分析并输出 {\"items\": [...]}，url 必须精确回填输入值。",
    ].join("\n");
    try {
      const { text } = await runLlm({ systemPrompt: SYSTEM_PROMPT, userPrompt, timeoutMs: 240_000 }, { stage: "classify" });
      const cleaned = extractJson(text);
      let parsed: {
        items?: Array<{
          url?: string;
          relevant?: boolean;
          subcategory?: string;
          subcategories?: unknown;
          summary?: string;
        }>;
      };
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        const jsonrepair = (await import("jsonrepair")).jsonrepair;
        parsed = JSON.parse(jsonrepair(cleaned));
      }
      for (const x of parsed.items ?? []) {
        if (x.url) {
          result.set(x.url, {
            relevant: x.relevant === true,
            subcategories: parseSubcategories(x),
            summary: (x.summary || "").trim(),
          });
        }
      }
    } catch {
      // 单批失败（402/网络/解析）→ 跳过该批，调用方降级
    }
  }
  return result;
}
