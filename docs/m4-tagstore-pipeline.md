# M4 · TagStore 缓存复用流水线

把「条目 → AI 判定」固化成跨天可复用的资产：T-1 预分析打过的标，T 正式运行直接复用，只对新增条目调 LLM。

**代号**：M4（回检搜 `M4` 或 `tagstore`）
**落盘**：`data/tag-store.json`
**代码**：`lib/tagstore/*`、`lib/pipeline/pass1-input.ts`、`scripts/pre-analyze.ts`

---

## 1. 三阶段契约

> ⚠️ **20:00 / 08:00 只是举例**。实际触发时刻不固定，因此阶段**只能**由参数 `PIPELINE_PHASE` 显式指定，**禁止**从当前钟点推断。

| 阶段 | `PIPELINE_PHASE` | 触发方式 | 输入 | 处理 | 输出 |
|---|---|---|---|---|---|
| ① 晚间预分析 | `pre` | `npm run pre-analyze` | 源注册表（当天已发布条目） | 采集 → 9 道过滤 → **WorkBuddy 离线打标**（不调生产 LLM） | `data/tag-queue.json`、`data/tag-store.json` |
| ② 次日正式运行 | `formal`（默认） | `npm run daily` | 采集到的全部条目 + TagStore | 与 store 去重比对：命中复用（**零 LLM**）、未命中走 LLM、增量回写 | 报告 + 更新后的 store |
| ③ 内容生成 | 随 ② | 正式运行内 | store 中两天窗口内 `aiRelevant=true` 的条目 | LLM 生成「今日必读 / 洞察」+ 口播稿 | 报告模块 + 音频稿 |

阶段③的候选池由 `relevantPoolFromStore()` 提供（`lib/tagstore/pipeline.ts`），按窗口过滤、按发布时间倒序。

### ① 预分析怎么用（WorkBuddy 打标闭环）

```bash
# 第一步：采集 + 产出待打标队列
npm run pre-analyze -- --emit-only
# → data/tag-queue.json（每条含 url / title / excerpt / publishedAt / businessHint）

# 第二步：WorkBuddy 读队列，按银行零售视角撰写，写入 data/tag-incoming.json
# { "items": [ { "url": "...", "aiRelevant": true, "summary": "...",
#                "section": "biz_insight", "locale": "national",
#                "tags": ["财富"], "importance": 2 } ] }

# 第三步：合并进 store（幂等，可重复跑）
npm run pre-analyze -- --commit-only
```

- `--tagger=llm`：改用生产 LLM 打标（需凭证，**本地不可用**，仅 CI）
- 已打过标的条目自动跳过，重复运行不重复劳动

### ② 正式运行怎么用

无需额外操作——`npm run daily` 已接入。日志会打印分流结果：

```
[tagstore] 已加载标签库：271 条（有价值 157）by {"workbuddy":271}
[tagstore] 分流：输入 134 → 复用 98（零 LLM）/ 待打标 36 / 已判无价值丢弃 21
[tagstore] 成稿对账：LLM 组 12 + 复用组 31 = 43 条
```

---

## 2. store 数据结构

文件：`data/tag-store.json`

```jsonc
{
  "version": 1,
  "schema": 1,                 // 打标口径版本，升级后旧记录自动失效重打
  "updatedAt": "2026-09-07T11:40:00.000Z",
  "window": { "from": "...", "to": "..." },   // 最近一次覆盖的窗口（可观测）
  "records": { "<urlId>": { /* TagRecord */ } },
  "titleIndex": { "<titleFp>": "<urlId>" }    // URL 漂移时的兜底索引
}
```

`TagRecord` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 主键 = `sha1(规范化URL).slice(0,16)` |
| `url` / `rawUrl` | string | 规范化 URL / 原始 URL（外链用原始） |
| `titleFp` | string | 标题指纹 = `sha1(归一化标题).slice(0,12)` |
| `contentFp` | string | 内容指纹（标题+摘要前80字），跨源同事件判据 |
| `title` / `sourceId` / `source` | string | 元信息 |
| `publishedAt` | string | **真实发布时间（ISO）**。缺失则整条不入库 |
| `firstSeenAt` / `taggedAt` | string | 首次入库 / 最近一次有效打标 |
| `tagger` | `workbuddy` \| `llm` \| `pipeline` | 打标者，决定信任等级 |
| `schema` | number | 打标口径版本 |
| `aiRelevant` | boolean | 是否有新闻价值 |
| `summary` | string? | 银行零售视角解读 |
| `section` / `locale` / `tags` / `importance` / `businessLines` | 可选 | 内容判定结果（**非源分类**） |
| `hits` | number | 保留字段，不累加（保证幂等） |

**信任等级**：`pipeline(3) > llm(2) > workbuddy(1)`。低信任只能补齐缺失字段，**不能覆盖**高信任已有值。

---

## 3. 去重依据（三级）

| 级别 | 判据 | 用途 |
|---|---|---|
| 一级 | `sha1(规范化URL)` | 主键。规范化 = 协议归一 + host 小写 + 去 `www.` + 去锚点 + 去 `utm_*/from/spm/src/ref` 等跟踪参数 + 去尾斜杠 |
| 二级 | `sha1(归一化标题)` | URL 漂移（短链、路径变更）时兜底命中 |
| 三级 | 内容指纹 / 标题 Dice 相似度 | **跨源同事件提示**，仅用于识别，不自动合并 |

非跟踪参数（如 `?id=1`）保留，避免不同文章被误并。

---

## 4. 时间窗口与跨天处理

- 时区：`REPORT_TZ`（默认 `Asia/Shanghai`），**所有边界按本地自然日切分**
- 报告日 `T` 的两天窗口 = `[T-1 00:00 本地, T+1 00:00 本地)`，即覆盖 T-1 全天 + T 当天
- 半开区间：下界含、上界不含，边界归属无歧义
- **跨天逻辑**：预分析与正式运行只隔数小时，两者抓到的条目高度重叠 → 重叠部分命中 store（零 LLM），仅「上次预分析之后新增」的条目走 LLM
- **时间真实性红线**：无真实发布时间的条目 `inWindow()` 恒为 false、不入库、不进队列
- 保留期：窗口天数 + 1 天缓冲（默认 3 天），`pruneStore()` 每次写入后清理

---

## 5. LLM 失败降级与重试

正式运行的三道防线（**核心：不漏损 + 不误杀**）：

1. **软失败检测（关键）**：`runPass1`/`runPass2` 在 LLM 异常时会**吞掉异常、降级为空报告**（不向上抛）。因此「未命中组非空但产出 0 条」才是 LLM 真实失败的信号——`runCachedAiPipeline` 据此判 `llmFailed`，**跳过回写**（否则空产出会被当成「进了 LLM 但落选」→ 误标永久无价值，最严重漏损）。
2. **回退全量重跑**：软失败触发后，若 `TAG_FALLBACK_FULL=1`（默认开），把命中组也一起送进 LLM 重跑；全量仍空则保留缓存组（不漏损）、并告警。
3. **缓存路径任何异常** → `runAiPipeline` 自动回退原全量路径（改造前行为）。

> ⚠️ 早期实现只靠 `try/catch` 判失败，但因 runPass1 吞异常，`catch` 几乎永不触发 → 空产出被误标无价值。2026-09-07 通过集成测试暴露并改为软失败检测（`lib/tagstore/pipeline.ts`）。

其他：
- **失败不回写**：LLM 失败时绝不写 store —— 否则一次网络抖动会把条目永久标成「无价值」（最严重的漏损）
- PASS1 批次内已有重试（`lib/ai/pass1.ts`：单批失败重试 + 拆半隔离毒丸）；`runLlm` 有 3 次退避重试

---

## 6. 幂等性

| 场景 | 保证 |
|---|---|
| 重复跑预分析 | 已打标条目自动跳过；相同 incoming 重复合并 → `added/updated` 均为 0 |
| 重复跑正式运行 | 已打标 → 走复用组（零 LLM），结果一致；`upsertRecords` 同输入同输出 |
| 记录合并 | 守卫式写入：无值不覆盖有值、低信任不覆盖高信任、`firstSeenAt` 取最早、`hits` 不累加 |
| 落盘 | 原子写（tmp + rename），CI 中断不留半截 JSON |
| 文件损坏 | 解析失败 → 按空 store 处理并告警，不中断管线（等价于全量 LLM，不漏损） |

---

## 7. 开关与环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PIPELINE_PHASE` | `formal` | `pre` = 预分析 / `formal` = 正式运行 |
| `REPORT_DATE` | 今天 | 报告日 `YYYY-MM-DD`（补跑/测试用） |
| `REPORT_TZ` | `Asia/Shanghai` | 窗口时区 |
| `TAG_WINDOW_DAYS` | `2` | 窗口天数 |
| `TAG_STORE` | 开 | `0` 关闭整套缓存（等价改造前） |
| `TAG_CACHE_PIPELINE` | 开 | `0` 关闭正式运行的分流复用 |
| `TAG_FALLBACK_FULL` | `1` | 未命中组失败时回退全量重跑 |
| `TAG_QUEUE_PATH` / `TAG_INCOMING_PATH` | `tag-queue.json` / `tag-incoming.json` | 队列与打标结果文件名 |

---

## 8. 回退方案

- 一键关闭：`TAG_STORE=0 npm run daily` → 完全走改造前路径
- 只关分流：`TAG_CACHE_PIPELINE=0 npm run daily`
- 清空缓存：删除 `data/tag-store.json` 或 `{"version":1,"schema":1,"records":{},"titleIndex":{}}`

---

## 9. 测试与回检

```bash
# 单元 + 集成（M4 全量）
node --experimental-test-module-mocks --import tsx --test tests/tagstore-core.test.ts tests/tagstore-cache.test.ts tests/tagstore-pipeline.test.ts
SKIP_AI=true npm run daily          # 本地只跑 SKIP_AI（本地禁止跑全 AI：claude-cli 后端挂）
```

覆盖：去重键、窗口边界、守卫式写入、幂等、过期清理、双主键查询、三路分流、合并不漏损、失败不回写、软失败回退、空 store 等价全量 LLM。

### 验证结论（2026-09-07 实测）

- **集成测试 3 条全过**（`tests/tagstore-pipeline.test.ts`）：
  1. 空 store → 4 条全走 LLM、成稿 4 条、回写 4 条（等价现状全量）；
  2. 部分命中 → 2 条零 LLM 复用 + 1 条走 LLM、合并不漏损、命中组用 store 缓存解读、新增条目回写为有价值；
  3. miss 组 LLM 失败 → 软失败触发、回退全量、降级保留缓存组、失败不回写（不误杀）。
- **全量回归 473 pass / 0 fail**（基线 470 + M4 新增 3），`tsc --noEmit` 零错误。
- **预分析脚本实测**：`npm run pre-analyze -- --emit-only` 抓 438 条 → 过滤后 36 条待打标队列；WorkBuddy 打标后 `--commit-only` 入库 36 条（两条东财 IPO 锚点 `#A24052`/`#A25250` 因锚点保留而正确区分为两条，已修复此前误并 bug）。

> ⚠️ 本地验证限制：全 AI 路径（真 LLM 打标）无法在本地跑（claude-cli 后端挂），集成测试用 `makeSkipAiRunner` 作确定性「假 LLM」注入验证缓存分流与不漏损；真 LLM 效果需在 CI（GMI 后端）验证。
