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
import type { ReportItem, StockRecap } from "../types";
// 2026-08-30：广东 IPO 判定统一走渲染侧内容判定（阶段强词 + 名单三层识别），
// 避免播报与卡片两套正则口径漂移（实例：粤芯「注册申请材料已受理」曾因 IPO_KW 缺词漏捞）。
import { isGdIpoCandidate } from "../output/render/cards";
// 2026-08-30：股市口播按市场注入时区+日期（美股=美东 / A股港股=北京），复用统一日期格式避免漂移。
import { formatCnDate } from "../pipeline/side-outputs/stock-recap";

/** 播放器元数据：renderHtml 注入 sticky 播放器时使用。 */
export interface AudioMeta {
  /** 相对路径（报告同级 audio/ 目录），build-site 会按日期目录整体拷贝到发布目录 */
  src: string;
  /** 展示用时长文案（如「约 2 分 0 秒」） */
  duration: string;
  /** 合成后端：tencent=腾讯云合成，piper=开源 Piper 本地合成；缺省为占位（未实际合成） */
  backend?: "tencent" | "piper";
  /** v2 段落信息（I-A 实施）：用于 HTML timeupdate 联动高亮 */
  segments?: AudioSegment[];
}

/** 音频段落（P0-A v2）：与 HTML 卡片 data-audio-ref 一一对应，timeupdate 驱动高亮。 */
export interface AudioSegment {
  /** 段落 ID（与 HTML 卡片 data-audio-ref 匹配）：
   *  - "intro" / "closing" 全局段
   *  - "hero" 今日定调
   *  - "must:0" "must:1" "must:2" 各条 must_read
   *  - "insight:0" "insight:1" 各条 insight
   *  - "stock" 股市一句话
   */
  id: string;
  /** 段落在脚本中的起止秒（估算），用于 timeupdate 定位 */
  startSec: number;
  durationSec: number;
  /** 该段提到的文章 URL 列表（供关联卡片的 data-audio-ref） */
  refs: string[];
  /** 段落纯文本（调试用） */
  text: string;
}

/** 各章节口播字数上限（2026-08-25 用户拍板：股市解读入口播 + 总时长 ≤3 分钟 → 全稿 ≤~900 字）。
 *  重平衡：必读/洞察适度压缩腾出股市解读段（正文上限合计 830 + 过场语 ~65 ≈ 895 字 ≈ 2.9 分钟）。
 *  v2（I-A）：hero 上调以容纳"早上好" + 整段定调；insights 略减让位给可能的 ipo 段。 */
export const AUDIO_SPEAK_LIMITS = {
  hero: 90,
  must_read: 280,
  insights: 200,
  ipo: 50,
  stock: 220,
} as const;

// v2（I-A 用户要求）：去掉"行长"等称呼；最后用"今天播报结束"作为收尾，不下命令。
const OPENER = "早上好。";
const CLOSER = "今天播报结束。";
const IPO_TRANSITION = "接下去关注广东IPO企业动态。";
/** 股市解读段：语气与「今日必读」同风格（客观、精炼、陈述式），过场语与必读/洞察并列。 */
const STOCK_TRANSITION = "接下去是股市解读。";
/** 中文 TTS 语速估算（字/秒）：腾讯 Speed=1（1.2 倍）实测约 5.3 字/秒，取 5.2 便于徽标时长贴近实际（2026-08-24 校准）。 */
const CHARS_PER_SEC = 5.2;

export interface AudioBuildResult {
  /** 拼装后的完整口播稿（纯文本，≤~900 字 ≈ 3 分钟） */
  script: string;
  /** 各语块（用于调试 / 复用 / audio_parts.json） */
  parts: Record<string, string>;
  /** 估算音频时长（秒） */
  durationSec: number;
  /** v2 段落数组（用于 HTML 联动） */
  segments: AudioSegment[];
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

/**
 * 从 IPO 板块条目里挑出「广东/广州企业 + IPO 进展」的线索（兜底用）。
 * 2026-08-30 升级：广东企业判定从「标题含广东/广州字样」升级为名单三层识别
 * （企业名/别名/城市，见 lib/sources/guangdong-registry.json）——
 * 「粤芯半导体：注册申请材料已受理」这类标题无地域字样的广东企业不再漏掉。
 * 判定复用渲染侧 isGdIpoCandidate（IPO_PROGRESS_RE + isGuangdongEnterprise），单一口径。
 */
export function detectGdIpo(ipoItems: ReportItem[]): string[] {
  const out: string[] = [];
  for (const it of ipoItems) {
    const title = it.title_cn || "";
    const summary = it.summary || "";
    if (isGdIpoCandidate(title, summary)) {
      out.push(`${title} ${summary}`.trim().slice(0, 200));
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
  stockRecap?: StockRecap | null,
): Promise<AudioBuildResult | null> {
  const parts: string[] = [OPENER];
  const partMap: Record<string, string> = {};
  const segments: AudioSegment[] = [];
  let found = 0;
  // 累计已用秒（用于 segment.startSec）
  let cursor = estimateDurationSec(OPENER.length);
  segments.push({
    id: "intro",
    startSec: 0,
    durationSec: cursor,
    refs: [],
    text: OPENER,
  });

  const hero = sanitize(exec.spoken_hero ?? "");
  if (hero) {
    const t = truncateAtSentence(hero, AUDIO_SPEAK_LIMITS.hero);
    const segText = `先看今日定调。${t}`;
    parts.push(segText);
    partMap.hero = t;
    const dur = estimateDurationSec(segText.length);
    segments.push({ id: "hero", startSec: cursor, durationSec: dur, refs: [], text: segText });
    cursor += dur;
    found++;
  } else {
    console.warn("⚠️ 章节「今日定调」无口播稿，跳过");
  }

  const mr = sanitize(exec.spoken_must_read ?? "");
  if (mr) {
    const t = truncateAtSentence(mr, AUDIO_SPEAK_LIMITS.must_read);
    const segText = `接下去看今日必读。${t}`;
    parts.push(segText);
    partMap.must_read = t;
    const dur = estimateDurationSec(segText.length);
    // 关联 must_read 各条 URL（按出现顺序匹配，过滤空 url）
    const mrUrls = (exec.must_read ?? []).map((m) => m.url ?? "").filter(Boolean);
    // 段落级 ref 用 "must" 标识（多张卡片通过 render 时 data-audio-ref="must:0/1/2" 区分）
    segments.push({
      id: "must",
      startSec: cursor,
      durationSec: dur,
      refs: mrUrls,
      text: segText,
    });
    cursor += dur;
    found++;
  } else {
    console.warn("⚠️ 章节「今日必读」无口播稿，跳过");
  }

  const ins = sanitize(exec.spoken_insights ?? "");
  if (ins) {
    const t = truncateAtSentence(ins, AUDIO_SPEAK_LIMITS.insights);
    const segText = `接下去是商机洞察。${t}`;
    parts.push(segText);
    partMap.insights = t;
    const dur = estimateDurationSec(segText.length);
    const insightUrls = (exec.insights ?? [])
      .flatMap((i) => (i.sources ?? []).map((s) => s.url))
      .filter(Boolean);
    segments.push({
      id: "insight",
      startSec: cursor,
      durationSec: dur,
      refs: insightUrls,
      text: segText,
    });
    cursor += dur;
    found++;
  } else {
    console.warn("⚠️ 章节「商机洞察」无口播稿，跳过");
  }

  // M 层：风险预警段（30s 预算；当日无风险 → 跳过）。插在商机后、股市前。
  const risk = sanitize(exec.spoken_risk ?? "");
  if (risk) {
    const t = truncateAtSentence(risk, 90);  // 上限 90 字（约 17s 朗读 + 13s 过场/停顿 ≈ 30s）
    const segText = `接下去是风险预警。${t}`;
    parts.push(segText);
    partMap.risk = t;
    const dur = estimateDurationSec(segText.length);
    const riskUrls = (exec.risk?.sources ?? []).map((s) => s.url).filter(Boolean);
    segments.push({
      id: "risk",
      startSec: cursor,
      durationSec: dur,
      refs: riskUrls,
      text: segText,
    });
    cursor += dur;
    found++;
  } else {
    console.warn("⚠️ 章节「风险预警」无口播稿，跳过");
  }

  if (found === 0) {
    console.warn("⚠️ 今日定调/必读/洞察/股市解读口播稿全部缺失，无法生成语音播报（降级：页面不出播放器）");
    return null;
  }

  // —— 广东 IPO：上游优先，正则兜底 ——
  // 2026-08-30 用户：IPO 播报放在「股市情况」之前（先讲本地商机，再讲行情）。
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
    const segText = `${IPO_TRANSITION}${ipo}`;
    parts.push(segText);
    partMap.guangdong_ipo = ipo;
    const dur = estimateDurationSec(segText.length);
    segments.push({ id: "ipo", startSec: cursor, durationSec: dur, refs: [], text: segText });
    cursor += dur;
  }

  // —— 昨日股市解读：三市场 spoken 拼接（若有）——
  // 排在广东IPO之后（2026-08-30 用户：IPO 播报放在股市情况之前）。
  // 2026-08-30 用户（tz）：美股标「美东时间」、A股/港股标「北京时间」；
  //   同时说清是「上个交易日 X月X日」收盘（听众所处时间不确定，只说"昨日"无法定位）。
  //   时区+日期按市场分别注入，避免一套笼统前缀（原 spokenNote）丢失时区差异。
  if (stockRecap) {
    const ms = stockRecap.marketStatus;
    const cnDate = ms?.dataDate ? formatCnDate(ms.dataDate) : "";
    const segs: string[] = [];
    const pushSeg = (label: string, tz: string, card: { spoken?: string }) => {
      const s = sanitize(card.spoken ?? "");
      if (!s) return;
      // 时区+上个交易日日期标注（缺 dataDate 时降级为无日期，旧 store.json 兼容）
      const tzLabel = cnDate ? `（${tz}时间${cnDate}收盘）` : "";
      let prefixed: string;
      if (s.startsWith(label)) {
        // spoken 已含市场名（如"美股三大指数…"），避免"美股（…）：美股"；
        // 把时区标注插在市场名后，并剥掉紧随的标点防双冒号。
        const rest = s.slice(label.length).replace(/^[\s：:，,、]+/, "");
        prefixed = `${label}${tzLabel}：${rest}`;
      } else {
        prefixed = `${label}${tzLabel}：${s}`;
      }
      // 去尾部句号：三市场以"。"join 拼接，避免段间双句号
      segs.push(truncateAtSentence(prefixed.replace(/[。.]+$/, ""), Math.floor(AUDIO_SPEAK_LIMITS.stock / 3)));
    };
    pushSeg("美股", "美东", stockRecap.us);
    pushSeg("A股", "北京", stockRecap.aShare);
    pushSeg("港股", "北京", stockRecap.hk);
    if (segs.length) {
      const combined = truncateAtSentence(segs.join("。"), AUDIO_SPEAK_LIMITS.stock);
      const segText = `${STOCK_TRANSITION}${combined}`;
      parts.push(segText);
      partMap.stock_recap = combined;
      const dur = estimateDurationSec(segText.length);
      segments.push({
        id: "stock",
        startSec: cursor,
        durationSec: dur,
        refs: [],
        text: segText,
      });
      cursor += dur;
      found++;
    } else {
      console.warn("⚠️ 章节「昨日股市解读」三市场口播稿均缺失，跳过");
    }
  }

  // v2（I-A）收尾："今天播报结束。" 取代原 CLOSER "详细内容请查看下方图文。"
  const closingText = CLOSER;
  parts.push(closingText);
  const closingDur = estimateDurationSec(closingText.length);
  segments.push({
    id: "closing",
    startSec: cursor,
    durationSec: closingDur,
    refs: [],
    text: closingText,
  });

  const script = parts.join("\n");
  const durationSec = estimateDurationSec(script.length);

  if (script.length > 900) {
    console.warn(`::warning:: 口播稿 ${script.length} 字，超出 900 字目标（约 3 分钟上限）`);
  }
  if (durationSec < 60 || durationSec > 180) {
    console.warn(`::warning:: 估算音频时长 ${durationSec}s 超出 60~180s 目标窗口（3 分钟上限），请检查口播稿字数`);
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
          // 2026-08-30 修正：与口播实际顺序一致（IPO 在股市之前），并补上原先遗漏的 stock_recap
          order: [
            "hero",
            "must_read",
            "insights",
            ...(risk ? ["risk"] : []),
            ...(ipo ? ["guangdong_ipo"] : []),
            ...(partMap.stock_recap ? ["stock_recap"] : []),
          ],
          // v2 段落（含 start/duration/refs，供 HTML 联动高亮）
          segments: segments.map((s) => ({ id: s.id, startSec: s.startSec, durationSec: s.durationSec, refs: s.refs })),
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  console.log(
    `✅ 口播稿拼装完毕：${script.length} 字，${parts.length - 2} 个内容段（定调/必读/洞察/IPO/股市解读），广东IPO=${ipo ? "有" : "无"}，估算时长≈${durationSec}s`,
  );
  return { script, parts: partMap, durationSec, segments };
}
