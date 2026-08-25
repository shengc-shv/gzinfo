import { fetchAttentionVc } from "./attentionvc";
import { fetchCctvFinance, fetchNbd, fetchSinaFinance } from "./domestic-finance";
import { fetchGovCnPolicy } from "./national-policy";
import { fetchSinaMoney, fetch21jingjiFinance } from "./wealth-credit";
import { fetchGithubTrending } from "./github-trending";
import { fetchHackerNews } from "./hackernews";
import { fetchHuggingfacePapers } from "./huggingface-papers";
import { fetchLinuxDo } from "./linuxdo";
import { fetchRss } from "./rss";
import { fetchV2ex } from "./v2ex";
import type { RawArticle, SourceDef } from "./types";
import { SOURCE_ROUTE } from "./constants";

/**
 * 节约 AI 成本（用户 2026-08-18）：除商机类来源外，每个资讯源每轮最多取 10 条。
 * 抓得少 → enrich/分类的 LLM 调用少。
 * 商机类来源（广州本地 gz-stats/gz-gov/gz-nansha 及广州辖区 IPO）由 TS 爬虫
 * lib/sources/crawlers 产出（fetchCrawledArticles 进程内调用）、不走 dispatch；
 * 白名单由集中路由表 SOURCE_ROUTE（category=gz 或 gz-policy）派生，防止未来误 cap 商机源。
 */
const BUSINESS_SOURCES: ReadonlySet<string> = new Set(
  Object.entries(SOURCE_ROUTE)
    .filter(([, r]) => r.category === "gz" || r.subcategory === "gz-policy")
    .map(([id]) => id),
);
const PER_SOURCE_FETCH_CAP = 10;

export async function fetchSource(source: SourceDef): Promise<RawArticle[]> {
  let items: RawArticle[];
  if (source.id === "hackernews") items = await fetchHackerNews(source.id);
  else if (source.id === "github-trending") items = await fetchGithubTrending(source.id);
  else if (source.id === "v2ex-hot") items = await fetchV2ex(source.id);
  else if (source.id === "linuxdo") items = await fetchLinuxDo(source.id);
  else if (source.id === "attentionvc-ai") items = await fetchAttentionVc(source.id);
  else if (source.id === "huggingface-papers") items = await fetchHuggingfacePapers(source.id, source.keywords);
  else if (source.id === "sina-finance") items = await fetchSinaFinance(source.id);
  else if (source.id === "cctv-finance") items = await fetchCctvFinance(source.id);
  else if (source.id === "nbd") items = await fetchNbd(source.id);
  else if (source.id === "govcn-policy") items = await fetchGovCnPolicy(source.id);
  else if (source.id === "sina-money") items = await fetchSinaMoney(source.id);
  else if (source.id === "21jingji-finance") items = await fetch21jingjiFinance(source.id);
  else
    items = await fetchRss(source.id, source.url, source.category, {
      useCurl: source.useCurl,
      keywords: source.keywords,
      ...(source.category === "stocks" ? { subcategory: source.subcategory } : {}),
    });
  return BUSINESS_SOURCES.has(source.id) ? items : items.slice(0, PER_SOURCE_FETCH_CAP);
}
