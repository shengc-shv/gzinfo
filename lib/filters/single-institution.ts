/**
 * 单机构新闻过滤（2026-08-25 用户决定，永久生效）
 *
 * 位置：采集汇合 + 源层窗口过滤之后、L0 关键词漏斗之前（LLM 分析前最后一道数据闸）。
 *
 * 规则：新闻中只提到 **1 家** 金融机构（银行/保险/证券/基金/理财/信托/资管/人寿/财险等），
 * 且该机构不在白名单（六大国有行 + 广州银行）→ 该条不进入 LLM 分析（单机构新闻对分行无参考意义）。
 * - 提到 0 家机构（宏观/政策/市场类）→ 保留
 * - 提到 ≥2 家机构（同业对比/宏观综述）→ 保留
 * - 提到 1 家且在白名单 → 保留（六大行/广州银行动态有参考价值）
 * - 提到 1 家且不在白名单 → 过滤（如"成都银行中报"“渤海银行被罚”“平安理财半年考”）
 *
 * 泛称不视为机构：多家银行/商业银行/银行理财/银行板块/保险公司/基金公司/证券公司/
 * 信托公司/证券交易所/证券时报/公募基金/私募基金 等。
 */

export interface SingleInstitutionInput {
  title?: string;
  excerpt?: string;
}

/** 白名单机构（规范名）——六大国有行 + 广州银行 */
const WHITELIST = new Set([
  "中国工商银行",
  "工商银行",
  "工行",
  "中国农业银行",
  "农业银行",
  "农行",
  "中国银行",
  "中行",
  "中国建设银行",
  "建设银行",
  "建行",
  "交通银行",
  "交行",
  "中国邮政储蓄银行",
  "邮政储蓄银行",
  "邮储银行",
  "邮储",
  "广州银行",
]);

/** 机构别名 → 规范名（去重计数用） */
const NORMALIZE: Array<[RegExp, string]> = [
  [/中国工商银行|工商银行|工行/g, "工行"],
  [/中国农业银行|农业银行|农行/g, "农行"],
  [/中国银行(?!国际)|中行(?!金)/g, "中行"],
  [/中国建设银行|建设银行|建行/g, "建行"],
  [/中国交通银行|交通银行|交行/g, "交行"],
  [/中国邮政储蓄银行|邮政储蓄银行|邮储银行|邮储/g, "邮储"],
  [/广州银行/g, "广州银行"],
];

/** 泛称（不视为具体机构，命中即跳过该匹配） */
const GENERIC_PATTERNS = [
  /多家银行/g,
  /商业银行/g,
  /银行机构/g,
  /银行理财/g,
  /银行系/g,
  /银行间/g,
  /银行股/g,
  /银行板块/g,
  /银行渠道/g,
  /银行网点/g,
  /银行业/g,
  /城商行/g,
  /农商行/g,
  /国有大行/g,
  /股份制银行/g,
  /外资银行/g,
  /上市银行/g,
  /地方银行/g,
  /中小银行/g,
  /区域性银行/g,
  /头部银行/g,
  /大型银行/g,
  /部分银行/g,
  /多家银行/g,
  /银行代销/g,
  /银行存款/g,
  /银行贷款/g,
  /银行利率/g,
  /银行息差/g,
  /银行中收/g,
  // 2026-08-25 修复：XX银行部（公司银行部/零售银行部/私人银行部）是部门名非机构
  /公司银行部/g,
  /零售银行部/g,
  /私人银行部/g,
  /个人银行部/g,
  /机构银行部/g,
  /金融市场部/g,
  /银行部/g,
  /公司银行/g,
  /零售银行/g,
  /私人银行/g,
  /银行资本/g,
  /银行治理/g,
  /保险公司/g,
  /保险业/g,
  /保险产品/g,
  /保险资金/g,
  /保险行业/g,
  /保险机构/g,
  // 2026-08-25 修复：分红型保险/分红险 是产品泛称非机构（误伤"定期存款热度降温"）
  /分红型保险/g,
  /分红险/g,
  /储蓄型保险/g,
  /年金险/g,
  /增额寿/g,
  /重疾险/g,
  /医疗险/g,
  /寿险/g,
  /基金公司/g,
  /基金行业/g,
  /基金产品/g,
  /基金组合/g,
  /公募基金/g,
  /私募基金/g,
  /基金指数/g,
  /证券公司/g,
  /证券行业/g,
  /证券时报/g,
  /证券日报/g,
  /证券交易所/g,
  /券商/g,
  /信托公司/g,
  /信托行业/g,
  /资管公司/g,
  /理财公司/g,
  // 2026-08-25 存量清理误伤修复：宏观/市场泛称 + 概念词（不视为具体机构）
  /主权基金/g,
  /长线基金/g,
  /多只基金/g,
  /绩优基金/g,
  /旗下基金/g,
  /公募REITs/g,
  /算力银行/g,
  /算力超市/g,
  /机器人ETF/g,
  /黄金ETF/g,
  /十年国债ETF/g,
  /ETF/g,
  /QDII/g,
  /基金发行热点/g,
  /固收\+/g,
  /创新药ETF/g,
  /恒生科技ETF/g,
  /港股通/g,
  /理财规模/g,
  /在港银行/g,
  /净值和规模/g,
  /基金净值/g,
  /份额净值/g,
  /理财市场/g,
  /理财行业/g,
  /理财产品/g,
  /理财子公司/g,
];

/** 提取机构名（含泛称掩码）：从 title+excerpt 提取"XX银行/XX保险/…"形式的具体机构名 */
function extractInstitutions(text: string): string[] {
  if (!text) return [];
  let masked = text;
  // 先把泛称掩掉（避免"商业银行""银行理财"等被当机构）
  for (const p of GENERIC_PATTERNS) {
    masked = masked.replace(p, " ");
  }
  // 提取机构名：中文/字母数字 2-12 字 + 机构后缀
  const INST_RE =
    /([\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:银行|保险|证券|基金|理财|信托|资管|人寿|财险))/g;
  const raw: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = INST_RE.exec(masked))) {
    const name = m[1];
    // 排除明显非机构名（后缀词本身单独出现）
    if (/^(银行|保险|证券|基金|理财|信托|资管|人寿|财险)$/.test(name)) continue;
    // 排除"XX基金"类泛指（如"基金"前缀无实体名）：要求名字含机构特征字或长度足够
    raw.push(name);
  }
  return raw;
}

/** 归一化机构名（别名 → 规范名），用于白名单判定与去重 */
function normalize(name: string): string {
  let n = name;
  for (const [re, canon] of NORMALIZE) {
    re.lastIndex = 0; // 防 lastIndex 残留
    if (re.test(n)) {
      n = canon;
      break;
    }
  }
  return n;
}

/** 单机构过滤：返回是否保留 */
export function shouldKeepSingleInstitution(a: SingleInstitutionInput): boolean {
  const text = `${a.title ?? ""} ${a.excerpt ?? ""}`;
  const raw = extractInstitutions(text);
  if (raw.length === 0) return true; // 无机构（宏观/政策）→ 保留

  // 去重（归一化后）
  const uniq = new Set(raw.map(normalize));
  if (uniq.size >= 2) return true; // ≥2 家机构 → 保留（同业对比/综述）

  // 仅 1 家机构
  const only = [...uniq][0];
  if (WHITELIST.has(only)) return true; // 白名单（六大行/广州银行）→ 保留
  return false; // 单机构非白名单 → 过滤
}

/** 批量过滤（导出供 daily.ts 调用） */
export function filterSingleInstitution<T extends SingleInstitutionInput>(
  items: T[],
): T[] {
  return items.filter(shouldKeepSingleInstitution);
}
