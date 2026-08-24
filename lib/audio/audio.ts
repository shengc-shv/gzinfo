/**
 * 语音播报（2026-08-24 新增）：执行摘要口播稿 → 拼接 → TTS → mp3。
 *
 * 设计要点（与用户约定一致）：
 *  - 口播稿由 lib/ai/executive-summary.ts 在同一次 LLM 调用中融合产出
 *    （spoken_hero / spoken_must_read / spoken_insights / guangdong_ipo），
 *    随 history/<date>/store.json 持久化，SKIP_AI 重跑也能复用（不重算 LLM）。
 *  - 本章节只负责「拼装 + 消毒 + 句界截断 + 广东IPO兜底 + TTS」，不调用 LLM 生成图文。
 *  - 任何失败均不阻断发布：上游缺失则打 warning 降级（页面不出播放器），不抛非零退出。
 */

import fs from "node:fs";
import path from "node:path";

import { runLlm } from "../ai/llm";
import { aiEnabled } from "../ai/mode";
import type { ExecutiveSummary } from "../ai/executive-summary";
import type { ReportItem } from "../types";

/** 播放器元数据：renderHtml 注入 sticky 播放器时使用。 */
export interface AudioMeta {
  /** 相对路径（报告同级 audio/ 目录），build-site 会按日期目录整体拷贝到发布目录 */
  src: string;
  /** 展示用时长文案（如「约 2 分 0 秒」） */
  duration: string;
  /** 合成后端：tencent=腾讯云合成，piper=开源 Piper 本地合成；缺省为占位（未实际合成） */
  backend?: "tencent" | "piper";
}

/** 各章节口播字数上限（2026-08-24 用户拍板：口播要"事件+应对建议"，总时长约 2 分钟 → 总字数 ~600）。 */
export const AUDIO_SPEAK_LIMITS = {
  hero: 80,
  must_read: 300,
  insights: 250,
  ipo: 60,
} as const;

const OPENER = "早上好，以下是今日简报。";
const CLOSER = "详细内容请查看下方图文。";
const IPO_TRANSITION = "另外，关注一条广东IPO企业动态。";
/** 中文 TTS 语速估算（字/秒）：腾讯 Speed=1（1.2 倍）实测约 5.3 字/秒，取 5.2 便于徽标时长贴近实际（2026-08-24 校准）。 */
const CHARS_PER_SEC = 5.2;

export interface AudioBuildResult {
  /** 拼装后的完整口播稿（纯文本，≤630 字） */
  script: string;
  /** 各语块（用于调试 / 复用 / audio_parts.json） */
  parts: Record<string, string>;
  /** 估算音频时长（秒） */
  durationSec: number;
}

/** 去除 URL / Markdown / 链接 / 易碎符号，保留可朗读纯文本。 */
function sanitize(t: string): string {
  if (!t) return "";
  let s = t;
  s = s.replace(/https?:\/\/\S+/g, ""); // 链接
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // markdown 链接 → 文字
  s = s.replace(/[#*_`~>|]/g, ""); // 易碎符号
  s = s.replace(/^\s*[-+\d.、]\s*/gm, ""); // 列表前缀
  s = s.replace(/\n{2,}/g, "\n").trim();
  // 清理句界粘连（如「客户。；第二」「A，。B」）避免断句符号叠加
  s = s.replace(/([。！？])[；;]/g, "$1");
  s = s.replace(/[；;]([。！？])/g, "$1");
  s = s.replace(/，。/g, "。");
  s = s.replace(/。，/g, "，");
  return s;
}

/** 在句界（。！？；）截断到 limit 内，避免字数超限时断在半句。 */
function truncateAtSentence(text: string, limit: number): string {
  const hard = Math.round(limit * 1.05);
  if (text.length <= hard) return text;
  const cut = text.slice(0, hard);
  for (let i = cut.length - 1; i >= 0; i--) {
    if ("。！？；".includes(cut[i])) return cut.slice(0, i + 1);
  }
  return cut;
}

export function estimateDurationSec(chars: number): number {
  return Math.max(1, Math.round(chars / CHARS_PER_SEC));
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `约 ${secs} 秒`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `约 ${m} 分 ${s} 秒`;
}

const GD = /广东|广州/;
const IPO_KW = /IPO|上市|过会|申购|招股|注册生效|敲钟|递表/i;

/** 从 IPO 板块条目里挑出「广东/广州企业 + IPO 进展」的线索（兜底用）。 */
function detectGdIpo(ipoItems: ReportItem[]): string[] {
  const out: string[] = [];
  for (const it of ipoItems) {
    const plain = `${it.title_cn || ""} ${it.summary || ""}`.trim();
    if (plain && GD.test(plain) && IPO_KW.test(plain)) {
      out.push(plain.slice(0, 200));
      if (out.length >= 5) break;
    }
  }
  return out;
}

/** 上游未产出广东IP口播稿但线索存在时的 LLM 兜底（仅非 SKIP_AI 触发）。 */
async function fallbackGdIpo(clues: string[]): Promise<string | null> {
  if (!aiEnabled()) {
    console.warn("::warning:: 上游未产出广东IPO口播稿且 SKIP_AI，无法兜底生成，跳过该语块");
    return null;
  }
  try {
    const { text } = await runLlm(
      {
        systemPrompt:
          "你是中文新闻播报员。只输出纯口播文本：无 Markdown、无 URL、无 emoji，不超60字，直接输出正文。",
        userPrompt:
          "以下是今日简报中与广东IPO相关的原文片段。请改写为不超过60字的中文口播稿：说清企业名称、上市板块与最新进展，一两句话即可，不要念链接。\n\n" +
          clues.join("\n"),
        timeoutMs: 60_000,
      },
      { stage: "executive" },
    );
    const t = text.trim();
    return t.length >= 8 ? t : null;
  } catch {
    console.warn("::warning:: 广东IPO兜底生成失败，跳过该语块");
    return null;
  }
}

/**
 * 拼装口播稿：读已持久化的执行摘要 → 校验 → 消毒/句界截断 → 广东IPO兜底 →
 * 固定顺序拼接 → 落盘 audio_script.txt + audio_parts.json。
 *
 * @param date       报告日期 YYYY-MM-DD
 * @param exec       history/<date>/store.json 中的执行摘要（含 spoken_*）
 * @param ipoItems   当日 IPO 板块条目（ReportItem[]），用于广东IPO兜底检测
 * @returns 拼装结果；三章节口播全缺时返回 null（由调用方降级不显示播放器）
 */
export async function assembleAudioScript(
  date: string,
  exec: ExecutiveSummary,
  ipoItems: ReportItem[] = [],
): Promise<AudioBuildResult | null> {
  const parts: string[] = [OPENER];
  const partMap: Record<string, string> = {};
  let found = 0;

  const hero = sanitize(exec.spoken_hero ?? "");
  if (hero) {
    const t = truncateAtSentence(hero, AUDIO_SPEAK_LIMITS.hero);
    parts.push(`先看今日定调。${t}`);
    partMap.hero = t;
    found++;
  } else {
    console.warn("⚠️ 章节「今日定调」无口播稿，跳过");
  }

  const mr = sanitize(exec.spoken_must_read ?? "");
  if (mr) {
    const t = truncateAtSentence(mr, AUDIO_SPEAK_LIMITS.must_read);
    parts.push(`今日必读。${t}`);
    partMap.must_read = t;
    found++;
  } else {
    console.warn("⚠️ 章节「今日必读」无口播稿，跳过");
  }

  const ins = sanitize(exec.spoken_insights ?? "");
  if (ins) {
    const t = truncateAtSentence(ins, AUDIO_SPEAK_LIMITS.insights);
    parts.push(`最后是商机洞察。${t}`);
    partMap.insights = t;
    found++;
  } else {
    console.warn("⚠️ 章节「商机洞察」无口播稿，跳过");
  }

  if (found === 0) {
    console.warn("⚠️ 三个章节口播稿全部缺失，无法生成语音播报（降级：页面不出播放器）");
    return null;
  }

  // —— 广东 IPO：上游优先，正则兜底 ——
  let ipo = exec.guangdong_ipo?.spoken ? sanitize(exec.guangdong_ipo.spoken) : "";
  if (ipo) {
    console.log("✅ 广东IPO条目：取上游产出");
  } else {
    const clues = detectGdIpo(ipoItems);
    if (clues.length) {
      console.warn("::warning:: 上游未产出广东IPO口播稿，但检测到相关线索，触发兜底生成");
      const fb = await fallbackGdIpo(clues);
      if (fb) {
        ipo = sanitize(fb);
        console.log("✅ 广东IPO条目：兜底生成成功");
      }
    }
  }
  if (ipo) {
    // 兜底/上游口播稿若已自带「另外，关注…广东IPO…」过渡语，先剥离避免与固定过渡语重复。
    // 上游两种写法都兼容：「另外关注广东IPO：…」「另外，关注一条广东IPO企业动态。…」
    // （2026-08-24 修复：原正则要求「另外」后必须带逗号，上游无逗号写法不匹配 → 叠加念两次 IPO）
    ipo = ipo
      .replace(/^(?:另外[，,]?\s*)?(?:关注(?:一条)?)?广东IP[ＯO]?[^。：:]*[。：:]?\s*/, "")
      .trim();
    ipo = truncateAtSentence(ipo, AUDIO_SPEAK_LIMITS.ipo);
    parts.push(`${IPO_TRANSITION}${ipo}`);
    partMap.guangdong_ipo = ipo;
  }

  parts.push(CLOSER);
  const script = parts.join("\n");
  const durationSec = estimateDurationSec(script.length);

  if (script.length > 750) {
    console.warn(`::warning:: 口播稿 ${script.length} 字，超出 700 字目标`);
  }
  if (durationSec < 60 || durationSec > 150) {
    console.warn(`::warning:: 估算音频时长 ${durationSec}s 超出 75~150s 目标窗口，请检查口播稿字数`);
  }

  // 落盘：与报告同目录（build-site 会整体拷贝到发布目录）
  const dir = path.resolve(process.cwd(), "data", "history", "reports", date);
  if (fs.existsSync(dir)) {
    fs.writeFileSync(path.join(dir, "audio_script.txt"), script, "utf8");
    fs.writeFileSync(
      path.join(dir, "audio_parts.json"),
      JSON.stringify(
        {
          date,
          parts: partMap,
          order: ["hero", "must_read", "insights", ...(ipo ? ["guangdong_ipo"] : [])],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  console.log(
    `✅ 口播稿拼装完毕：${script.length} 字，${found}/3 章节，广东IPO=${ipo ? "有" : "无"}，估算时长≈${durationSec}s`,
  );
  return { script, parts: partMap, durationSec };
}
