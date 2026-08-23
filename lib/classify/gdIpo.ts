/**
 * 广东地区IPO 三道闸分类器
 * --------------------------------
 * 管线：爬回（含巨潮/港交/境外源） → ①地域(是否广东) → ②类型(IPO类/上市事件/非IPO) → ③市场(深/沪/京/港/境外)
 *
 * 设计取舍（与用户确认）：
 *  - 地域信号优先用结构化字段：文章自带 `registeredProvince` / `stockCode` → 查广东发行人注册表；
 *    旧管线里 sourceId 以 `gd-` 开头的视为已预过滤为广东（兼容历史数据）；最后才用关键词兜底。
 *  - 类型过滤：仅「股权融资/上市相关」事件进广东IPO；纯财报/分红/并购/关联交易/诉讼等归财经要点。
 *  - 市场分发：预备上市（辅导/招股/过会/注册）统一进 `ipo-tutoring`（卡片内可标拟登陆地）；
 *    已/将上市且有股票代码的按代码前缀归 深/沪/京；港交源→hkex；境外源→overseas。
 */

export interface ClassifyArticle {
  title: string;
  excerpt?: string;
  url?: string;
  sourceId: string;
  source?: string;
  publishedAt?: Date;
  /** 爬虫可直接给出的结构化信号（可选） */
  stockCode?: string;
  registeredProvince?: string;
}

/** 广东发行人注册表：股票代码 → 是否广东（结构化，优先于关键词） */
export interface GdIssuerRegistry {
  /** 股票代码（6位） → { name, city } */
  byCode: Record<string, { name: string; city: string }>;
}

export type GdSub =
  | "szse"
  | "sse"
  | "bse"
  | "hkex"
  | "ipo-tutoring"
  | "overseas";

export type GdClassifyResult =
  | { action: "keep"; sub: GdSub }
  | { action: "finance" } // 广东公司但非IPO类 → 财经要点
  | { action: "drop" }; // 非广东 → 丢弃

// 交易所代码前缀
function exchangeOfCode(code: string): "szse" | "sse" | "bse" | null {
  if (/^(300|301|002|000|003)/.test(code)) return "szse"; // 创业板 / 深市主板 / 中小板
  if (/^(600|601|603|605|688|689)/.test(code)) return "sse"; // 沪市主板 / 科创板
  if (/^(8|4|92)/.test(code)) return "bse"; // 北交所
  return null;
}

// 类型关键词
const TUTORING_RE =
  /(辅导|备案|招股|过会|上市委|注册生效|询价|申购|路演|拟登陆|pre-?ipo|ipo)/i;
const EXCHANGE_EVENT_RE =
  /(限售|解禁|定增|增发|可转债|新股上市|上市公告|募资|配股|转板)/i;
const FINANCE_ONLY_RE =
  /(年报|季报|中报|财报|利润分配|分红派息|分红|并购|重组|关联交易|担保|诉讼|澄清|停牌|复牌|减持|增持|回购)/i;

const GD_REGION_KEYWORDS =
  /(广东|深圳|广州|珠海|佛山|东莞|中山|惠州|江门|肇庆|汕头|湛江|茂名|韶关|河源|梅州|清远|潮州|揭阳|云浮|南沙|前海)/;

const OVERSEAS_SOURCE_RE = /(techcrunch|eu-startups|crunchbase|overseas|境外|nasdaq|sgx)/i;
const HK_SOURCE_RE = /(hkex|hk|港交|港交所|hong\s*kong)/i;

/** 从文本中解析股票代码，如 "固高科技 (301510)" 或 "股票代码：301510" */
export function parseStockCode(text: string): string | null {
  const m = text.match(/(?:\(|码[：:]?\s*|股票代码[：:]?\s*)(\d{6})(?:\))?/);
  return m ? m[1] : null;
}

function isGuangdong(
  a: ClassifyArticle,
  registry?: GdIssuerRegistry,
): boolean {
  // 1) 爬虫直接给的结构化省份
  if (a.registeredProvince) {
    if (/^广东|^GD$|guangdong/i.test(a.registeredProvince)) return true;
    return false; // 明确给了其他省份 → 非广东
  }
  // 2) 股票代码查注册表（结构化）
  const code = a.stockCode ?? parseStockCode(`${a.title} ${a.excerpt || ""}`);
  if (code && registry?.byCode?.[code]) return true;
  // 3) 关键词兜底（非首选；2026-08-23 移除 sourceId gd- 前缀判定——
  //    前缀与实际覆盖范围脱节曾导致北交所全国公告被误判广东）
  const text = `${a.title} ${a.excerpt || ""} ${a.url || ""}`;
  return GD_REGION_KEYWORDS.test(text);
}

export function classifyGdIpo(
  a: ClassifyArticle,
  opts?: { gdIssuers?: GdIssuerRegistry },
): GdClassifyResult {
  const text = `${a.title} ${a.excerpt || ""} ${a.url || ""}`;
  const isGd = isGuangdong(a, opts?.gdIssuers);
  if (!isGd) return { action: "drop" };

  const isTutoring = TUTORING_RE.test(text) && !FINANCE_ONLY_RE.test(text);
  const isExchangeEvent = EXCHANGE_EVENT_RE.test(text);
  const isFinanceOnly =
    FINANCE_ONLY_RE.test(text) && !isTutoring && !isExchangeEvent;

  // 境外源：广东企业出海上市
  if (OVERSEAS_SOURCE_RE.test(a.sourceId)) {
    if (isTutoring) return { action: "keep", sub: "ipo-tutoring" };
    if (isFinanceOnly) return { action: "finance" };
    return { action: "keep", sub: "overseas" };
  }
  // 港交所源
  if (HK_SOURCE_RE.test(a.sourceId)) {
    if (isTutoring) return { action: "keep", sub: "ipo-tutoring" };
    if (isFinanceOnly) return { action: "finance" };
    return { action: "keep", sub: "hkex" };
  }

  // A 股：按股票代码定市场
  const code = a.stockCode ?? parseStockCode(text);
  if (code) {
    const ex = exchangeOfCode(code);
    if (ex) {
      if (isTutoring) return { action: "keep", sub: "ipo-tutoring" };
      if (isFinanceOnly) return { action: "finance" };
      return { action: "keep", sub: ex };
    }
  }

  // 无代码：预备上市类 → 辅导；其余非IPO → 财经
  if (isTutoring) return { action: "keep", sub: "ipo-tutoring" };
  if (isFinanceOnly) return { action: "finance" };
  // 既无代码又非明确类型：保守归财经（避免把无关公告塞进IPO）
  return { action: "finance" };
}

/**
 * 上市阶段推断（2026-08-21 任务二）：把广东 IPO 企业按「上市进度」归栏，
 * 对齐用户"看最近有哪些 IPO 企业（已上市）/ 最近有哪些准备 IPO 的企业（拟上市）"需求。
 *
 * 四阶段（展示顺序即进度由后往前）：
 *  - stage-listed     已上市·新股（打新/员工持股/股权激励理财商机）
 *  - stage-registered 注册生效·过会（即将发行，募资入账机构合作商机）
 *  - stage-reviewing  在审·已受理（Pre-IPO 授信/投贷联动储备商机）
 *  - stage-tutoring   辅导备案·Pre-IPO（最佳商机：Pre-IPO 授信/投贷联动/代发工资/高管私行/员工持股托管）
 *
 * 判定优先级：未上市信号（注册生效 > 过会/核准 > 在审/受理 > 辅导备案）先于「已上市」，
 * 避免"注册生效 即将上市"这类标题被误判为已上市；无阶段词兜底归 Pre-IPO（预备上市）。
 */
export type GdStage =
  | "stage-listed"
  | "stage-registered"
  | "stage-reviewing"
  | "stage-tutoring";

export function inferStage(title: string, excerpt?: string): GdStage {
  const text = `${title} ${excerpt || ""}`;
  // 1) 注册生效 / 同意注册 / 注册结果 / 注册批准 / 注册完成 / 注册通过（即将发行）
  if (/(注册生效|注册获准|同意注册|注册结果|注册批准|注册完成|注册通过)/.test(text))
    return "stage-registered";
  // 2) 过会 / 核准（注册前最后一步，接近发行）
  if (/(过会|核准)/.test(text)) return "stage-registered";
  // 3) 在审 / 已受理：受理 / 问询 / 上会 / 提交注册 / 审核 / 上市委 / 反馈意见 / 问询函 / 问询回复
  if (/(受理|问询|上会|提交注册|审核|上市委|反馈意见|问询函|问询回复)/.test(text))
    return "stage-reviewing";
  // 4) 辅导备案 / Pre-IPO：辅导备案 / 辅导验收 / IPO辅导 / 辅导机构 / 辅导协议 / 股份制改造 / 备案登记
  if (/(辅导备案|辅导验收|IPO辅导|辅导机构|辅导协议|股份制改造|备案登记|pre-?ipo)/i.test(text))
    return "stage-tutoring";
  // 5) 已上市信号（精准词，避免"拟上市/即将上市"误判）
  if (
    /(挂牌|上市公告|新股上市|发行结果|中签结果|敲钟|首日|上市交易|已上市|成功上市|正式上市|登陆(沪|深|京|港)交易所)/.test(
      text,
    )
  )
    return "stage-listed";
  // 6) 裸"上市"（无未上市信号）→ 默认已上市（多数语境即已上市）
  if (/上市/.test(text)) return "stage-listed";
  // 7) 完全无阶段词：预备上市兜底归 Pre-IPO
  return "stage-tutoring";
}
