/**
 * 口播发音规范化（2026-09-10 新增）
 *
 * 要解决的问题：腾讯云 TTS 会把「AUM」当成一个词连读（听感类似 /aʊm/），
 * 领导听到的不是「A · U · M」三个字母。
 *
 * 已有做法为什么没生效（**2026-09-10 实证**）：
 *   - 09-09 上线了 `SEG_SPEAK_LABEL`：口播把客群短标签写成「零售 A U M」（空格拆分）。
 *   - 09-10 今早实际送进 TTS 的 store.executive.spoken_insights 原文为
 *     「具备零售 A U M商机的，……」——**空格确实写进去了，但腾讯云仍按缩写连读**。
 *   - 同一句里还残留一处**裸连写**「可提升个人零售AUM」（来自 insights[].impact 正文，
 *     未过短标签映射）——说明「在业务文本里逐处替换」这个路子覆盖面天然不全。
 *
 * 因此本模块把改写**统一挪到「送 TTS 之前」的边界上**（见 `tts.ts` 的 `synthTencent`），
 * 一次覆盖全稿（hero / must_read / insights / risk / IPO / 股市），与上游模板解耦。
 *
 * 权威依据（腾讯云官方 SSML 文档，https://www.tencentcloud.com/zh/document/product/1154/47883）：
 *   - 「腾讯云语音合成服务的 SSML 实现，基于 W3C 的语音合成标记语言版本 1.1」
 *   - 「目前只有中文合成支持 SSML 功能」（本行音色为中文精品女声，符合）
 *   - `<say-as interpret-as="characters">`：「将标签内的文本按字符一一读出」，
 *     示例 `ISO 1-001-095498-1` → `I S O 一 杠 零 零 一 ……`，
 *     说明：「输出的空格表示每个字符之间插入停顿，即字符一个一个地读」
 *   - 约束：SSML 标签必须包在 `<speak></speak>` 内；`<speak>` 只认
 *     `<break> / <phoneme> / <say-as> / <sub>`；**未定义标签内的文本不会被合成**，
 *     XML 格式错误可能导致该 `<speak>` 停止合成 → 故本模块对非标签文本做 XML 转义。
 *
 * 模式说明见 `PronounceMode`。生产默认 `asis`（= 与上线前行为完全一致，零风险），
 * 待试听确认后把 `tts.ts` 的默认模式改成胜出项即可。
 */

/** 发音改写策略。 */
export type PronounceMode =
  /** 原样透传（线上现状：可能是上游已拆的「A U M」，也可能是裸连写「AUM」）。 */
  | "asis"
  /** 归一为连写「AUM」（对照组②，理论上仍会被连读）。 */
  | "plain"
  /** 「A、U、M」——用顿号强制制造停顿。 */
  | "punct"
  /** 「A·U·M」——用间隔号。 */
  | "interpunct"
  /** 「诶优艾姆」——汉字音译，任何 TTS 后端（含 Piper 兜底）都必然逐字读。 */
  | "translit"
  /** SSML：`<say-as interpret-as="characters">AUM</say-as>`（官方文档明确逐字符读）。 */
  | "ssml-say-as"
  /** SSML：`<sub alias="诶优艾姆">AUM</sub>`（别名替换）。 */
  | "ssml-sub";

/** 全部可选模式（供试听脚本 / 配置校验枚举）。 */
export const PRONOUNCE_MODES: readonly PronounceMode[] = [
  "asis",
  "plain",
  "punct",
  "interpunct",
  "translit",
  "ssml-say-as",
  "ssml-sub",
] as const;

/** 需要 `<speak>` 包裹的 SSML 模式。 */
export const SSML_MODES: ReadonlySet<PronounceMode> = new Set<PronounceMode>([
  "ssml-say-as",
  "ssml-sub",
]);

/** 该模式产出的是否为 SSML（送 TTS 前必须整体包 `<speak>`）。 */
export function isSsmlMode(mode: PronounceMode): boolean {
  return SSML_MODES.has(mode);
}

/** 是否是可识别的模式（防 env 写错值静默走 asis）。 */
export function isPronounceMode(v: string): v is PronounceMode {
  return (PRONOUNCE_MODES as readonly string[]).includes(v);
}

interface PronounceEntry {
  /** 缩写规范形（大写）。 */
  abbr: string;
  /** 逐字母。 */
  letters: string[];
  /** 汉字音译（`translit` / `ssml-sub` 的 alias 用）。 */
  translit: string;
}

/**
 * 发音词典。当前只有 AUM（用户 2026-09-10 反馈项）；
 * 新增条目只需在此追加一行，改写与模式渲染逻辑通用。
 */
export const PRONOUNCE_ENTRIES: readonly PronounceEntry[] = [
  { abbr: "AUM", letters: ["A", "U", "M"], translit: "诶优艾姆" },
] as const;

/** 缩写内部允许出现、且应被归一掉的分隔符（半/全角顿号、间隔号、逗号、点、连字符、空白）。 */
const SEP_CLASS = "[\\s\\u3000·・、,，．.。\\-—_]*";

/**
 * 构造单个缩写的「宽松匹配」正则：`A U M` / `A、U、M` / `A·U·M` / `AUM` 一律命中；
 * 前后用 lookaround 卡住拉丁字母，避免误伤 `AUMs`、`MAUM` 之类的更长 token。
 */
function looseRe(letters: string[]): RegExp {
  const body = letters.join(`${SEP_CLASS}`);
  return new RegExp(`(?<![A-Za-z])${body}(?![A-Za-z])`, "gi");
}

/** 缩写 → 宽松正则（模块加载时构建一次）。 */
const ENTRY_RES: { entry: PronounceEntry; re: RegExp; strictRe: RegExp }[] =
  PRONOUNCE_ENTRIES.map((entry) => ({
    entry,
    re: looseRe(entry.letters),
    // 归一之后缩写已是规范形，渲染时用严格边界匹配即可（避免二次宽松匹配误伤）
    strictRe: new RegExp(`(?<![A-Za-z])${entry.abbr}(?![A-Za-z])`, "g"),
  }));

/**
 * 归一：把任意分隔写法（`A U M` / `A、U、M` / `aum`）统一为规范连写 `AUM`，
 * 并顺手消掉**中文字与缩写之间的空白**（上游 `SEG_SPEAK_LABEL` 的「零售 A U M」
 * 会在「售」与「A」之间留一个空格，不清理会读成「零售…」后多一个停顿）。
 */
export function canonicalizeAbbr(text: string): string {
  let out = text;
  for (const { entry, re } of ENTRY_RES) {
    out = out.replace(re, entry.abbr);
    // 仅当缩写紧跟在汉字之后（中间只隔空白/间隔号）才吃掉分隔，避免误伤英文句子
    out = out.replace(
      new RegExp(`([\\u4e00-\\u9fff])${SEP_CLASS}${entry.abbr}`, "g"),
      `$1${entry.abbr}`,
    );
  }
  return out;
}

/** XML 特殊字符转义（腾讯云文档要求：`&` `<` `>` 需转义，否则可能中断合成）。 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 按模式生成单个缩写的替换片段。 */
function renderEntry(entry: PronounceEntry, mode: PronounceMode): string {
  switch (mode) {
    case "punct":
      return entry.letters.join("、");
    case "interpunct":
      return entry.letters.join("·");
    case "translit":
      return entry.translit;
    case "ssml-say-as":
      return `<say-as interpret-as="characters">${entry.abbr}</say-as>`;
    case "ssml-sub":
      return `<sub alias="${entry.translit}">${entry.abbr}</sub>`;
    case "plain":
    case "asis":
    default:
      return entry.abbr;
  }
}

/**
 * 把一段文本改写为「送 TTS 的发音文本」。
 *
 * - `asis`：原样返回（零改动，线上现状）。
 * - 纯文本模式（plain/punct/interpunct/translit）：返回可直接朗读的纯文本。
 * - SSML 模式：返回**已包 `<speak>`、且非标签文本已 XML 转义**的完整片段。
 *   调用方须保证**先按标点分片、再逐片调用本函数**，避免标签被分片截断。
 */
export function toSpeechText(text: string, mode: PronounceMode): string {
  if (!text) return "";
  if (mode === "asis") return text;

  // 先归一到规范形（吃掉上游冗余分隔、消掉中文字与缩写间的空格），再渲染，
  // 保证「上游已拆的 A U M」与「裸连写的 AUM」最终送出完全一致的文本。
  const canon = canonicalizeAbbr(text);

  // 先占位、后转义、再回填：避免转义（如 `&` → `&amp;`）污染缩写匹配，
  // 也避免替换片段里的 `<` `>` 被二次转义。
  const frags: string[] = [];
  let body = canon;
  for (const { entry, strictRe } of ENTRY_RES) {
    const frag = renderEntry(entry, mode);
    body = body.replace(strictRe, () => {
      frags.push(frag);
      return `\u0000${frags.length - 1}\u0000`;
    });
  }

  if (isSsmlMode(mode)) {
    body = escapeXml(body);
  }

  body = body.replace(/\u0000(\d+)\u0000/g, (_, i: string) => frags[Number(i)] ?? "");

  return isSsmlMode(mode) ? `<speak>${body}</speak>` : body;
}
