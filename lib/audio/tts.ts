/**
 * TTS：腾讯云主用 + Piper 本地兜底（2026-08-24 重构）。
 *
 *  - 主用腾讯云语音合成（TTS）TextToVoice：免费资源包 800 万字符，精品女声。
 *    因腾讯 Node SDK 在运行时不导出请求模型类（Models 为空），此处手写
 *    TC3-HMAC-SHA256 签名 + 原生 fetch 调 REST API，零 SDK 依赖、完全可控。
 *  - 腾讯两个特有坑（已在代码内处理）：
 *    1) Text 参数必须 base64 编码后传入，直接传原文会报错；
 *    2) 单次请求上限约 150 字（GBK），口播稿 ~600 字须按句子分片合成，
 *       再用 ffmpeg concat 无缝拼接。
 *  - 编码坑（2026-08-24 实测根因）：腾讯后端收到 base64 解码后按 **GBK** 解读字节。
 *    若按 UTF-8 编码（Buffer.from(t,"utf-8")）再 base64，中文会被拆解成乱码音节，
 *    音频从第一个字开始就是乱码且时长膨胀 ~2.7 倍。必须用 iconv-lite 编码为 GBK
 *    后再 base64（Text 的「150 字（GBK）」上限即按 GBK 字节计）。
 *  - 兜底：腾讯连续失败（3 次重试）自动切换 Piper 本地 onnx 合成，
 *    云 IP 不依赖任何外部 TTS 网关。
 *  - 输出：data/history/reports/<date>/audio/briefing-<date>.mp3
 *    （build-site 随日期目录整体拷贝到 daily_reports/<date>/audio/）。
 *  - 失败策略（用户约定）：所有后端均失败则抛错，由调用方 catch 降级
 *    （打 warning、页面不出播放器、不阻断发布）。
 *  - SKIP_TTS 模式下调用方不会进入本函数。
 *
 * 环境变量：
 *   TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY（必填，无则走 Piper）
 *   TENCENTCLOUD_REGION（默认 ap-guangzhou）
 *   TTS_VOICE_TYPE（默认 501001 智瑜精品女声） TTS_SPEED（默认 1，约快 15%）
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import iconv from "iconv-lite";

// ---------- 腾讯云 ----------
const TCE_SECRET_ID = process.env.TENCENTCLOUD_SECRET_ID || "";
const TCE_SECRET_KEY = process.env.TENCENTCLOUD_SECRET_KEY || "";
const TCE_REGION = process.env.TENCENTCLOUD_REGION || "ap-guangzhou";
const TCE_HOST = "tts.tencentcloudapi.com";
const TCE_SERVICE = "tts";
const TCE_ACTION = "TextToVoice";
const TCE_VERSION = "2019-08-23";
const VOICE_TYPE = parseInt(process.env.TTS_VOICE_TYPE || "501001", 10);
const SPEED = parseInt(process.env.TTS_SPEED || "1", 10);
const CHUNK_LIMIT = 120; // 腾讯单次上限约 150 字(GBK)，按 120 字分片留余量

// ---------- Piper 兜底 ----------
const VOICE = "zh_CN-huayan-medium";
const LENGTH_SCALE = "1.1";
const MODEL_DIR = path.join(process.env.HOME || os.tmpdir(), ".cache", "piper");
const BASE_URL =
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium";

// ---------- 公共 ----------
const MAX_RETRY = 3;
const MIN_BYTES = 10_000; // 异常偏小校验（空音频防护）
const MIN_MODEL_BYTES = 10_000_000; // 中文 medium 模型应 >10MB，偏小说明下载到 404 错误页

export interface TtsResult {
  mp3Path: string;
  /** 估算时长（秒）；避免引入 mp3 解析依赖，使用字数估算 */
  durationSec: number;
  /** 合成后端：tencent=腾讯云合成，piper=开源 Piper 本地兜底 */
  backend: "tencent" | "piper";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 腾讯云 TC3 签名 + 调用 ----------
function hmac(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf-8").digest();
}
function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

/** 按中文断句标点切分，贪心组包到不超过 limit 字符的分片。 */
function splitText(t: string, limit: number): string[] {
  const sentences = t.split(/(?<=[。！？；\n])/);
  const chunks: string[] = [];
  let buf = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (buf.length + s.length <= limit) {
      buf += s;
    } else {
      if (buf) chunks.push(buf);
      let rest = s;
      while (rest.length > limit) {
        chunks.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      buf = rest;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** ffmpeg concat 拼接多个 mp3 分片（同为腾讯产出，可直接 -codec copy）。 */
function mergeMp3(parts: Buffer[], outPath: string): void {
  if (parts.length === 1) {
    fs.writeFileSync(outPath, parts[0]);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tts-merge-"));
  const files: string[] = [];
  try {
    parts.forEach((p, i) => {
      const f = path.join(tmp, `p-${i}.mp3`);
      fs.writeFileSync(f, p);
      files.push(f);
    });
    const lst = path.join(tmp, "list.txt");
    fs.writeFileSync(
      lst,
      files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
    );
    const r = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", lst, "-codec", "copy", outPath]);
    if (r.status !== 0) {
      const err = (r.stderr || Buffer.alloc(0)).toString().slice(0, 300);
      throw new Error(`ffmpeg 拼接失败（exit ${r.status}）：${err}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 单次 TextToVoice 请求（已签名），返回 mp3 二进制。 */
async function tencentTextToVoice(payloadJson: string): Promise<Buffer> {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const hashedPayload = sha256Hex(payloadJson);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${TCE_HOST}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const credentialScope = `${date}/${TCE_SERVICE}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const secretDate = hmac(`TC3${TCE_SECRET_KEY}`, date);
  const secretService = hmac(secretDate, TCE_SERVICE);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign).toString("hex");
  const authorization =
    `TC3-HMAC-SHA256 Credential=${TCE_SECRET_ID}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(`https://${TCE_HOST}/`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      "X-TC-Action": TCE_ACTION,
      "X-TC-Version": TCE_VERSION,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Region": TCE_REGION,
    },
    body: payloadJson,
  });
  const data = (await resp.json()) as { Response?: { Audio?: string; Error?: { Code: string; Message: string } } };
  if (data.Response?.Error) {
    throw new Error(`腾讯云错误 ${data.Response.Error.Code}: ${data.Response.Error.Message}`);
  }
  if (!data.Response?.Audio) {
    throw new Error("腾讯云返回缺少 Audio 字段");
  }
  return Buffer.from(data.Response.Audio, "base64");
}

/** 腾讯云合成整篇口播稿（分片 + 拼接）。 */
async function synthTencent(text: string, outPath: string, date: string): Promise<void> {
  const chunks = splitText(text, CHUNK_LIMIT);
  console.log(`ℹ️ 腾讯云 TTS：共 ${text.length} 字，分 ${chunks.length} 片合成`);
  const parts: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const payload = JSON.stringify({
      // 必须 GBK 编码后再 base64：腾讯后端按 GBK 解读字节，传 UTF-8 会全文乱码（2026-08-24 实测）
      Text: iconv.encode(chunks[i], "gbk").toString("base64"),
      SessionId: `${date}-${i}-${crypto.randomBytes(4).toString("hex")}`,
      VoiceType: VOICE_TYPE,
      Codec: "mp3",
      Speed: SPEED,
    });
    const audio = await tencentTextToVoice(payload);
    if (audio.length < 1000) {
      throw new Error(`腾讯第 ${i} 片返回异常偏小：${audio.length} bytes`);
    }
    parts.push(audio);
  }
  mergeMp3(parts, outPath);
}

// ---------- Piper 兜底 ----------
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

// ---------- 重试包装 ----------
async function runBackend(
  name: string,
  fn: (t: string, o: string) => void | Promise<void>,
  text: string,
  out: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      await fn(text, out);
      const size = fs.statSync(out).size;
      if (size < MIN_BYTES) throw new Error(`音频异常偏小：${size} bytes`);
      console.log(`✅ TTS 成功（${name}）：${out}（${size} bytes）`);
      return true;
    } catch (e) {
      console.warn(`⚠️ ${name} 第 ${attempt}/${MAX_RETRY} 次失败：${e instanceof Error ? e.message : e}`);
      if (attempt < MAX_RETRY) await sleep(3000 * attempt);
    }
  }
  return false;
}

export async function synthesizeAudio(date: string, script: string): Promise<TtsResult> {
  if (!script || script.trim().length < 20) {
    throw new Error(`口播稿过短（${script?.length ?? 0} 字），中止 TTS`);
  }
  const dir = path.resolve(process.cwd(), "data", "history", "reports", date, "audio");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `briefing-${date}.mp3`);
  const durationSec = Math.max(1, Math.round(script.length / 4.6));

  // —— 主用腾讯云 ——
  if (TCE_SECRET_ID && TCE_SECRET_KEY) {
    if (await runBackend("tencent", (t, o) => synthTencent(t, o, date), script, out)) {
      return { mp3Path: out, durationSec, backend: "tencent" };
    }
    console.warn("⚠️ 腾讯云连续失败，自动切换 Piper 兜底……");
  } else {
    console.log("ℹ️ 未配置 TENCENTCLOUD_SECRET_ID/KEY，使用 Piper 本地兜底");
  }

  // —— Piper 兜底 ——
  if (await runBackend("piper", synthPiper, script, out)) {
    console.warn("::warning::今日音频由 Piper 兜底生成，请检查腾讯云 TTS 状态与额度");
    return { mp3Path: out, durationSec, backend: "piper" };
  }

  throw new Error("所有 TTS 后端均失败");
}
