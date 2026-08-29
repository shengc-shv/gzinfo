// 2026-08-22 降本：以下命中率偏低（10%~34%）但保留作本地热点发现的爬虫源，
// 每源每天最多取 LIGHT_AI_MAX_PER_SOURCE 条进 AI 管线，且 raw_text 截断到 LIGHT_AI_RAW_CAP 字，
// 两项叠加使 PASS1 对它们的 token 占用降 ~90%（PASS2 本就很少为低命中源成稿）。
// 2026-08-25 用户指令（永久）：所有媒体数据采集，每源每天 ≤10 条进入 LLM 分析与展示
// （daily.ts 调用处以全源集合 cap，LIGHT_AI_SOURCES 保留为 raw 截断标记集）。
export const LIGHT_AI_SOURCES = new Set<string>([
  "cnfin",
  "stcn",
  "dayoo-gz",
  "southcn",
  "cnr-gd",
]);
export const LIGHT_AI_MAX_PER_SOURCE = 10;
export const LIGHT_AI_RAW_CAP = 200;

export interface LightAiArticle {
  sourceId?: string;
  publishedAt?: Date;
}

/**
 * 对 lightAi 源按 sourceId 分组、每源保留 maxPer 条；其余源原样保留。
 * 用于降 AI 管线 token 占用：低命中率源只取少量条目送 PASS1。
 *
 * 排序键（2026-08-29 价值预筛）：传入 scorer 时按「分行相关性评分」降序取，
 * 无 scorer 时退化为「最新优先」。让高分行相关性条目优先进 AI（命中「价值优先」+
 * 「节约AI」），低价值条目让位；同分时仍按发布时间倒序保证新事件不漏。
 */
export function capLightAiSources<T extends LightAiArticle>(
  articles: T[],
  lightSet: Set<string>,
  maxPer: number,
  scorer?: (a: T) => number,
): T[] {
  const lightGroups = new Map<string, T[]>();
  const others: T[] = [];
  for (const a of articles) {
    const sid = a.sourceId ?? "";
    if (lightSet.has(sid)) {
      if (!lightGroups.has(sid)) lightGroups.set(sid, []);
      lightGroups.get(sid)!.push(a);
    } else {
      others.push(a);
    }
  }
  const capped: T[] = [];
  for (const items of lightGroups.values()) {
    items.sort((x, y) => {
      const sx = scorer ? scorer(x) : (x.publishedAt?.getTime() ?? 0);
      const sy = scorer ? scorer(y) : (y.publishedAt?.getTime() ?? 0);
      if (sy !== sx) return sy - sx;
      return (y.publishedAt?.getTime() ?? 0) - (x.publishedAt?.getTime() ?? 0);
    });
    capped.push(...items.slice(0, maxPer));
  }
  return [...others, ...capped];
}
