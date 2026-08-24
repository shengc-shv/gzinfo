/**
 * TTS（2026-08-24 新增）：edge-tts 生成简报 mp3。
 *
 *  - 语音：zh-CN-XiaoxiaoNeural；语速 +15%（≤600 字 ≈ 2 分钟）。
 *  - 输出：data/history/reports/<date>/audio/briefing-<date>.mp3
 *    （build-site 会随日期目录整体拷贝到 daily_reports/<date>/audio/）。
 *  - 失败策略（用户约定）：3 次重试后仍失败则抛错，由调用方 catch 降级
 *    （打 warning、页面不出播放器、不阻断发布）。
 *  - SKIP_TTS 模式下调用方不会进入本函数。
 */

import fs from "node:fs";
import path from "node:path";
import { ttsSave } from "edge-tts";

const VOICE = "zh-CN-XiaoxiaoNeural";
const RATE = "+15%";
const MAX_RETRY = 3;
const MIN_BYTES = 10_000; // 异常偏小校验（空音频防护）

export interface TtsResult {
  mp3Path: string;
  /** 估算时长（秒）；避免引入 mp3 解析依赖，使用字数估算 */
  durationSec: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function synthesizeAudio(date: string, script: string): Promise<TtsResult> {
  if (!script || script.trim().length < 20) {
    throw new Error(`口播稿过短（${script?.length ?? 0} 字），中止 TTS`);
  }
  const dir = path.resolve(process.cwd(), "data", "history", "reports", date, "audio");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `briefing-${date}.mp3`);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      await ttsSave(script, out, { voice: VOICE, rate: RATE });
      const size = fs.statSync(out).size;
      if (size < MIN_BYTES) throw new Error(`音频异常偏小：${size} bytes`);
      const durationSec = Math.max(1, Math.round(script.length / 4.6));
      console.log(`✅ TTS 成功：${out}（${size} bytes，估算≈${durationSec}s）`);
      return { mp3Path: out, durationSec };
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ 第 ${attempt}/${MAX_RETRY} 次 TTS 失败：${e instanceof Error ? e.message : e}`);
      if (attempt < MAX_RETRY) await sleep(3000 * attempt);
    }
  }
  throw new Error(`TTS 连续失败 ${MAX_RETRY} 次：${lastErr instanceof Error ? lastErr.message : lastErr}`);
}
