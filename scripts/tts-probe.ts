/**
 * TTS 发音试听包（2026-09-10 新增）
 *
 * 用途：**用听感决定 AUM 该用哪种写法**，而不是靠猜。
 *
 * 背景：2026-09-10 今早实际送进 TTS 的口播原文是「具备零售 A U M商机的」，
 * 用户反馈仍是连读 → 「空格拆字母」这条路无效。腾讯云官方 SSML 文档称
 * `<say-as interpret-as="characters">` 会「按字符一一读出」，但**是否对基础语音合成
 * TextToVoice 生效、听感是否自然，只能实测**——本脚本就是把候选写法一次性都合成出来。
 *
 * 用法（需要腾讯云密钥；密钥只在本机使用，不落盘、不上传）：
 *
 *   TENCENTCLOUD_SECRET_ID=xxx TENCENTCLOUD_SECRET_KEY=yyy \
 *     npx tsx scripts/tts-probe.ts
 *
 * 产出：`outputs/tts-probe/`
 *   - `00-asis-online.mp3` … `07-avoid.mp3`  8 条单音频，**逐条听**（每段已含「第 N 种」提示音）
 *   - `probe-all.mp3`   可选：8 条顺序拼接（本机无 ffmpeg 时降级为字节顺序拼接）
 *   - `MAPPING.txt`     序号 ↔ 写法对照表
 *
 * 听出来后告诉我「第 N 种对了」，我把 `lib/audio/tts.ts` 的默认发音策略切成它即可
 * （一行改动，其余代码不用动）。
 */

import fs from "node:fs";
import path from "node:path";

import { synthTencent, mergeMp3 } from "../lib/audio/tts";
import { toSpeechText } from "../lib/audio/pronounce";

/** 取材自 2026-09-10 实际口播稿的一句（原句为「具备零售 A U M商机的，…」）。 */
const BASE = "具备零售AUM商机的，可提前备好卖点和话术。";

/** 今早线上真正送进 TTS 的写法（上游 SEG_SPEAK_LABEL 把 AUM 拆成了空格）。 */
const ASIS_ONLINE = "具备零售 A U M商机的，可提前备好卖点和话术。";

interface Candidate {
  /** 文件名短标识 */
  slug: string;
  /** 控制台 / MAPPING.txt 里的说明 */
  label: string;
  /** 送 TTS 的文本（SSML 模式已由 toSpeechText 包好 <speak>） */
  text: string;
}

const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

const CANDIDATES: Candidate[] = [
  { slug: "00-asis-online", label: "asis：今早线上原文（空格拆字母，实测无效）", text: ASIS_ONLINE },
  { slug: "01-plain", label: "plain：归一为连写 AUM（对照·预期仍连读）", text: toSpeechText(BASE, "plain").trim() },
  { slug: "02-punct", label: "punct：A、U、M（顿号强制停顿）", text: toSpeechText(BASE, "punct").trim() },
  { slug: "03-interpunct", label: "interpunct：A·U·M（间隔号）", text: toSpeechText(BASE, "interpunct").trim() },
  { slug: "04-translit", label: "translit：诶优艾姆（汉字音译）", text: toSpeechText(BASE, "translit").trim() },
  { slug: "05-ssml-say-as", label: "ssml-say-as：官方 SSML 逐字符读", text: toSpeechText(BASE, "ssml-say-as") },
  { slug: "06-ssml-sub", label: "ssml-sub：SSML 别名替换", text: toSpeechText(BASE, "ssml-sub") },
  { slug: "07-avoid", label: "avoid：文案回避（读「零售资产规模」）", text: "具备零售资产规模商机的，可提前备好卖点和话术。" },
];

async function main(): Promise<void> {
  if (!process.env.TENCENTCLOUD_SECRET_ID || !process.env.TENCENTCLOUD_SECRET_KEY) {
    console.error(
      [
        "✋ 缺少腾讯云 TTS 密钥，无法合成试听包。",
        "",
        "密钥只在本机使用（脚本不落盘、不上传）。两种任选其一：",
        "  1) 直接带上环境变量跑：",
        "     TENCENTCLOUD_SECRET_ID=xxx TENCENTCLOUD_SECRET_KEY=yyy npx tsx scripts/tts-probe.ts",
        "  2) 写进项目根的 .env 后再跑（.env* 已在 .gitignore，不会误提交）：",
        "     TENCENTCLOUD_SECRET_ID=xxx",
        "     TENCENTCLOUD_SECRET_KEY=yyy",
        "",
        "若你手上没有密钥，也可以让我改走 CI（需你授权触发一次远程 workflow）。",
      ].join("\n"),
    );
    process.exit(1);
  }

  const outDir = path.resolve(process.cwd(), "outputs", "tts-probe");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`🎧 生成发音试听包：${CANDIDATES.length} 种写法 → ${outDir}`);
  const okParts: { candidate: Candidate; file: string }[] = [];
  const failed: { candidate: Candidate; reason: string }[] = [];

  for (let i = 0; i < CANDIDATES.length; i++) {
    const c = CANDIDATES[i];
    // 每段前加中文序号，听到「第 N 种」即可对号入座（SSML 片段之外的文本可直接共存）
    const spoken = `第${CN_NUM[i]}种。${c.text}`;
    const file = path.join(outDir, `${c.slug}.mp3`);
    try {
      await synthTencent(spoken, file, `probe-${i}`);
      const size = fs.statSync(file).size;
      console.log(`  ✅ [${i}] ${c.label} → ${path.basename(file)}（${size} bytes）`);
      okParts.push({ candidate: c, file });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // 失败本身就是重要结论：说明该写法不被腾讯云接受（如 SSML 不支持基础合成）
      console.warn(`  ❌ [${i}] ${c.label} 合成失败：${reason}`);
      failed.push({ candidate: c, reason });
    }
  }

  if (okParts.length === 0) {
    console.error("😵 全部候选都合成失败，先检查密钥/额度与网络。");
    process.exit(1);
  }

  // 拼接成一条，顺序同候选表（失败项不参与）
  const merged = path.join(outDir, "probe-all.mp3");
  let mergeNote = "";
  try {
    mergeMp3(
      okParts.map((p) => fs.readFileSync(p.file)),
      merged,
    );
  } catch (e) {
    // 本机通常没装 ffmpeg（CI 装了，见 daily.yml:245）。mp3 是帧流，按字节顺序拼即可播放，
    // 仅在段边界可能有极轻的衔接瑕疵 —— 对「听发音」这件事完全够用，不该因此让整包作废。
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`  ⚠️ ffmpeg 拼接失败，降级为字节顺序拼接：${reason}`);
    fs.writeFileSync(merged, Buffer.concat(okParts.map((p) => fs.readFileSync(p.file))));
    mergeNote = "（本机无 ffmpeg，probe-all.mp3 为字节顺序拼接，段边界可能有轻微衔接音）";
  }

  const lines = [
    "TTS 发音试听包 · 2026-09-10",
    "句子取材：2026-09-10 实际口播稿（原句「具备零售 A U M商机的，可提前备好卖点和话术。」）",
    "",
    "听 probe-all.mp3（每段前有「第 N 种」提示），或单独听同名 mp3。",
    ...(mergeNote ? [mergeNote] : []),
    "",
    "序号  写法                                     结果",
    "-".repeat(72),
  ];
  for (let i = 0; i < CANDIDATES.length; i++) {
    const c = CANDIDATES[i];
    const hit = okParts.find((p) => p.candidate.slug === c.slug);
    const status = hit ? "✅ 已合成" : "❌ 合成失败";
    lines.push(`第${CN_NUM[i]}种  ${c.label.padEnd(40, " ")} ${status}`);
    lines.push(`        文本：${c.text}`);
  }
  if (failed.length) {
    lines.push("", "失败详情：");
    for (const f of failed) lines.push(`  - ${f.candidate.label}：${f.reason}`);
  }
  fs.writeFileSync(path.join(outDir, "MAPPING.txt"), lines.join("\n"), "utf8");

  console.log("");
  console.log(lines.join("\n"));
  console.log("");
  console.log(`🔊 汇总音频：${merged}`);
  console.log('👉 告诉我「第几种对了」，我改默认策略（一行改动）。');
}

main().catch((e) => {
  console.error(`💥 试听包生成失败：${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
