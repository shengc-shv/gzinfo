/**
 * 语音播报（PR5）。
 *
 * 读已持久化执行摘要（含 spoken_*）→ 拼装口播稿 → 生成 mp3；
 * SKIP_TTS 时跳过实际合成（仅开源 Piper 兜底路径），但仍在页面注入播放器占位；
 * 腾讯云为包月资源、流量不限 skip，配置了密钥则【始终实际合成】（忽略 SKIP_TTS）。
 * 任何失败均不阻断发布（打 warn 继续，失败/缺失时页面不显示播放器）。
 *
 * 口播稿随 store.json 持久化，故 SKIP_AI 重跑也能复用、照常出语音（决策 #3）。
 */

import { loadStore } from "../ai/executive-summary";
import { loadStockRecap } from "../ai/stock-recap";
import { assembleAudioScript, formatDuration, type AudioMeta } from "../audio/audio";
import { synthesizeAudio } from "../audio/tts";
import type { DailyReport } from "../types";
import type { DailyContext } from "./context";

/**
 * 合成语音播报。返回 AudioMeta（注入 HTML 渲染）；失败/缺失返回 undefined（页面不出播放器）。
 */
export async function synthesizeAudioIfAny(
  report: DailyReport,
  ctx: DailyContext,
): Promise<AudioMeta | undefined> {
  const date = ctx.date;
  // 2026-08-28 用户需求：audio 开关（AUDIO_ENABLED=false 跳过 TTS 成本）
  if (process.env.AUDIO_ENABLED === "false") {
    ctx.log.info("audio", "AUDIO_ENABLED=false：跳过音频合成（页面不出播放器）");
    return undefined;
  }
  try {
    const execAudio = loadStore(date);
    if (!execAudio) {
      ctx.log.warn("audio", "⚠️ 无执行摘要（store.json 缺失），跳过语音播报生成");
      return undefined;
    }
    const stockAudio = loadStockRecap(date);
    const built = await assembleAudioScript(
      date,
      execAudio,
      report.sections.ipo ?? [],
      stockAudio,
    );
    if (!built) return undefined;

    // 腾讯云包月：配置密钥即忽略 SKIP_TTS，每次都实际合成
    const hasTencent = !!(
      process.env.TENCENTCLOUD_SECRET_ID && process.env.TENCENTCLOUD_SECRET_KEY
    );
    if (process.env.SKIP_TTS === "true" && !hasTencent) {
      ctx.log.info(
        "audio",
        "SKIP_TTS：跳过实际音频合成（开源兜底路径，注入播放器占位，无后端标记）",
      );
      return {
        src: `audio/briefing-${date}.mp3`,
        duration: formatDuration(built.durationSec),
        // v2 段落：供 HTML timeupdate 联动高亮
        segments: built.segments,
      };
    }
    try {
      const tts = await synthesizeAudio(date, built.script);
      ctx.log.info(
        "audio",
        `✅ 语音播报合成完成（后端：${tts.backend === "tencent" ? "腾讯云" : "开源 Piper"}）`,
      );
      return {
        src: `audio/briefing-${date}.mp3`,
        duration: formatDuration(tts.durationSec),
        backend: tts.backend,
        segments: built.segments,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log.warn("audio", `⚠️ TTS 合成失败（不阻断发布，页面不出播放器）: ${msg}`);
      return undefined;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log.warn("audio", `⚠️ 语音播报生成失败（不阻断发布）: ${msg}`);
    return undefined;
  }
}
