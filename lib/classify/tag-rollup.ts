/**
 * 标签双标映射（2026-08-24）：把文章的自由标签（ALLOWED_TAGS）与部门 subcategory
 * 统一塌缩成「业务线 5 维」可筛的标签集合。
 *
 * 设计背景：报告筛选条（业务线：客群/私行/财富/信贷/其他）只读 ReportItem.tags 里的
 * 部门值。但 AI 自由标签（信用卡/市场/粤…）原本只做卡片展示、不进 tags，导致这些标签
 * 的信息在 5 维里查不出来。此处做双标：
 *   it.tags = 部门(subcategory) ∪ 自由标签(展示) ∪ 自由标签经映射产生的部门
 * 这样每张卡必带 ≥1 个部门标签，粤仅随行展示不归类，监管合规随文章业务线兜底。
 */

/** 自由标签 → 部门（业务线 5 维之一）。不在表内的自由标签不映射。 */
export const TAG_TO_DEPT: Record<string, string> = {
  "代发": "客群",
  "信用卡": "客群",
  "养老": "客群",
  "市场": "客群",
  "政银合作": "客群",
  "消费贷": "信贷",
  "住房金融": "信贷",
  "跨境": "财富",
  // 科技金融 / 竞对动态：不映射 → 整片落「其他」
  // 监管合规：不映射 → 随文章业务线兜底（文章有部门 subcategory 即跟随；否则「其他」）
  // 粤：不映射 → 独立地域维度，仅展示、不归类、不进 5 维筛选
};

/** subcategory（gz-/cn- 前缀）→ 部门。cn-* 为历史残留，保留映射不影响（线上已 0 数据）。 */
const SUB_TO_DEPT: Record<string, string> = {
  "gz-wealth": "财富",
  "cn-wealth": "财富",
  "gz-credit": "信贷",
  "cn-credit": "信贷",
  "gz-private": "私行",
  "cn-private": "私行",
  "gz-customer": "客群",
  "cn-customer": "客群",
};

/** 结构类型：任何带 subcategory/subcategories/tags/title/summary 的对象都能喂进来 */
interface Taggable {
  subcategories?: string[] | null;
  subcategory?: string | null;
  tags?: string[] | null;
  title?: string | null;
  summary?: string | null;
}

/** 标题/摘要关键词 → 部门（2026-08-25 兜底：v1-v8 把部门 subcategory 改成 cn-finance 等
 *  通用值后 SUB_TO_DEPT 映射失效，SKIP_AI 又无 LLM 自由标签 → 部门标签全空。
 *  此处按内容关键词推断，保证每张卡必带 ≥1 个部门标签。） */
const TEXT_TO_DEPT: Array<[RegExp, string]> = [
  [/理财|基金|保险|黄金|贵金属|财富|资管|代销|信托|ETF|债市|国债|AUM|积存金|金条/, "财富"],
  [/贷款|信贷|房贷|消费贷|经营贷|按揭|公积金|利率|首付|融资担保|普惠|小微/, "信贷"],
  [/私行|家族|高净值|私人银行|股权|家办/, "私行"],
  [/客群|零售|代发|信用卡|养老|支付|商圈|储户|网点|反诈/, "客群"],
];

/**
 * 双标构造：返回去重后的标签数组，同时包含
 *  - 部门（来自 subcategory 映射 + 标题/摘要关键词推断）
 *  - 原始自由标签（用于卡片展示，含粤/监管合规等）
 *  - 自由标签经 TAG_TO_DEPT 产生的部门
 */
export function rollUpTags(a: Taggable): string[] {
  const subs =
    a.subcategories && a.subcategories.length > 0
      ? a.subcategories
      : a.subcategory
        ? [a.subcategory]
        : [];
  const deptFromSub = Array.from(
    new Set(subs.map((s) => SUB_TO_DEPT[s]).filter((t): t is string => Boolean(t))),
  );
  const free = Array.isArray(a.tags) ? a.tags : [];
  const deptFromFree = Array.from(
    new Set(free.map((t) => TAG_TO_DEPT[t]).filter((t): t is string => Boolean(t))),
  );
  // 标题关键词 → 部门（兜底，保证必带 ≥1 部门标签；只看 title——
  // 滚动历史的 summary 是脚本套话"对分行财富/信贷/客群业务有宏观参考"，会误伤三部门全标）
  const text = `${a.title ?? ""}`;
  const deptFromText = Array.from(
    new Set(TEXT_TO_DEPT.filter(([re]) => re.test(text)).map(([, d]) => d)),
  );
  return Array.from(new Set([...deptFromSub, ...deptFromText, ...free, ...deptFromFree]));
}
