import assert from "node:assert/strict";
import { test } from "node:test";
import { capLightAiSources, LIGHT_AI_SOURCES } from "../lib/ai/light-ai";

interface ScoredArticle {
  url: string;
  sourceId: string;
  publishedAt: Date;
  score: number;
}

test("capLightAiSources：传入 scorer 时按评分降序取前 N（价值预筛生效）", () => {
  const arts: ScoredArticle[] = [];
  // cnfin 给 6 条：score 0..5，且 publishedAt 故意与 score 反序（最新一条 score 最低）
  for (let i = 0; i < 6; i++) {
    arts.push({
      url: `cnfin-${i}`,
      sourceId: "cnfin",
      publishedAt: new Date(Date.now() - i * 86_400_000),
      score: i,
    });
  }
  const out = capLightAiSources(arts, LIGHT_AI_SOURCES, 3, (a) => a.score);
  const cnfin = out.filter((a) => a.sourceId === "cnfin");
  assert.equal(cnfin.length, 3, "应限流到 3 条");
  // 保留的是评分最高的 3 条（i=5,4,3，即最旧的 3 条），而非最新的 3 条
  const scores = cnfin.map((a) => a.score).sort((x, y) => x - y);
  assert.deepEqual(scores, [3, 4, 5], "价值预筛：应按分行相关性评分取前 N");
});

test("capLightAiSources：无 scorer 时退化为按发布时间倒序（向后兼容）", () => {
  const arts = [
    { url: "a", sourceId: "cnfin", publishedAt: new Date(Date.now() - 3 * 86_400_000) },
    { url: "b", sourceId: "cnfin", publishedAt: new Date(Date.now() - 1 * 86_400_000) },
    { url: "c", sourceId: "cnfin", publishedAt: new Date(Date.now() - 2 * 86_400_000) },
  ];
  const out = capLightAiSources(arts, LIGHT_AI_SOURCES, 10);
  const days = out
    .map((a) => Math.round((Date.now() - a.publishedAt.getTime()) / 86_400_000))
    .sort((x, y) => x - y);
  assert.deepEqual(days, [1, 2, 3], "无 scorer 时仍按最新优先");
});
