/**
 * IPO 体系 sourceId 注册一致性测试
 * （2026-09-09 P0 止血；2026-09-10 P1-6 回检：改为遍历真实启用的源清单）
 *
 * 背景铁证：爬虫输出 em-ipo，但 sources.config.json 只注册 gd-em-ipo / gz-em-ipo /
 * em-declare；render.ts 的 knownSourceIds ← config，随后
 * `if (!knownSourceIds.has(a.sourceId)) continue;` 把 em-ipo 全量静默丢弃 →
 * 历史库 em-ipo = 0 条（东财辅导 + csrcfd 全被吞）。
 *
 * P1-6 修正：旧版把 5 个 gd-* id **硬编码**在测试里，漏了本管线实际启用的
 * `hk-filing` / `hk-filing-gd`（以及非 BaseCrawler 的 `gd-listed-check`）——
 * 也就是说「新增源忘记注册」这类最危险的改动，旧测试根本不会失败。
 * 现改为遍历 `buildIpoCrawlers()` + `buildListedChecker()` 实例上的 `sourceIds`
 * 声明（声明与实现同文件），新增源若漏注册会被直接拦下。
 *
 * 本测试锁定：
 * 1. 每个启用 IPO 源都必须声明 `sourceIds`（防新增源静默逃过校验）。
 * 2. 每个产出 id ∈ config 注册 id（render 白名单同源）。
 * 3. 每个产出 id 有 SOURCE_ROUTE，且 category ∈ {gd-ipo, ipo}；gd-* 必须为 gd-ipo。
 * 4. 覆盖度回归：hk-filing / hk-filing-gd / gd-listed-check 必须在遍历范围内。
 * 5. em-ipo 已退役（SOURCE_ROUTE 与 config 均无）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SOURCE_ROUTE } from "../lib/sources/constants";
import { buildIpoCrawlers, buildListedChecker } from "../lib/sources/crawlers";

/** config 注册 id 集合（与 render knownSourceIds 同源：loadAllSources → sources.config.json）。 */
function configIds(): Set<string> {
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "sources.config.json"), "utf8"),
  ) as Array<{ id: string }>;
  return new Set(raw.map((s) => s.id));
}

/** 本管线实际启用的 IPO 源实例（直接遍历实例声明，不依赖任何硬编码清单）。 */
function enabledIpoSources(): Array<{ label: string; sourceIds: string[] }> {
  return [
    ...buildIpoCrawlers().map((c) => ({ label: c.name, sourceIds: c.sourceIds })),
    { label: "ListedChecker", sourceIds: buildListedChecker().sourceIds },
  ];
}

describe("IPO 源 sourceId ∈ config 白名单（防 render 静默丢弃）", () => {
  const ids = configIds();
  const sources = enabledIpoSources();

  test("全部启用 IPO 源均已声明 sourceIds（防新增源静默逃过校验）", () => {
    for (const s of sources) {
      assert.ok(
        s.sourceIds.length > 0,
        `${s.label} 未声明 sourceIds（请在类中声明其产出的 sourceId）`,
      );
    }
  });

  test("每个产出的 sourceId 都已注册进 config（render 白名单会放行）", () => {
    for (const s of sources) {
      for (const id of s.sourceIds) {
        assert.ok(
          ids.has(id),
          `${s.label} 产出的 ${id} 未在 sources.config.json 注册 → render 会静默丢弃`,
        );
      }
    }
  });

  test("每个产出的 sourceId 均有 SOURCE_ROUTE 路由（category ∈ gd-ipo / ipo）", () => {
    const allowed = new Set(["gd-ipo", "ipo"]);
    for (const s of sources) {
      for (const id of s.sourceIds) {
        const route = SOURCE_ROUTE[id];
        assert.ok(route, `${s.label} 产出的 ${id} 缺 SOURCE_ROUTE 路由`);
        assert.ok(
          allowed.has(route.category),
          `${id} 路由 category=${route.category}，应为 gd-ipo 或 ipo`,
        );
      }
    }
  });

  test("广东源限定：gd-* 必须路由到 gd-ipo（商机身份）", () => {
    for (const s of sources) {
      for (const id of s.sourceIds) {
        if (!id.startsWith("gd-")) continue;
        assert.equal(SOURCE_ROUTE[id]?.category, "gd-ipo", `${id} 应以 category=gd-ipo 路由`);
      }
    }
  });

  test("覆盖度回归：hk-filing / hk-filing-gd / gd-listed-check 必须在遍历范围内（P1-6 修复点）", () => {
    const all = new Set(sources.flatMap((s) => s.sourceIds));
    for (const id of [
      "gd-csrc-tutoring",
      "gd-sse-audit",
      "gd-szse-audit",
      "gd-bse-audit",
      "gd-listed-check",
      "hk-filing",
      "hk-filing-gd",
    ]) {
      assert.ok(all.has(id), `遍历范围应包含 ${id}（新增源漏注册时应在此暴露）`);
    }
  });

  test("em-ipo 已从 SOURCE_ROUTE 移除（退役）", () => {
    assert.equal(SOURCE_ROUTE["em-ipo"], undefined, "em-ipo 应已退役移除");
  });

  test("config 无 em-ipo 注册（与 render 白名单同源事实）", () => {
    assert.ok(!ids.has("em-ipo"));
  });
});
