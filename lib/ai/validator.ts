/**
 * 确定性校验器（文档第 4 节，13 条规则，全部代码实现）。
 *
 * 设计要点：
 * - 校验器只证伪、不创作；单条内容永远丢得起，信任丢不起。
 * - block 触发回炉/降级；warn 只记日志不阻断。
 * - R2 / R8 需要原文（raw_text），故校验时由调用方注入 pool（url → {raw_text}）。
 * - 校验器为辅助迭代需要，给每个 Item 临时注入 `_sec` 字段记录板块归属，
 *   落盘前由管线统一 pop 清理（见 pipeline.ts）。
 */
import type { DailyReport, ReportItem, ReportSectionKey } from "../types";
import { titleSimilarity } from "../ingest/dedup-similar";

/** tag 封闭词表（文档第 2.2 节）。 */
export const ALLOWED_TAGS = [
  "信贷",
  "财富",
  "私行",
  "代发",
  "信用卡",
  "消费贷",
  "住房金融",
  "客群",
  "养老",
  "竞对动态",
  "政银合作",
  "监管合规",
  "跨境",
  "市场",
  "科技金融",
  // 2026-08-23：广东企业/广东事件的地域标记（AI 分析后打标，替代 sourceId gd- 前缀判定）
  "粤",
] as const;
export type AllowedTag = (typeof ALLOWED_TAGS)[number];

/** 违禁词（R6）：全文禁止出现。含加密类变体（2026-08-21 补：P0 合规——
 * 「加密资产疯涨」此前未被「加密货币」覆盖，store.json 里真实 AI 产物漏网）。 */
export const BANNED_WORDS = [
  "比特币",
  "BTC",
  "ETH",
  "以太坊",
  "加密货币",
  "虚拟货币",
  "加密资产",
  "加密市场",
  "币圈",
  "加密行情",
  "偏上行",
  "偏下行",
];

/** 五个板块键。 */
export const SECTIONS: ReportSectionKey[] = [
  "gz_local",
  "biz_insight",
  "policy_market",
  "tech",
  "ipo",
];

/** R9 跨板块去重相似度阈值（标题 bigram Jaccard；等同 difflib ratio>0.8 的宽松近似）。 */
export const R9_THRESHOLD = 0.8;

/** R4 warn：gz_local 标题+摘要若无以下任一广州关键词则提人工确认。 */
const GZ_KEYWORDS =
  /广州|海珠|琶洲|天河|越秀|黄埔|南沙|番禺|白云|花都|增城|从化|广东/;

export type IssueLevel = "block" | "warn";
export interface Issue {
  level: IssueLevel;
  where: string;
  msg: string;
}

/** 校验输入池：url → 原文（供 R2 / R8 比对）。 */
export interface ValidationPool {
  get(url: string): { raw_text: string } | undefined;
}

function itemWhere(it: ReportItem): string {
  return it.title_cn?.trim() || it.url;
}

/** 归一化数字集合：保留数字与小数点，去除千分位逗号与空格。 */
function normNums(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.matchAll(/[-+]?\d[\d,]*(?:\.\d+)?/g)) {
    set.add(m[0].replace(/[,\s]/g, ""));
  }
  return set;
}

/** 从文本抽取「长度≥2数字」的数字（用于 R8 比对 summary 中的数字）。 */
function summaryNums(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[-+]?\d[\d,]*(?:\.\d+)?/g)) {
    const digits = m[0].replace(/[^\d]/g, "");
    if (digits.length >= 2) out.push(m[0].replace(/[,\s]/g, ""));
  }
  return out;
}

/** 统计字符数（按码点，中文按字计），用于 R12 hero_line 字数。 */
function charCount(s: string): number {
  return [...s].length;
}

/** 把报告所有板块条目摊平。 */
function allItems(report: DailyReport): Array<{ sec: ReportSectionKey; item: ReportItem }> {
  const out: Array<{ sec: ReportSectionKey; item: ReportItem }> = [];
  for (const sec of SECTIONS) {
    for (const it of report.sections[sec] ?? []) {
      out.push({ sec, item: it });
    }
  }
  return out;
}

/** R1 URL 防幻觉（block）：每条 url 必须存在于输入池。 */
function checkR1(report: DailyReport, pool: ValidationPool): Issue[] {
  const issues: Issue[] = [];
  for (const { item } of allItems(report)) {
    if (!pool.get(item.url)) {
      issues.push({
        level: "block",
        where: itemWhere(item),
        msg: `R1 URL防幻觉：url 不在输入池 ${item.url}`,
      });
    }
  }
  return issues;
}

/** R2 地域证据防幻觉（block）+ R3 地域表述一致性（block）。 */
function checkR2R3(report: DailyReport, pool: ValidationPool): Issue[] {
  const issues: Issue[] = [];
  for (const { item } of allItems(report)) {
    const raw = pool.get(item.url)?.raw_text ?? "";
    if (item.locale === "gz") {
      const ev = item.locale_evidence ?? "";
      if (!ev || !raw.includes(ev)) {
        issues.push({
          level: "block",
          where: itemWhere(item),
          msg: `R2 地域证据防幻觉：locale=gz 但 locale_evidence 非该条 raw_text 逐字子串`,
        });
      }
    } else {
      // locale≠gz 却声称（广东/广州）+ 企业/公司等：允许中间夹 0~3 个汉字（如「广东某公司」）
      if (/(广东|广州)(省|市)?[一-鿿]{0,3}(企业|公司|科技|集团)/.test(item.summary)) {
        issues.push({
          level: "block",
          where: itemWhere(item),
          msg: `R3 地域表述一致性：locale≠gz 但 summary 出现「广东/广州企业」字样`,
        });
      }
    }
  }
  return issues;
}

/** R4 gz_local 板块纯洁性（block + warn）。 */
function checkR4(report: DailyReport): Issue[] {
  const issues: Issue[] = [];
  for (const it of report.sections.gz_local ?? []) {
    if (it.locale !== "gz") {
      issues.push({
        level: "block",
        where: itemWhere(it),
        msg: `R4 gz_local纯洁性：板块内存在 locale≠gz 的条目`,
      });
    } else {
      const text = `${it.title_cn} ${it.summary}`;
      if (!GZ_KEYWORDS.test(text)) {
        issues.push({
          level: "warn",
          where: itemWhere(it),
          msg: `R4 gz_local纯洁性：标题+摘要均无广州关键词，建议人工确认`,
        });
      }
    }
  }
  return issues;
}

/** R5 importance 强制分布（block）：全量 importance=3 ≤3 条；每板块 ≤1 条。 */
function checkR5(report: DailyReport): Issue[] {
  const issues: Issue[] = [];
  const total3 = allItems(report).filter((x) => x.item.importance === 3).length;
  if (total3 > 3) {
    issues.push({
      level: "block",
      where: "importance分布",
      msg: `R5 importance强制分布：全量 importance=3 共 ${total3} 条（上限 3）`,
    });
  }
  for (const sec of SECTIONS) {
    const n = (report.sections[sec] ?? []).filter((it) => it.importance === 3).length;
    if (n > 1) {
      issues.push({
        level: "block",
        where: `sections.${sec}`,
        msg: `R5 importance强制分布：板块 ${sec} 内 importance=3 共 ${n} 条（上限 1）`,
      });
    }
  }
  return issues;
}

/** R6 违禁词（block）：全文序列化后扫描。 */
function checkR6(report: DailyReport): Issue[] {
  const blob = JSON.stringify(report);
  const hits = BANNED_WORDS.filter((w) => blob.includes(w));
  if (hits.length === 0) return [];
  return [
    {
      level: "block",
      where: "全文",
      msg: `R6 违禁词：${hits.join("、")}`,
    },
  ];
}

/** R7 空话检测（block）。 */
function checkR7(report: DailyReport): Issue[] {
  const issues: Issue[] = [];
  const emptytalk =
    /与银行零售业务无(直接)?关联/;
  const referenceEnd = /对[^。]{0,15}有(直接)?(参考|借鉴|启示)[。]?$/;
  for (const { item } of allItems(report)) {
    if (emptytalk.test(item.summary) || referenceEnd.test(item.summary)) {
      issues.push({
        level: "block",
        where: itemWhere(item),
        msg: `R7 空话检测：summary 出现无关表述或「对…有参考/借鉴/启示」空话收尾`,
      });
    }
  }
  return issues;
}

/** R8 数字防幻觉（warn）：summary 中每个≥2位数字必须出现在原文数字集合。 */
function checkR8(report: DailyReport, pool: ValidationPool): Issue[] {
  const issues: Issue[] = [];
  for (const { item } of allItems(report)) {
    const raw = pool.get(item.url)?.raw_text ?? "";
    const rawNums = normNums(raw);
    if (rawNums.size === 0) continue;
    for (const num of summaryNums(item.summary)) {
      if (!rawNums.has(num)) {
        issues.push({
          level: "warn",
          where: itemWhere(item),
          msg: `R8 数字防幻觉：summary 数字「${num}」未在原文出现`,
        });
        break; // 每条最多报一次，避免噪音
      }
    }
  }
  return issues;
}

/** R9 跨板块去重（block）：任意两条 title_cn 相似度 > 阈值。 */
function checkR9(report: DailyReport): Issue[] {
  const issues: Issue[] = [];
  const items = allItems(report);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].item;
      const b = items[j].item;
      const t1 = a.title_cn || a.title_orig || "";
      const t2 = b.title_cn || b.title_orig || "";
      if (!t1 || !t2) continue;
      if (titleSimilarity(t1, t2) > R9_THRESHOLD) {
        issues.push({
          level: "block",
          where: `《${itemWhere(a)}》 / 《${itemWhere(b)}》`,
          msg: `R9 跨板块去重：标题相似度过高（${itemWhere(a)} 与 ${itemWhere(b)}）`,
        });
      }
    }
  }
  return issues;
}

/** R10 tag 封闭词表（block）。 */
function checkR10(report: DailyReport): Issue[] {
  const issues: Issue[] = [];
  const allowed = new Set<string>(ALLOWED_TAGS);
  for (const { item } of allItems(report)) {
    for (const t of item.tags ?? []) {
      if (!allowed.has(t)) {
        issues.push({
          level: "block",
          where: itemWhere(item),
          msg: `R10 tag封闭词表：非法 tag「${t}」`,
        });
      }
    }
  }
  return issues;
}

/** R11 商机结构完整性（block）。 */
function checkR11(report: DailyReport): Issue[] {
  const issues: Issue[] = [];
  const allowed = new Set<string>(ALLOWED_TAGS);
  if (report.insights.length > 5) {
    issues.push({
      level: "block",
      where: "insights",
      msg: `R11 商机结构完整性：insights 共 ${report.insights.length} 条（上限 5）`,
    });
  }
  report.insights.forEach((it, i) => {
    if (!it.impact?.trim()) {
      issues.push({ level: "block", where: `insights[${i}]`, msg: `R11 impact 为空` });
    }
    if (!it.action?.trim()) {
      issues.push({ level: "block", where: `insights[${i}]`, msg: `R11 action 为空` });
    }
    for (const t of it.tags ?? []) {
      if (!allowed.has(t)) {
        issues.push({ level: "block", where: `insights[${i}]`, msg: `R11 非法 tag「${t}」` });
      }
    }
  });
  return issues;
}

/** R12 hero_line（block）：存在且 15≤字数≤70。 */
function checkR12(report: DailyReport): Issue[] {
  const h = report.hero_line?.trim() ?? "";
  if (!h) {
    return [{ level: "block", where: "hero_line", msg: `R12 hero_line 缺失` }];
  }
  const n = charCount(h);
  if (n < 15 || n > 70) {
    return [
      { level: "block", where: "hero_line", msg: `R12 hero_line 字数 ${n}（需 15~70）` },
    ];
  }
  return [];
}

/** R13 外文标题翻译（warn）：title_cn 中连续拉丁单词 ≥4 个疑似未翻译。 */
function checkR13(report: DailyReport): Issue[] {
  const issues: Issue[] = [];
  for (const { item } of allItems(report)) {
    const latinRuns = (item.title_cn.match(/[A-Za-z]{3,}/g) ?? []).length;
    if (latinRuns >= 4) {
      issues.push({
        level: "warn",
        where: itemWhere(item),
        msg: `R13 外文标题翻译：title_cn 疑似未翻译（连续拉丁词 ${latinRuns} 个）`,
      });
    }
  }
  return issues;
}

/** must_read 引用完整性（block）：每个 url 必须在成稿条目中。 */
function checkMustRead(report: DailyReport): Issue[] {
  const issues: Issue[] = [];
  const urls = new Set(allItems(report).map((x) => x.item.url));
  for (const m of report.must_read ?? []) {
    if (m.url && !urls.has(m.url)) {
      issues.push({
        level: "block",
        where: `must_read:${m.url}`,
        msg: `must_read 引用完整性：url 不在成稿条目中`,
      });
    }
  }
  return issues;
}

/**
 * 运行全部 13 条规则 + must_read 引用完整性。
 * @param report 待校验报告（Item 可携带临时 `_sec` 字段，校验器忽略它）
 * @param pool 输入池（url → {raw_text}），供 R1/R2/R8 比对
 */
export function validateReport(report: DailyReport, pool: ValidationPool): Issue[] {
  const issues: Issue[] = [
    ...checkR1(report, pool),
    ...checkR2R3(report, pool),
    ...checkR4(report),
    ...checkR5(report),
    ...checkR6(report),
    ...checkR7(report),
    ...checkR8(report, pool),
    ...checkR9(report),
    ...checkR10(report),
    ...checkR11(report),
    ...checkR12(report),
    ...checkR13(report),
    ...checkMustRead(report),
  ];
  return issues;
}
