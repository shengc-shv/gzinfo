import Parser from "rss-parser";
import { curlFetch } from "./curl-fetch";
import type { Category, RawArticle } from "./types";
import { isGuangdongEnterprise } from "./guangdong.mjs";

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; gzcmbdf3Bot/1.0; +https://github.com/)",
  },
});

const CURL_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * 源级关键词过滤（2026-08-20，用户指定 arXiv 金融科技流）。
 * 当源配置带 keywords 时，仅保留 title/excerpt 命中至少一个关键词的条目
 * （大小写不敏感、子串匹配）。无 keywords（或空数组）不过滤。
 * 纯函数，便于单测。
 */
export function filterByKeywords(
  items: RawArticle[],
  keywords: string[] | undefined,
): RawArticle[] {
  const kws = (keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (kws.length === 0) return items;
  return items.filter((a) => {
    const hay = `${a.title} ${a.excerpt ?? ""}`.toLowerCase();
    return kws.some((k) => hay.includes(k));
  });
}

export async function fetchRss(
  sourceId: string,
  url: string,
  category: Category,
  options: { limit?: number; useCurl?: boolean; keywords?: string[]; subcategory?: string } = {},
): Promise<RawArticle[]> {
  const limit = options.limit ?? 30;

  let feed;
  if (options.useCurl) {
    const xml = await curlFetch(url, CURL_HEADERS);
    feed = await parser.parseString(xml);
  } else {
    feed = await parser.parseURL(url);
  }

  let mapped: RawArticle[] = (feed.items ?? [])
    .slice(0, limit)
    .map((item) => ({
      sourceId,
      title: (item.title ?? "").trim(),
      url: (item.link ?? "").trim(),
      excerpt: stripHtml(item.contentSnippet ?? item.content ?? "").slice(
        0,
        300,
      ),
      publishedAt: item.isoDate ? new Date(item.isoDate) : undefined,
      category,
      subcategory: options.subcategory,
    }))
    .filter((a) => a.title && a.url);

  // 源级关键词过滤（arXiv 金融科技流等）：命中任一关键词才保留。
  if (options.keywords && options.keywords.length > 0) {
    const before = mapped.length;
    mapped = filterByKeywords(mapped, options.keywords);
    console.log(
      `[rss ${sourceId}] 关键词过滤: ${before} → ${mapped.length} 条 (${options.keywords.join(", ")})`,
    );
  }

  // 广东地区 IPO 类源（目前即"国外"子分类的 RSS 资信源）需按广东企业过滤：
  // 这些源没有股票代码可解析省份，只能用公司名/正文中的广东城市名识别。
  // 其余分类（tech / finance / politics）不受影响。
  if (category === "gd-ipo") {
    const before = mapped.length;
    const kept = mapped.filter((a) =>
      isGuangdongEnterprise(`${a.title} ${a.excerpt ?? ""}`),
    );
    console.log(
      `[rss ${sourceId}] 广东企业过滤: ${before} → ${kept.length} 条`,
    );
    return kept;
  }

  return mapped;
}
