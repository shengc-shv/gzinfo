/**
 * LLM backend dispatcher.
 *
 * All call sites (pipeline / enrich / trading-commentary) import `runLlm`
 * from this module instead of binding to a specific backend. The actual
 * backend is selected at runtime by the LLM_BACKEND environment variable:
 *
 *   LLM_BACKEND=claude-cli   (default; uses local Claude Code CLI, Max billing)
 *   LLM_BACKEND=anthropic    (Anthropic Messages API)
 *   LLM_BACKEND=openai       (OpenAI Chat Completions)
 *   LLM_BACKEND=deepseek     (DeepSeek, OpenAI-compatible)
 *   LLM_BACKEND=minimax      (MiniMax, OpenAI-compatible)
 *   LLM_BACKEND=zhipu        (Zhipu AI / 智谱, Anthropic-compatible)
 *
 * Per-backend config (API keys, models, base URLs) lives in .env.local.
 * See .env.example for the full list.
 */

import { CLAUDE_MODEL, runClaudeCli } from "./backends/claude-cli";
import {
  PRESETS as ANTHROPIC_PRESETS,
  anthropicCompatModel,
  runAnthropicCompat,
} from "./backends/anthropic-compat";
import {
  PRESETS as OPENAI_PRESETS,
  openaiCompatModel,
  runOpenAICompat,
} from "./backends/openai-compat";
import { recordAiCall } from "./metrics";
import type { AiStage } from "./mode";
import { todayKey } from "../utils";

export interface LlmRunOptions {
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  /** 覆盖后端默认模型（两阶段管线：PASS1 用便宜模型、PASS2 用强模型）。 */
  model?: string;
}

export interface LlmRunResult {
  text: string;
  durationMs: number;
}

export type LlmBackendId =
  | "claude-cli"
  | "anthropic"
  | "openai"
  | "deepseek"
  | "minimax"
  | "zhipu";

const VALID_BACKENDS: ReadonlySet<LlmBackendId> = new Set([
  "claude-cli",
  "anthropic",
  "openai",
  "deepseek",
  "minimax",
  "zhipu",
]);

export function getBackend(): LlmBackendId {
  const raw = (process.env.LLM_BACKEND?.trim() || "claude-cli").toLowerCase();
  if (!VALID_BACKENDS.has(raw as LlmBackendId)) {
    throw new Error(
      `Unknown LLM_BACKEND='${raw}'. Valid values: ${[...VALID_BACKENDS].join(", ")}`,
    );
  }
  return raw as LlmBackendId;
}

/**
 * Returns the active model name for the configured backend, useful for
 * stamping a MODEL_TAG into report metadata.
 */
function getActiveModel(backend: LlmBackendId): string {
  switch (backend) {
    case "claude-cli":
      return CLAUDE_MODEL;
    case "anthropic":
    case "zhipu":
      return anthropicCompatModel(ANTHROPIC_PRESETS[backend]);
    case "openai":
    case "deepseek":
    case "minimax":
      return openaiCompatModel(OPENAI_PRESETS[backend]);
  }
}

export function getModelTag(): string {
  const backend = getBackend();
  return `${backend}-${getActiveModel(backend)}`;
}

export async function runLlm(
  opts: LlmRunOptions,
  meta?: { stage?: AiStage },
): Promise<LlmRunResult> {
  const backend = getBackend();
  const stage = meta?.stage ?? "other";
  const t0 = Date.now();
  const stamp = () => ({
    ts: new Date().toISOString(),
    date: todayKey(),
    backend,
    stage,
    tokens: 0,
    modelTag: getModelTag(),
  });
  // 重试配置（2026-08-27 用户反馈：CI 限流导致 LLM 偶发失败，重试 3 次 + 指数退避）
  // 重试只对 transient 错误（5xx / 429 / 超时 / 网络）；4xx 立即抛（配置错误不该重试）
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1500;  // 1.5s / 3s / 6s 指数退避
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      let result: LlmRunResult;
      switch (backend) {
        case "claude-cli":
          result = await runClaudeCli(opts);
          break;
        case "anthropic":
        case "zhipu":
          result = await runAnthropicCompat(opts, ANTHROPIC_PRESETS[backend]);
          break;
        case "openai":
        case "deepseek":
        case "minimax":
          result = await runOpenAICompat(opts, OPENAI_PRESETS[backend]);
          break;
      }
      if (attempt > 0) {
        console.warn(`[llm] ${stage} 成功（重试 ${attempt} 次后）`);
      }
      // 2026-09-05：HTTP 200 但 content 为空的响应不抛错，会被 runLlm 当成功返回；
      // 补一行让所有 stage 的「空文本」可观测（此前 exec 空壳无任何痕迹）。
      if (!result.text.trim()) {
        console.warn(`[llm] ${stage} ⚠️ 返回空文本（HTTP 成功但 content 为空，下游解析将失败）`);
      }
      recordAiCall({ ...stamp(), ok: true, ms: result.durationMs || Date.now() - t0 });
      return result;
    } catch (e) {
      lastErr = e;
      if (!isTransientLlmError(e) || attempt === MAX_RETRIES - 1) {
        // 2026-09-03 修复（#133 实锤）：最后一搏失败 / 非 transient 4xx 此前直接 throw 不留
        // 日志——若调用方静默 catch（stock-recap 曾如此），CI 日志完全看不到 AI 失败原因。
        // 抛前补一条 [llm] 失败行，使 AI 调用失败始终可观测。
        const fatalMsg = (e as Error)?.message ?? String(e);
        console.warn(
          `[llm] ${stage} ${attempt === MAX_RETRIES - 1 ? "重试 3 次仍失败" : "非临时性错误"}，放弃: ${fatalMsg.slice(0, 200)}`,
        );
        recordAiCall({ ...stamp(), ok: false, ms: Date.now() - t0 });
        throw e;
      }
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        `[llm] ${stage} 第 ${attempt + 1} 次失败，${delay}ms 后重试: ${(e as Error).message?.slice(0, 120)}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // 理论不可达；保险抛
  recordAiCall({ ...stamp(), ok: false, ms: Date.now() - t0 });
  throw lastErr;
}

/** 判定 LLM 错误是否 transient（5xx/429/超时/网络）—— 4xx 立即抛 */
function isTransientLlmError(e: unknown): boolean {
  if (!e || typeof e !== "object") return true;
  const msg = String((e as Error).message ?? e).toLowerCase();
  if (/401|403|404|invalid api key|unauthorized|forbidden|not found/.test(msg)) return false;
  if (/invalid_request_error|invalid argument/.test(msg)) return false;
  if (/429|rate.?limit|too many requests|quota/.test(msg)) return true;
  if (/5\d\d|internal server|bad gateway|service unavailable|gateway timeout|timeout|etimedout|econnreset|econnrefused/.test(msg)) return true;
  return true;
}
/**
 * Cheap startup sanity-check so a misconfigured backend errors in <1s
 * instead of after 30s of source-fetching + half a dozen confusing
 * "ANTHROPIC_API_KEY required" lines deep into the pipeline.
 *
 * The default LLM_BACKEND in the GH Actions workflow is `anthropic`,
 * so the most common forker mistake is: add DEEPSEEK_API_KEY as a
 * secret, forget to add the matching `LLM_BACKEND=deepseek` variable,
 * then watch the run blow up looking for a key they never intended
 * to use. We detect that exact case and tell them how to fix it.
 */
export function validateBackendCredentials(): void {
  const backend = getBackend();
  if (backend === "claude-cli") return;

  const required: Record<Exclude<LlmBackendId, "claude-cli">, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    minimax: "MINIMAX_API_KEY",
    zhipu: "ZHIPU_API_KEY",
  };
  const requiredVar = required[backend];

  if (process.env[requiredVar] || process.env.LLM_API_KEY) return;

  const otherKeysSet = Object.entries(required)
    .filter(([b, v]) => b !== backend && !!process.env[v])
    .map(([b, v]) => ({ backend: b, var: v }));

  const lines: string[] = [
    `LLM_BACKEND=${backend} but ${requiredVar} (and generic LLM_API_KEY) are both unset.`,
  ];
  if (otherKeysSet.length > 0) {
    lines.push(
      "",
      "Other API keys ARE present in the environment — likely you meant to use one of those:",
    );
    for (const k of otherKeysSet) {
      lines.push(`  • ${k.var} is set → switch to LLM_BACKEND=${k.backend}`);
    }
    lines.push(
      "",
      "Fix one of:",
      `  (a) set LLM_BACKEND to match the key you actually have, or`,
      `  (b) add ${requiredVar} for the backend you currently selected.`,
    );
  } else {
    lines.push(
      "",
      `Fix: set ${requiredVar} (or the generic LLM_API_KEY).`,
    );
  }
  lines.push(
    "",
    "Where to set it:",
    "  • Local:          .env.local at the repo root",
    "  • GitHub Actions: Settings → Secrets and variables → Actions",
    "                    (Secrets tab for the API key, Variables tab for LLM_BACKEND)",
  );
  throw new Error(lines.join("\n"));
}
