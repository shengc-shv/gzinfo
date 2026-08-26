/**
 * URL 规范化（B-2 跨源去重）。
 *
 * 同一篇文章的不同 URL 应被识别为"同一条"，避免因追踪参数 / 协议变体 /
 * 尾斜杠 / 锚点差异导致去重失效（同一篇微信文章被 utm_source 不同算成两条）。
 *
 * 规范化规则（按顺序）：
 *  1. 解析失败 → 返回原 URL（不做猜测）
 *  2. 协议 + host 小写；移除 www. 前缀（统一）
 *  3. 移除常见追踪参数（utm_*, fbclid, gclid, ref 等）
 *  4. 排序剩余 query 参数（同一文章不同顺序的链接视为同一条）
 *  5. 移除 hash fragment（#section）
 *  6. 路径尾斜杠归一化（除根路径外）
 *  7. 移除 trailing slash 后重建完整 URL
 *
 * 设计：零依赖（用 URL API）；同源跨端口 / 子域差异**不归一化**（保留区分，
 * 避免 example.com 与 example.com.cn 混为同一条）。
 */

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_source_platform", "utm_creative_format", "utm_marketing_tactic",
  "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid",
  "ref", "ref_src", "ref_url", "source", "spm",
  "from", "share_source", "share_medium", "_channel",
  "nsukey", "ncid", "ved",
]);

/**
 * 移除 URL 中的常见追踪参数。
 * 修改原 URL 的 searchParams（不 mutate 入参）。
 */
function stripTrackingParams(u: URL): void {
  const keys: string[] = [];
  for (const k of u.searchParams.keys()) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) keys.push(k);
  }
  for (const k of keys) u.searchParams.delete(k);
}

/**
 * URL 规范化。失败时返回原 URL（字符串保底）。
 *
 * @example
 *   canonicalizeUrl("HTTPS://WWW.Example.com/a/?utm_source=x#sec")
 *   // => "https://example.com/a"
 */
export function canonicalizeUrl(url: string): string {
  if (!url) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;  // 解析失败：保底返回原 URL，不丢弃
  }

  // 协议 + host 小写
  u.protocol = u.protocol.toLowerCase();
  u.host = u.host.toLowerCase();

  // 移除 www. 前缀（统一 www 与非 www）
  if (u.host.startsWith("www.")) {
    u.host = u.host.slice(4);
  }

  // 移除追踪参数
  stripTrackingParams(u);

  // 排序剩余 query 参数
  u.searchParams.sort();

  // 移除 hash fragment
  u.hash = "";

  // 路径尾斜杠归一化（除根路径外）
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

/**
 * 判断两个 URL 是否"实质相同"（规范化后相等）。
 * 用于去重预检：canonical 相等的 URL 直接归一，不进入标题相似度计算。
 */
export function sameCanonicalUrl(a: string, b: string): boolean {
  if (!a || !b) return false;
  return canonicalizeUrl(a) === canonicalizeUrl(b);
}
