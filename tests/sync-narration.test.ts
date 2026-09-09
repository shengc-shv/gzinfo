import { test } from "node:test";
import assert from "node:assert/strict";
import { syncNarration } from "../lib/pipeline/side-outputs/executive-summary";
import type { ExecutiveSummary } from "../lib/ai/executive-summary";

function base(over: Partial<ExecutiveSummary> = {}): ExecutiveSummary {
  return {
    hero_line: "定调",
    must_read: [],
    insights: [],
    ...over,
  };
}

test("口播条数 = 卡面条数（1:1 由构造保证）", () => {
  const exec = base({
    insights: Array.from({ length: 8 }, (_, i) => ({
      topic: `商机${i}`,
      impact: `影响${i}`,
      action: `动作${i}`,
    })),
  });
  const out = syncNarration(exec);
  // 8 张卡 → 8 条商机均进入口播（每张卡以 topic 锚定，逐条校验不漏播/不重复播）
  assert.ok(out.spoken_insights, "口播不应为空");
  for (let i = 0; i < 8; i++) {
    assert.ok((out.spoken_insights ?? "").includes(`商机${i}`), `商机${i} 应进入口播`);
  }
  const hits = (out.spoken_insights ?? "").match(/商机\d/g) ?? [];
  assert.equal(hits.length, 8, "口播商机条数应等于卡面条数");
});

test("多标签卡用『和』连接客群段", () => {
  const exec = base({
    insights: [
      {
        topic: "家族信托升级",
        impact: "利好高净值",
        action: "跟进私行",
        segments: ["零售AUM", "中高端客群(过亿资产)"],
      },
    ],
  });
  const out = syncNarration(exec);
  // 零售AUM 口播须按字母发音（空格拆开 → TTS 逐字母读 A U M），展示 chip 仍写「零售AUM」
  assert.match(out.spoken_insights ?? "", /具备零售 A U M和高端客户商机的/);
});

test("零售AUM 口播按字母发音（空格拆 A U M），与展示文案无关", () => {
  const exec = base({
    insights: [{ topic: "财富客户提升", impact: "AUM 规模增长", action: "做大客群", segments: ["零售AUM"] }],
  });
  const out = syncNarration(exec);
  assert.match(out.spoken_insights ?? "", /具备零售 A U M商机的/);
  assert.ok(!/零售AUM商机的/.test(out.spoken_insights ?? ""), "口播不得出现连写的『零售AUM』");
});

test("单标签卡读【具备X商机】且映射短标签", () => {
  const exec = base({
    insights: [{ topic: "小微贷", impact: "扩客", action: "推产品", segments: ["普惠小微贷款客户"] }],
  });
  const out = syncNarration(exec);
  assert.match(out.spoken_insights ?? "", /具备普惠小微商机的/);
});

test("无 insights 时口播置空（不残留旧整块文本）", () => {
  const exec = base({ spoken_insights: "这是昨天残留的一大段旧口播文本……" });
  const out = syncNarration(exec);
  assert.equal(out.spoken_insights, undefined);
});

test("risk 被去重清空 → 口播同步清空（消除孤儿口播）", () => {
  const exec = base({
    risk: undefined,
    spoken_risk: "今天有 1 个需要警惕：某风险，影响，动作。",
  });
  const out = syncNarration(exec);
  assert.equal(out.spoken_risk, undefined, "风险卡不存在时口播不得残留");
});

test("risk 存在 → 派生 1 句风险口播", () => {
  const exec = base({
    risk: { topic: "理财违规", evidence: "通报", impact: "合规风险", action: "关注" },
  });
  const out = syncNarration(exec);
  assert.match(out.spoken_risk ?? "", /今天有 1 个需要警惕：理财违规/);
});

test("衔接词轮换缓解逐条拼接生硬感", () => {
  const exec = base({
    insights: Array.from({ length: 4 }, (_, i) => ({ topic: `t${i}`, impact: `i${i}`, action: `a${i}` })),
  });
  const out = syncNarration(exec);
  assert.match(out.spoken_insights ?? "", /此外，/);
  assert.match(out.spoken_insights ?? "", /最后，/);
});
