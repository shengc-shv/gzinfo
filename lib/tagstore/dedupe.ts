/**
 * 去重键与指纹计算。
 *
 * 一级主键：规范化 URL 的哈希——同一篇文章在不同源间 URL 通常一致。
 * 二级主键：标题指纹——URL 带随机参数/短链漂移时兜底。
 * 三级判据：内容指纹（标题 + 摘要前文）——跨源同事件合并用，仅提示不合并。
 */

import { createHash } from "node:crypto";

/** 需要剔除的跟踪参数（会导致同一文章出现多个 URL）。 */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "spm",
  "from",
  "src",
  "share_token",
  "share_source",
  "ref",
  "referrer",
  "s",
]);

/**
 * 纯导航型锚点：与内容无关（#top / #content / #comments 等），去除以提升跨源命中率。
 * 内容标识型锚点（如东方财富 IPO 页 #A24052）必须保留，否则不同股票会被误并为一条。
 */
const NAV_HASHES = new Set([
  "top",
  "content",
  "comments",
  "comment",
  "article",
  "main",
  "header",
  "footer",
  "nav",
  "toc",
  "readmore",
  "more",
  "reply",
  "respond",
  "p",
  "page",
]);

/**
 * URL 规范化：协议归一 + host 小写 + 去 www + 去锚点 + 去跟踪参数 + 去尾斜杠。
 * 无法解析时原样小写返回（不抛异常，保证管线不因单条脏数据中断）。
 */
export function normalizeUrl(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s.toLowerCase();
  }
  // 协议归一（http/https 视为同一篇）
  u.protocol = "https:";
  let host = u.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  u.hostname = host;
  u.hash = "";
  // 锚点：导航类（#top / #content …）去掉以提升命中率；**内容标识类必须保留**——
  // 东方财富新股页 https://data.eastmoney.com/xg/xg/#A24052 与 #A25250 是两只不同股票，
  // 一律去锚点会把不同条目误并为一条（2026-09-07 实跑发现，属漏损）。
  const hash = s.slice(s.indexOf("#") + 1).toLowerCase();
  if (!NAV_HASHES.has(hash)) u.hash = s.includes("#") ? s.slice(s.indexOf("#")) : "";
  // 去跟踪参数（先收集再删，避免遍历时修改）
  const drop: string[] = [];
  u.searchParams.forEach((_v, k) => {
    if (TRACKING_PARAMS.has(k.toLowerCase())) drop.push(k);
  });
  for (const k of drop) u.searchParams.delete(k);
  const out = u.toString();
  return out.endsWith("/") ? out.slice(0, -1) : out;
}

/** 标题归一化：只保留汉字 / 字母 / 数字，转小写。 */
export function normalizeTitle(title: string): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^一-龥a-z0-9]/g, "");
}

function sha1(input: string, len: number): string {
  return createHash("sha1").update(input).digest("hex").slice(0, len);
}

/** 一级主键：URL 哈希（16 位十六进制）。 */
export function urlId(url: string): string {
  return sha1(normalizeUrl(url), 16);
}

/** 二级主键：标题指纹（12 位）。 */
export function titleFingerprint(title: string): string {
  return sha1(normalizeTitle(title), 12);
}

/**
 * 内容指纹（12 位）：归一化标题 + 摘要前 80 字。
 * 用于识别「同一事件被多个源各发一条」，仅作提示，不自动合并。
 */
export function contentFingerprint(title: string, excerpt: string): string {
  const ex = (excerpt ?? "").replace(/\s+/g, "").slice(0, 80);
  return sha1(`${normalizeTitle(title)}|${ex}`, 12);
}

/** 标题 Dice 相似度（0~1），用于跨源同事件的软匹配。 */
export function titleDice(a: string, b: string): number {
  const A = normalizeTitle(a);
  const B = normalizeTitle(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      set.set(g, (set.get(g) ?? 0) + 1);
    }
    return set;
  };
  const ga = bigrams(A);
  const gb = bigrams(B);
  let inter = 0;
  ga.forEach((n, g) => {
    inter += Math.min(n, gb.get(g) ?? 0);
  });
  const total = A.length - 1 + (B.length - 1);
  return total <= 0 ? 0 : (2 * inter) / total;
}
