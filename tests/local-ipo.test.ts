/**
 * 本地专供 IPO 补数桥测试（2026-09-11）。
 *
 * 锁定四件事：
 * 1. **接入层统一**：`normalizeLocalIpoItems` 是本地写入与远端读取共用的唯一处理实现
 *    —— 时间红线（无 publishedAt 丢弃）/ 窗口裁剪 / URL 去重，三件事行为固定。
 * 2. **merge-preserve**：本地某轮抓取全失败时，文件里仍在窗口内的旧条目必须保留
 *    （否则次日 CI 的深交所/辅导覆盖直接归零）。
 * 3. **读取端安全边界**：未知 sourceId 白名单外条目丢弃、在线已有的 URL 不重复补、
 *    文件缺失/损坏/版本不符一律降级为「0 条补数」而不是抛异常。
 * 4. **注册一致性**：`LOCAL_ONLY_IPO_SOURCE_IDS` 必须与 `buildLocalOnlyIpoCrawlers()`
 *    声明的 sourceIds 一一对应，且全量 = 本地专供 ∪ 在线（不重不漏）。
 *
 * 全部纯函数 + 临时目录，不触网、不依赖 data/ 真实文件。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOCAL_IPO_GENERATOR,
  LOCAL_IPO_VERSION,
  LOCAL_ONLY_IPO_SOURCE_IDS,
  buildLocalIpoSnapshot,
  countBySource,
  localIpoStalenessDays,
  normalizeLocalIpoItems,
  readLocalIpoFile,
  selectLocalIpoItems,
  writeLocalIpoFile,
  type LocalIpoFile,
} from "../lib/sources/local-ipo";
import { normalizeLocalIpoItems as fromMerge } from "../lib/ingest/merge";
import type { CrawledArticle } from "../lib/ingest/merge";
import { buildIpoCrawlers, buildLocalOnlyIpoCrawlers, buildOnlineIpoCrawlers } from "../lib/sources/crawlers";

/** 参照时刻：北京时间正午 → UTC / Asia/Shanghai 下日期键一致，测试与机器时区无关。 */
const NOW = new Date("2026-09-11T12:00:00+08:00");

function item(partial: Partial<CrawledArticle>): CrawledArticle {
  return {
    title: "示例条目",
    url: "https://example.com/a",
    excerpt: "IPO辅导备案",
    publishedAt: "2026-09-10",
    sourceId: "gd-szse-audit",
    region: "gd",
    registeredProvince: "广东",
    ...partial,
  };
}

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ipo-"));
  return path.join(dir, "data", "local-ipo.json");
}

describe("normalizeLocalIpoItems（接入层唯一处理点）", () => {
  test("时间红线：无 publishedAt 一律丢弃（绝不回退抓取时间）", () => {
    const r = normalizeLocalIpoItems(
      [item({ publishedAt: "2026-09-10" }), item({ url: "https://x/1", publishedAt: undefined })],
      { now: NOW },
    );
    assert.equal(r.items.length, 1);
    assert.equal(r.droppedNoDate, 1);
  });

  test("窗口裁剪：窗口内保留、超窗丢弃（默认 IPO_SOURCE_WINDOW_DAYS=7）", () => {
    const r = normalizeLocalIpoItems(
      [
        item({ url: "https://x/in", publishedAt: "2026-09-05" }),
        item({ url: "https://x/edge", publishedAt: "2026-09-11" }),
        item({ url: "https://x/out", publishedAt: "2026-09-04" }),
      ],
      { now: NOW },
    );
    assert.deepEqual(
      r.items.map((i) => i.url),
      ["https://x/in", "https://x/edge"],
    );
    assert.equal(r.droppedOutOfWindow, 1);
  });

  test("窗口可注入：windowDays=2 时只留今昨两天", () => {
    const r = normalizeLocalIpoItems(
      [
        item({ url: "https://x/t", publishedAt: "2026-09-11" }),
        item({ url: "https://x/y", publishedAt: "2026-09-10" }),
        item({ url: "https://x/z", publishedAt: "2026-09-09" }),
      ],
      { windowDays: 2, now: NOW },
    );
    assert.deepEqual(
      r.items.map((i) => i.url),
      ["https://x/t", "https://x/y"],
    );
  });

  test("URL 去重：同 URL 只留首条", () => {
    const r = normalizeLocalIpoItems(
      [item({ url: "https://x/same", title: "A" }), item({ url: "https://x/same", title: "B" })],
      { now: NOW },
    );
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].title, "A");
    assert.equal(r.droppedDuplicate, 1);
  });

  test("空 URL 退化为 sourceId|title 内容键（避免多条空 URL 被误并成一条）", () => {
    const r = normalizeLocalIpoItems(
      [
        item({ url: "", title: "深圳硕日新能" }),
        item({ url: "", title: "云英谷科技" }),
      ],
      { now: NOW },
    );
    assert.equal(r.items.length, 2);
    assert.equal(r.droppedDuplicate, 0);
  });

  test("本地与远端共用同一实现（identity 断言，防止将来被各写一份）", () => {
    assert.equal(normalizeLocalIpoItems, fromMerge);
  });
});

describe("buildLocalIpoSnapshot（本地写入端）", () => {
  test("窗口内旧条目被保留（本地抓取抖动不清空文件）", () => {
    const prev: LocalIpoFile = {
      version: LOCAL_IPO_VERSION,
      fetchedAt: "2026-09-10T18:30:00+08:00",
      generator: LOCAL_IPO_GENERATOR,
      windowDays: 7,
      sourceCounts: { "gd-szse-audit": 1 },
      items: [item({ url: "https://x/keep", publishedAt: "2026-09-09" })],
    };
    const { file, stats } = buildLocalIpoSnapshot([], { prev, now: NOW });
    assert.equal(file.items.length, 1);
    assert.equal(file.items[0].url, "https://x/keep");
    assert.equal(stats.newNormalized, 0);
    assert.equal(stats.prevUsed, 1);
  });

  test("旧文件里超窗条目被淘汰（文件长期留存不会灌过期内容）", () => {
    const prev: LocalIpoFile = {
      version: LOCAL_IPO_VERSION,
      fetchedAt: "2026-09-01T18:30:00+08:00",
      generator: LOCAL_IPO_GENERATOR,
      windowDays: 7,
      sourceCounts: { "gd-szse-audit": 2 },
      items: [
        item({ url: "https://x/fresh", publishedAt: "2026-09-10" }),
        item({ url: "https://x/stale", publishedAt: "2026-08-01" }),
      ],
    };
    const { file } = buildLocalIpoSnapshot([], { prev, now: NOW });
    assert.deepEqual(
      file.items.map((i) => i.url),
      ["https://x/fresh"],
    );
  });

  test("同 URL 冲突取 publishedAt 较新者", () => {
    const prev: LocalIpoFile = {
      version: LOCAL_IPO_VERSION,
      fetchedAt: "2026-09-10T18:30:00+08:00",
      generator: LOCAL_IPO_GENERATOR,
      windowDays: 7,
      sourceCounts: {},
      items: [item({ url: "https://x/same", publishedAt: "2026-09-08", title: "旧" })],
    };
    const { file } = buildLocalIpoSnapshot(
      [item({ url: "https://x/same", publishedAt: "2026-09-10", title: "新" })],
      { prev, now: NOW },
    );
    assert.equal(file.items.length, 1);
    assert.equal(file.items[0].title, "新");
  });

  test("输出确定性排序（publishedAt 倒序 → sourceId → url），保证每日 diff 只含真实增量", () => {
    const items = [
      item({ url: "https://x/b", publishedAt: "2026-09-09" }),
      item({ url: "https://x/a", publishedAt: "2026-09-11" }),
      item({ url: "https://x/c", publishedAt: "2026-09-09" }),
    ];
    const a = buildLocalIpoSnapshot(items, { now: NOW }).file;
    const b = buildLocalIpoSnapshot([items[2], items[0], items[1]], { now: NOW }).file;
    assert.deepEqual(
      a.items.map((i) => i.url),
      ["https://x/a", "https://x/b", "https://x/c"],
    );
    assert.deepEqual(
      a.items.map((i) => i.url),
      b.items.map((i) => i.url),
    );
  });

  test("sourceCounts 按 sourceId 统计且键有序", () => {
    const { file } = buildLocalIpoSnapshot(
      [
        item({ url: "https://x/1", sourceId: "gd-szse-audit" }),
        item({ url: "https://x/2", sourceId: "gd-csrc-tutoring" }),
        item({ url: "https://x/3", sourceId: "gd-csrc-tutoring" }),
      ],
      { now: NOW },
    );
    assert.deepEqual(Object.keys(file.sourceCounts), ["gd-csrc-tutoring", "gd-szse-audit"]);
    assert.equal(file.sourceCounts["gd-csrc-tutoring"], 2);
  });

  test("countBySource 对缺 sourceId 归入占位键", () => {
    assert.deepEqual(countBySource([item({ sourceId: undefined })]), { "(无 sourceId)": 1 });
  });
});

describe("read/write 落盘", () => {
  test("写入后读取往返一致（原子写 + 版本字段）", () => {
    const f = tmpFile();
    const { file } = buildLocalIpoSnapshot([item({ url: "https://x/rt" })], {
      now: NOW,
      fetchedAt: "2026-09-11T18:30:00+08:00",
    });
    writeLocalIpoFile(file, f);
    const back = readLocalIpoFile(f);
    assert.ok(back.file);
    assert.equal(back.file!.version, LOCAL_IPO_VERSION);
    assert.equal(back.file!.items.length, 1);
    assert.equal(back.file!.fetchedAt, "2026-09-11T18:30:00+08:00");
    assert.equal(fs.existsSync(`${f}.tmp`), false, "临时文件应已 rename 消失");
  });

  test("文件不存在 / JSON 损坏 / 版本不符 → file=null 且有原因（绝不抛异常）", () => {
    const missing = readLocalIpoFile(path.join(os.tmpdir(), "definitely-missing-local-ipo.json"));
    assert.equal(missing.file, null);
    assert.ok(missing.reason);

    const bad = tmpFile();
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(bad, "{ not json", "utf8");
    assert.equal(readLocalIpoFile(bad).file, null);

    const wrongVer = tmpFile();
    fs.mkdirSync(path.dirname(wrongVer), { recursive: true });
    fs.writeFileSync(wrongVer, JSON.stringify({ version: 999, items: [] }), "utf8");
    assert.equal(readLocalIpoFile(wrongVer).file, null);

    const notArray = tmpFile();
    fs.mkdirSync(path.dirname(notArray), { recursive: true });
    fs.writeFileSync(notArray, JSON.stringify({ version: LOCAL_IPO_VERSION, items: "x" }), "utf8");
    assert.equal(readLocalIpoFile(notArray).file, null);
  });

  test("陈旧度计算：fetchedAt 非法 → null；超 2 天可被识别", () => {
    assert.equal(localIpoStalenessDays("", NOW), null);
    assert.equal(localIpoStalenessDays("not-a-date", NOW), null);
    // NOW = 09-11T12:00+08:00；同日 00:30 抓 → 不足 1 天 → 0
    assert.equal(localIpoStalenessDays("2026-09-11T00:30:00+08:00", NOW), 0);
    // 09-08 00:30 抓 → 3 天多 → 3
    assert.equal(localIpoStalenessDays("2026-09-08T00:30:00+08:00", NOW), 3);
    // 未来时间戳（时钟漂移）→ 归 0，不产生负值
    assert.equal(localIpoStalenessDays("2026-09-12T00:30:00+08:00", NOW), 0);
  });
});

describe("selectLocalIpoItems（远端接入端）", () => {
  function writeFixture(items: CrawledArticle[]): string {
    const f = tmpFile();
    writeLocalIpoFile(
      {
        version: LOCAL_IPO_VERSION,
        fetchedAt: "2026-09-11T18:30:00+08:00",
        generator: LOCAL_IPO_GENERATOR,
        windowDays: 7,
        sourceCounts: countBySource(items),
        items,
      },
      f,
    );
    return f;
  }

  test("文件缺失 → 返回 0 条（降级不抛异常）", () => {
    const out = selectLocalIpoItems([], {
      filePath: path.join(os.tmpdir(), "missing-local-ipo-xyz.json"),
      now: NOW,
    });
    assert.deepEqual(out, []);
  });

  test("白名单外 sourceId 被丢弃（防手工改错把别的源灌进 IPO 批次）", () => {
    const f = writeFixture([
      item({ url: "https://x/good", sourceId: "gd-szse-audit" }),
      item({ url: "https://x/bad", sourceId: "stcn" }),
    ]);
    const out = selectLocalIpoItems([], { filePath: f, now: NOW });
    assert.deepEqual(
      out.map((i) => i.url),
      ["https://x/good"],
    );
  });

  test("在线已抓到的同 URL 不重复补（在线优先）", () => {
    const f = writeFixture([item({ url: "https://x/dup", sourceId: "gd-szse-audit" })]);
    const out = selectLocalIpoItems([item({ url: "https://x/dup", title: "在线版" })], {
      filePath: f,
      now: NOW,
    });
    assert.deepEqual(out, []);
  });

  test("窗口外的文件条目不会被补进来", () => {
    const f = writeFixture([
      item({ url: "https://x/fresh", publishedAt: "2026-09-10" }),
      item({ url: "https://x/old", publishedAt: "2026-08-20" }),
    ]);
    const out = selectLocalIpoItems([], { filePath: f, now: NOW });
    assert.deepEqual(
      out.map((i) => i.url),
      ["https://x/fresh"],
    );
  });
});

describe("本地专供源清单一致性", () => {
  test("LOCAL_ONLY_IPO_SOURCE_IDS 与 buildLocalOnlyIpoCrawlers() 声明一一对应", () => {
    const declared = buildLocalOnlyIpoCrawlers()
      .flatMap((c) => c.sourceIds)
      .sort();
    assert.deepEqual(declared, [...LOCAL_ONLY_IPO_SOURCE_IDS].sort());
  });

  test("全量 = 本地专供 ∪ 在线（不重不漏）", () => {
    const all = buildIpoCrawlers()
      .flatMap((c) => c.sourceIds)
      .sort();
    const union = [
      ...buildLocalOnlyIpoCrawlers().flatMap((c) => c.sourceIds),
      ...buildOnlineIpoCrawlers().flatMap((c) => c.sourceIds),
    ].sort();
    assert.deepEqual(all, union);
    assert.equal(new Set(all).size, all.length, "不应有重复 sourceId");
  });

  test("本地专供与在线两个集合互斥", () => {
    const only = new Set(buildLocalOnlyIpoCrawlers().flatMap((c) => c.sourceIds));
    for (const id of buildOnlineIpoCrawlers().flatMap((c) => c.sourceIds)) {
      assert.ok(!only.has(id), `${id} 同时出现在本地专供与在线集合`);
    }
  });
});
