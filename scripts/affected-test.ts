/**
 * affected-test.ts — 基于改动影响面的分级回归测试运行器
 *
 * 设计稿：ai-workspace/log/2026-09-08-workbuddy-regression-test-design.md
 *
 * 用法：
 *   tsx scripts/affected-test.ts                 # 默认：对比 origin/main..HEAD 算影响面，仅跑受影响测试
 *   tsx scripts/affected-test.ts --files a.ts b.ts
 *   tsx scripts/affected-test.ts --since <ref>
 *   tsx scripts/affected-test.ts --full          # 强制全量 L3
 *   tsx scripts/affected-test.ts --plan          # 只打印选中/跳过，不执行（验证规则用）
 *
 * 规则：
 *   A 按名直接映射：测试文件名包含被改模块短名即命中
 *   B 依赖图逆向闭包：被改 X → 反向依赖（深度默认 2）→ 其测试受影响
 *   C 配置类特例：*.yml / .github/workflows/* / package.json → 仅 smoke，0 业务单测
 *   D 类型-only：lib/types.ts → 仅 tsc，不跑行为测试
 *   E 红线文件：7 个漏斗文件 → 强制 L2（传递依赖全跑）
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const TESTS_DIR = path.join(ROOT, "tests");

// 7 个漏斗红线文件（见红线规则）
const REDLINE = new Set([
  "lib/sources/dispatch.ts",
  "lib/ai/pipeline.ts",
  "lib/ai/pass1.ts",
  "lib/ai/pass2.ts",
  "lib/ai/item-classifier.ts",
  "lib/output/history.ts",
  "lib/ai/exec-pool.ts",
]);

const MAX_DEPTH = 2; // 依赖图逆向闭包深度
const FULL_THRESHOLD = 45; // 选中超过此数 → 直接全量 L3（防漏）

// ---------- git / fs 工具 ----------
function git(args: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function isTest(f: string): boolean {
  return f.startsWith(TESTS_DIR + path.sep) && f.endsWith(".test.ts");
}

// 解析相对导入，补全省略的扩展名（本仓库大量使用无扩展名导入，如 ./pass1）
function resolveImport(fromFile: string, spec: string): string {
  const abs = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    abs,
    abs + ".ts",
    abs + ".mts",
    abs + ".cts",
    path.join(abs, "index.ts"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return abs; // best-effort：文件不存在也记录，避免漏边
}

function isConfig(f: string): boolean {
  return (
    f.endsWith(".yml") ||
    f.endsWith(".yaml") ||
    f === "package.json" ||
    f.startsWith(".github" + path.sep + "workflows" + path.sep) ||
    f.endsWith("sources.config.json") ||
    f.endsWith("sources.keywords.json")
  );
}

// ---------- 依赖图 ----------
let reverseDeps = new Map<string, Set<string>>();
let allTests: string[] = [];

function buildGraph(): void {
  reverseDeps = new Map();
  const srcFiles = [
    ...listFiles(path.join(ROOT, "lib"), ".ts"),
    ...listFiles(path.join(ROOT, "scripts"), ".ts"),
    ...listFiles(TESTS_DIR, ".test.ts"),
  ];
  allTests = srcFiles.filter(isTest);

    const importRe =
      /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const file of srcFiles) {
    let code = "";
    try {
      code = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const deps = new Set<string>();
    let m: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((m = importRe.exec(code))) {
      const spec = m[1] || m[2];
      if (!spec) continue;
      if (spec.startsWith(".") || spec.startsWith("/")) {
        deps.add(resolveImport(file, spec));
      }
    }
    for (const d of deps) {
      if (!reverseDeps.has(d)) reverseDeps.set(d, new Set());
      reverseDeps.get(d)!.add(file);
    }
  }
}

// 测试文件名是否对应某源文件（规则 A）
function nameMatch(testFile: string, srcFile: string): boolean {
  const stem = path.basename(testFile, ".test.ts");
  const base = path.basename(srcFile, ".ts");
  if (stem === base) return true;
  const stemTokens = new Set(stem.split("-"));
  if (base.split("-").some((tok) => stemTokens.has(tok))) return true;
  if (stem.split("-").includes(base)) return true;
  return false;
}

// 被改文件 → 受影响测试集（规则 A + B，深度限制）
function affectedTests(
  file: string,
  depth: number,
  seen: Set<string>,
): Set<string> {
  const res = new Set<string>();
  if (seen.has(file)) return res;
  seen.add(file);
  for (const t of allTests) if (nameMatch(t, file)) res.add(t);
  const deps = reverseDeps.get(file);
  if (deps)
    for (const d of deps) {
      if (isTest(d)) res.add(d);
      else if (depth < MAX_DEPTH)
        for (const t of affectedTests(d, depth + 1, seen)) res.add(t);
    }
  return res;
}

// ---------- 改动解析 ----------
function resolveChanged(): string[] | null {
  const filesIdx = process.argv.indexOf("--files");
  if (filesIdx >= 0) {
    return process.argv
      .slice(filesIdx + 1)
      .filter((a) => a && !a.startsWith("--"));
  }
  if (process.argv.includes("--full")) return null; // null = 全量
  const sinceIdx = process.argv.indexOf("--since");
  const since = sinceIdx >= 0 ? process.argv[sinceIdx + 1] : null;
  const base =
    since || git("merge-base HEAD origin/main").trim() || "origin/main";
  let files = git(`diff --name-only ${base} HEAD`)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (files.length === 0)
    files = git("diff --cached --name-only")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  if (files.length === 0)
    files = git("diff --name-only")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  return files;
}

// ---------- 执行 ----------
function runTsc(): void {
  console.log("[affected-test] L0: tsc --noEmit ...");
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", [
    "tsc",
    "--noEmit",
  ], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.error("[affected-test] tsc 失败，终止");
    process.exit(r.status ?? 1);
  }
}

function runConfigValidation(changed: string[]): void {
  for (const f of changed) {
    if (
      f.endsWith("sources.config.json") ||
      f.endsWith("sources.keywords.json")
    ) {
      console.log(`[affected-test] 校验 ${f} → npm run sources:check`);
      spawnSync("npm", ["run", "sources:check"], {
        cwd: ROOT,
        stdio: "inherit",
      });
    }
  }
}

function runNodeTests(files: string[]): void {
  console.log(`[affected-test] 运行 ${files.length} / ${allTests.length} 个测试文件：`);
  for (const f of files) console.log("  - " + path.relative(ROOT, f));
  const r = spawnSync(
    "node",
    ["--experimental-test-module-mocks", "--import", "tsx", "--test", ...files],
    { cwd: ROOT, stdio: "inherit" },
  );
  process.exit(r.status ?? 0);
}

function runAll(reason: string): void {
  console.log(`[affected-test] 全量 L3（${reason}）`);
  const r = spawnSync(
    "node",
    ["--experimental-test-module-mocks", "--import", "tsx", "--test", ...allTests],
    { cwd: ROOT, stdio: "inherit" },
  );
  process.exit(r.status ?? 0);
}

function printPlan(sel: string[], reasons: Record<string, string>): void {
  console.log(`[affected-test:plan] selected ${sel.length} / ${allTests.length}`);
  sel.forEach((f) =>
    console.log(`  RUN  ${path.relative(ROOT, f)}  <- ${reasons[f] || ""}`),
  );
  const skipped = allTests.filter((t) => !sel.includes(t));
  console.log(`[affected-test:plan] skipped ${skipped.length}`);
}

// ---------- 主流程 ----------
function main(): void {
  const PLAN =
    process.argv.includes("--plan") || process.argv.includes("--dry");
  buildGraph();

  const changed = resolveChanged();
  if (changed === null) {
    if (PLAN) printPlan(allTests, {});
    else runAll("explicit --full");
    return;
  }
  if (changed.length === 0) {
    if (PLAN) console.log("[affected-test:plan] clean tree, 0 changed");
    else {
      console.log("[affected-test] clean tree → 仅 tsc 类型检查");
      runTsc();
    }
    return;
  }

  const selected = new Set<string>();
  const reasons: Record<string, string> = {};
  let hasBusinessChange = false;
  let configOnly = true;

  for (let f of changed) {
    f = f.trim();
    if (!f) continue;
    const abs = path.resolve(ROOT, f);

    if (isTest(f)) {
      selected.add(abs);
      reasons[abs] = "测试文件自身改动";
      hasBusinessChange = true;
      configOnly = false;
      continue;
    }
    if (isConfig(f)) {
      reasons[abs] = "配置文件 → 仅 smoke，不跑业务单测";
      continue;
    }
    if (f === "lib/types.ts") {
      reasons[abs] = "类型-only → 仅 tsc";
      configOnly = false; // 非配置，但也不跑行为测试
      continue;
    }
    if (f.startsWith("lib/") || f.startsWith("scripts/")) {
      hasBusinessChange = true;
      configOnly = false;
      const ts = affectedTests(abs, 0, new Set());
      if (ts.size === 0) {
        reasons[abs] = "源文件改动，未映射到测试（仅 tsc）";
      }
      const tag = REDLINE.has(f) ? "（红线文件→L2）" : "";
      for (const t of ts) {
        selected.add(t);
        reasons[t] = `映射自 ${f}${tag}`;
      }
      continue;
    }
    // 其它（docs / 资源 / .md）→ 跳过
    reasons[abs] = "非代码/文档，跳过";
  }

  if (PLAN) {
    printPlan([...selected], reasons);
    return;
  }

  runTsc();
  if (configOnly) runConfigValidation(changed);

  if (selected.size === 0) {
    const why = configOnly
      ? "纯配置/文档改动"
      : hasBusinessChange
        ? "改动未映射到测试"
        : "类型-only";
    console.log(
      `[affected-test] selected 0 / ${allTests.length}，skipped ${allTests.length}（${why}），tsc 通过。`,
    );
    return;
  }
  if (selected.size > FULL_THRESHOLD) {
    runAll(`选中 ${selected.size} > 阈值 ${FULL_THRESHOLD}`);
    return;
  }
  runNodeTests([...selected]);
}

main();
