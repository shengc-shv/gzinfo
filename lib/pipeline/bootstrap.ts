/**
 * daily 主流程启动器（PR1）。
 *
 * 职责（原 daily.ts main 313-323 行 + 模块级 state 初始化）：
 * - 凭证预校验（SKIP_AI 模式跳过）
 * - 加载 L1 history + L2 aiAssets
 * - 加载源注册表（locale 已过滤）
 * - 构建 tierBySource 索引（替代 main 中重复构建两次的反模式）
 * - 构造 DailyMode（ai / skip-ai）+ summaryCache + relevantUrls
 * - 返回 DailyContext
 *
 * 不负责：
 * - 任何 fetch（PR2 ingest.ts 负责）
 * - 任何 AI 调用（PR4 ai.ts 负责）
 * - 任何渲染 / 写盘（PR5 render-and-write.ts 负责）
 */

import { loadHistory, type HistoryStore } from "../output/history";
import { loadAiAssets, assetSummary, type AiAssetStore } from "../ai/assets";
import { loadAllSources } from "../sources/registry";
import { validateBackendCredentials } from "../ai/llm";
import { aiEnabled } from "../ai/mode";
import { todayKey } from "../utils";
import { ConsoleLogger, type DailyContext, type DailyMode, type Tier } from "./context";

export interface BootstrapResult {
  history: HistoryStore;
  aiAssets: AiAssetStore;
}

/**
 * 加载 L1 + L2 缓存并打印统计日志。
 * 抽出来便于 PR4 阶段测试独立 mock。
 */
function loadCaches(): BootstrapResult {
  const history = loadHistory();
  const aiAssets = loadAiAssets();
  console.log(
    `[daily] 已加载历史缓存: ${Object.keys(history).length} 条（来自 data/article-history.json）`,
  );
  console.log(
    `[daily] 已加载 AI 资产账本: ${Object.keys(aiAssets).length} 键（data/ai-assets/，${
      process.env.PERSIST_AI === "off" ? "PERSIST_AI=off 旁路" : "启用"
    }`,
  );
  return { history, aiAssets };
}

/**
 * 构造 DailyMode。
 * - ai 模式：kind=ai，runner 由 PR4 ai.ts 注入
 * - skip-ai 模式：构造 summaryCache（合并 history+aiAssets）与 relevantUrls（白名单）
 */
function buildMode(history: HistoryStore, aiAssets: AiAssetStore): DailyMode {
  if (aiEnabled()) return { kind: "ai" };

  // SKIP_AI：合并 history 与 aiAssets 的摘要
  const summaryCache = new Map<string, string>();
  for (const url of new Set([...Object.keys(history), ...Object.keys(aiAssets)])) {
    const s = assetSummary(aiAssets, url) ?? history[url]?.summary;
    if (s && s.trim()) summaryCache.set(url, s);
  }
  // 相关性白名单：history 中 ai_relevant===true 的 url
  const relevantUrls = new Set(
    Object.entries(history)
      .filter(([, e]) => e?.ai_relevant === true)
      .map(([url]) => url),
  );
  return { kind: "skip-ai", summaryCache, relevantUrls };
}

/**
 * 构造 tierBySource 索引（仅 tier 已声明的源）。
 * 注：loadAllSources 返回的 SourceDef.tier 可能为 undefined；tier 为 undefined 的源不进入索引。
 */
function buildTierIndex(sources: ReturnType<typeof loadAllSources>): Map<string, Tier> {
  const map = new Map<string, Tier>();
  for (const s of sources) {
    if (s.tier) map.set(s.id, s.tier);
  }
  return map;
}

/**
 * 启动 daily 主流程，返回运行上下文。
 *
 * 调用前确保 _env.ts 已 import（dotenv 加载完成）。env.ts 已被 daily.ts 顶部
 * `import "./_env"` 触发，bootstrap 自身不再重复加载。
 */
export async function bootstrap(): Promise<DailyContext> {
  // 1. 凭证预校验（SKIP_AI 不调 LLM，跳过；与原 daily.ts:317 等价）
  if (aiEnabled()) validateBackendCredentials();

  // 2. 加载 L1 + L2 缓存
  const { history, aiAssets } = loadCaches();

  // 3. 加载源注册表 + 构建 tier 索引
  const sources = loadAllSources();
  const tierBySource = buildTierIndex(sources);

  // 4. 构造 mode
  const mode = buildMode(history, aiAssets);

  // 5. 返回 ctx
  return {
    startTime: new Date(),
    date: todayKey(),
    mode,
    sources,
    tierBySource,
    history,
    aiAssets,
    log: new ConsoleLogger("[daily]"),
  };
}
