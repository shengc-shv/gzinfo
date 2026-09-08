/**
 * 客户客群分段（商机洞察三维细分）
 *
 * 将文章/商机映射为三类最受关注的客户客群段：
 *  - 零售AUM
 *  - 中高端客群(过亿资产)
 *  - 普惠小微贷款客户
 * 其余 → 其他业务线（渲染时收进「其他业务线」折叠区）。
 *
 * 纯函数、零依赖、非红线文件。段标签为全管线唯一常量（LLM 提示词、渲染分组、
 * 业务启示 tab 文章权重提升共用），避免字面量漂移。
 *
 * 输入兼容两种形态：
 *  - subcategory 代码（gz-wealth / gz-private / gz-credit …，条目级 AI 分类产出）
 *  - 中文部门 tag（财富 / 私行 / 信贷 / 客群 …，ReportItem.tags 落库形态）
 * 统一经 mapSegmentsFromHints 推导，标题关键词作兜底补命中。
 */

export const PRIORITY_SEGMENTS = [
  "零售AUM",
  "中高端客群(过亿资产)",
  "普惠小微贷款客户",
] as const;

export type PrioritySegment = (typeof PRIORITY_SEGMENTS)[number];

export const OTHER_SEGMENT = "其他业务线";

export type CustomerSegment = PrioritySegment | typeof OTHER_SEGMENT;

export function isPrioritySegment(s: string): s is PrioritySegment {
  return (PRIORITY_SEGMENTS as readonly string[]).includes(s);
}

const TITLE_PUHUI = /普惠|小微|经营贷|支小|首贷|个体工商户|纾困|再贷款|普惠小微/;
const TITLE_HNW = /私行|家族(信托|办公室)|企业主|高净值|过亿|超高净值|家族财富/;
const TITLE_AUM = /理财|基金|保险|黄金|存款|AUM|财富管理|资产配置|净值/;

/**
 * 由一组「线索」（subcategory 代码或中文部门 tag 任意混合）+ 标题推导客群段（可多段归属）。
 */
export function mapSegmentsFromHints(hints: string[], title = ""): CustomerSegment[] {
  const segs = new Set<CustomerSegment>();
  const has = (...keys: string[]): boolean => hints.some((h) => keys.includes(h));
  if (has("gz-wealth", "cn-wealth", "财富")) segs.add("零售AUM");
  if (has("gz-private", "cn-private", "私行")) segs.add("中高端客群(过亿资产)");
  if (has("gz-credit", "cn-credit", "信贷")) {
    // 普惠/小微/经营贷 → 普惠小微；房贷/消费贷/个贷 → 零售AUM
    if (TITLE_PUHUI.test(title)) segs.add("普惠小微贷款客户");
    else segs.add("零售AUM");
  }
  if (has("gz-customer", "客群")) segs.add("零售AUM");
  // 标题兜底补命中（针对无 gz 标签或空标签的条目）
  if (TITLE_PUHUI.test(title)) segs.add("普惠小微贷款客户");
  if (TITLE_HNW.test(title)) segs.add("中高端客群(过亿资产)");
  if (TITLE_AUM.test(title)) segs.add("零售AUM");
  if (segs.size === 0) segs.add(OTHER_SEGMENT);
  return [...segs];
}

/** 由文章 subcategory 代码 + 标题推导客群段（条目级 AI 分类场景）。 */
export function mapSubcategoryToSegments(
  subcategory?: string,
  title = "",
): CustomerSegment[] {
  return mapSegmentsFromHints(subcategory ? [subcategory] : [], title);
}

/** 由中文部门 tag 列表 + 标题推导客群段（ReportItem.tags 落库场景）。 */
export function mapTagsToSegments(tags: string[] | undefined, title = ""): CustomerSegment[] {
  return mapSegmentsFromHints(tags ?? [], title);
}
