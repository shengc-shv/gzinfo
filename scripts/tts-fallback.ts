/**
 * TTS 兜底合成（2026-08-24 新增，配合 workflow 的「Piper 仅腾讯失败时启用」）。
 *
 * 触发：daily 跑腾讯合成失败且 Piper 未预装时，tts.ts 会在
 *   data/history/reports/<date>/tts-fallback-needed.txt 写标记；
 * workflow 检测到标记后安装 Piper，并调用本脚本补合成。
 *
 * 流程：读 store.json → assembleAudioScript 拼装口播稿 → 清掉腾讯密钥
 * 强制走 Piper → synthesizeAudio 生成 mp3 → 删除标记。
 * 产物与 daily 一致（data/history/reports/<date>/audio/briefing-<date>.mp3），
 * 后续 build-site / 发布步骤会正常带上播放器。
 */
import fs from "node:fs";
import path from "node:path";
import { assembleAudioScript } from "../lib/audio/audio";
import { synthesizeAudio } from "../lib/audio/tts";

// 强制走 Piper：tts.ts 读到空密钥即直接走 Piper 路径
delete process.env.TENCENTCLOUD_SECRET_ID;
delete process.env.TENCENTCLOUD_SECRET_KEY;

const REPORTS_DIR = path.resolve(process.cwd(), "data", "history", "reports");

function markerDates(): string[] {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs
    .readdirSync(REPORTS_DIR)
    .filter((d) =>
      fs.existsSync(path.join(REPORTS_DIR, d, "tts-fallback-needed.txt")),
    )
    .sort();
}

async function main(): Promise<void> {
  const dates = markerDates();
  if (!dates.length) {
    console.log("[tts-fallback] 无待兜底日期（无 tts-fallback-needed.txt 标记），跳过");
    return;
  }
  for (const date of dates) {
    const dir = path.join(REPORTS_DIR, date);
    const marker = path.join(dir, "tts-fallback-needed.txt");
    const storePath = path.join(dir, "store.json");
    try {
      if (!fs.existsSync(storePath)) {
        console.warn(`[tts-fallback] ${date} 无 store.json，跳过并清理标记`);
        fs.rmSync(marker);
        continue;
      }
      const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
      const exec = store.executive ?? store;
      const built = await assembleAudioScript(date, exec, []);
      if (!built) {
        console.warn(`[tts-fallback] ${date} 口播稿为空，跳过并清理标记`);
        fs.rmSync(marker);
        continue;
      }
      const res = await synthesizeAudio(date, built.script);
      console.log(
        `[tts-fallback] ✅ ${date} Piper 合成完成（${res.mp3Path}，backend=${res.backend}）`,
      );
      fs.rmSync(marker);
    } catch (e) {
      console.error(
        `[tts-fallback] ❌ ${date} 兜底合成失败：${e instanceof Error ? e.message : e}`,
      );
      // 失败保留标记，便于排查；不阻断 workflow（构建/发布照常，页面不出播放器）
    }
  }
}

main().catch((e) => {
  console.error("[tts-fallback] FAIL:", e);
  process.exit(1);
});
