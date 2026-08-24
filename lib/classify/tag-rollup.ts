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

/** 结构类型：任何带 subcategory/subcategories/tags 的对象都能喂进来（ArticleInput / Pass1Item / 缓存条目）。 */
interface Taggable {
  subcategories?: string[] | null;
  subcategory?: string | null;
  tags?: string[] | null;
}

/**
 * 双标构造：返回去重后的标签数组，同时包含
 *  - 部门（来自 subcategory 映射）
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
  return Array.from(new Set([...deptFromSub, ...free, ...deptFromFree]));
}
