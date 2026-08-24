/**
 * TTS（2026-08-24 改用 Piper 本地合成）：替代原 edge-tts。
 *
 *  - 原 edge-tts 走微软免费网关，对云服务器 IP（GitHub runner / 本会话沙箱）返 403，
 *    导致 CI 无法合成语音。Piper 为本地 onnx 模型，不依赖任何外部 TTS 网关，云 IP 可用。
 *  - 语音：zh_CN-huayan-medium（新闻播报风女声）。
 *  - 流程：piper CLI 文本 → WAV（--length-scale 1.1 略放慢增自然度）→ ffmpeg WAV → MP3
 *    （与旧 edge-tts 产物格式一致，播放器 src 不变）。
 *  - 输出：data/history/reports/<date>/audio/briefing-<date>.mp3
 *    （build-site 会随日期目录整体拷贝到 daily_reports/<date>/audio/）。
 *  - 模型缓存：~/.cache/piper（首次 curl 从 HuggingFace 下载；CI 用 actions/cache 复用，
 *    避免每次重建下载 ~50MB）。
 *  - 失败策略（用户约定）：3 次重试后仍失败则抛错，由调用方 catch 降级
 *    （打 warning、页面不出播放器、不阻断发布）。
 *  - SKIP_TTS 模式下调用方不会进入本函数。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const VOICE = "zh_CN-huayan-medium";
const LENGTH_SCALE = "1.1";
const MAX_RETRY = 3;
const MIN_BYTES = 10_000; // 异常偏小校验（空音频防护）
/** 中文 medium 模型应 >10MB，偏小说明下载到 404 错误页 */
const MIN_MODEL_BYTES = 10_000_000;

const MODEL_DIR = path.join(process.env.HOME || os.tmpdir(), ".cache", "piper");
const BASE_URL =
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium";

export interface TtsResult {
  mp3Path: string;
  /** 估算时长（秒）；避免引入 mp3 解析依赖，使用字数估算 */
  durationSec: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 下载模型到缓存目录（若不存在），返回 (model_path, config_path)。 */
function ensureModel(): { model: string; config: string } {
  const model = path.join(MODEL_DIR, `${VOICE}.onnx`);
  const config = path.join(MODEL_DIR, `${VOICE}.onnx.json`);

  if (fs.existsSync(model) && fs.existsSync(config)) return { model, config };

  console.log(`⏬ 首次下载 Piper 模型到 ${MODEL_DIR} ...`);
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const dl = (file: string, url: string) => {
    // --connect-timeout 20：连不上（如沙箱/CI 网络受限）快速失败；
    // --max-time 240：50MB 模型在良好网络下足够，超时则降级（不阻断发布）。
    const r = spawnSync(
      "curl",
      ["-sfL", "--connect-timeout", "20", "--max-time", "240", "-o", file, url],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw new Error(`下载 Piper 模型失败（exit ${r.status}）：${url}`);
  };
  dl(model, `${BASE_URL}/${VOICE}.onnx`);
  dl(config, `${BASE_URL}/${VOICE}.onnx.json`);

  // 校验模型文件不是错误页
  if (fs.statSync(model).size < MIN_MODEL_BYTES) {
    fs.rmSync(model, { force: true });
    fs.rmSync(config, { force: true });
    throw new Error("下载的模型文件异常偏小，可能是 404 错误页");
  }
  return { model, config };
}

/** piper 文本→WAV，再 ffmpeg WAV→MP3。 */
function synthPiper(text: string, outPath: string): void {
  const { model, config } = ensureModel();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "piper-"));
  const wav = path.join(tmpDir, "out.wav");

  const p = spawnSync(
    "piper",
    ["--model", model, "--config", config, "--output_file", wav, "--length-scale", LENGTH_SCALE],
    { input: Buffer.from(text, "utf-8"), maxBuffer: 64 * 1024 * 1024 },
  );
  if (p.status !== 0) {
    const err = (p.stderr || Buffer.alloc(0)).toString().slice(0, 300);
    throw new Error(`piper 合成失败（exit ${p.status}）：${err}`);
  }

  const f = spawnSync("ffmpeg", ["-y", "-i", wav, "-codec:a", "libmp3lame", "-q:a", "4", outPath]);
  if (f.status !== 0) {
    const err = (f.stderr || Buffer.alloc(0)).toString().slice(0, 300);
    throw new Error(`ffmpeg 转码失败（exit ${f.status}）：${err}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

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
      synthPiper(script, out);
      const size = fs.statSync(out).size;
      if (size < MIN_BYTES) throw new Error(`音频异常偏小：${size} bytes`);
      const durationSec = Math.max(1, Math.round(script.length / 4.6));
      console.log(`✅ TTS 成功（Piper ${VOICE}）：${out}（${size} bytes，估算≈${durationSec}s）`);
      return { mp3Path: out, durationSec };
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ 第 ${attempt}/${MAX_RETRY} 次 TTS 失败：${e instanceof Error ? e.message : e}`);
      if (attempt < MAX_RETRY) await sleep(3000 * attempt);
    }
  }
  throw new Error(`TTS 连续失败 ${MAX_RETRY} 次：${lastErr instanceof Error ? lastErr.message : lastErr}`);
}
