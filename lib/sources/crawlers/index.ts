/**
 * 爬虫 runner 入口（M3-A：双采集系统合并）
 *
 * 原 scripts/crawlers/run-all.mjs（IPO 六源 → data/crawled-articles.json）与
 * scripts/crawlers/run-gz.mjs（广州商机三源 → data/crawled-gz.json）的逻辑合并：
 * 由 daily.ts 进程内直接调用本入口，不再 shell 出去写 JSON 中间文件。
 *
 * 每个爬虫独立 try/catch 隔离（单源失败不连坐），结果按 URL 去重。
 */
import type { CrawledArticle } from "../../ingest/merge";
import { BaseCrawler } from "./base-crawler";
// 2026-09-09 IPO 体系重设计：东财双代理（在审/辅导）退役，改用官方三所审核动态 + csrcfd 辅导。
// eastmoney-declare.ts / eastmoney-ipo.ts 文件保留便于恢复（同 hkex 先例），此处不再 import/实例化。
import { CsrcCoachCrawler } from "./sources/csrcfd";
import { SzseAuditCrawler } from "./sources/szse-audit";
import { SseAuditCrawler } from "./sources/sse-audit";
import { BseAuditCrawler } from "./sources/bse-audit";
import { ListedChecker } from "./sources/listed-check";
import { HkFilingCrawler } from "./sources/hk-filing";
// 本地专供 IPO 补数桥（2026-09-11）：把 CI 不可达源（csrcfd / 深交所）的本地抓取产物
// 从 `data/local-ipo.json` 读回来，与在线产物在**同一接入层**汇合。
import { selectLocalIpoItems } from "../local-ipo";
import { GzStatsCrawler } from "./sources/gz-stats";
import { GzGovCrawler } from "./sources/gz-gov";
import { CnfinCrawler } from "./sources/cnfin-web";
import { StcnCrawler } from "./sources/stcn-web";
import { SinaBankCrawler } from "./sources/sina-bank-web";
import { GuanchaCrawler } from "./sources/guancha-web";
// 2026-08-21 广州本地媒体第一梯队（解决"热点发现"）：大洋网广州/南方经济/中新网广东/央广网广东
// （金羊网 ycwb.com 有 JS 反爬壳暂缓，后续专项处理）
import { DayooGzCrawler } from "./sources/dayoo-gz";
import { SouthcnEconomyCrawler } from "./sources/southcn-economy";
import { CnrGdCrawler } from "./sources/cnr-gd";
// 2026-08-25 昨日股市信息源（A股/港股新闻采集）
import { EastMoneyStockCrawler } from "./sources/eastmoney-stock";
import { HKEXStockCrawler } from "./sources/hkex-stock";
// 2026-08-25 新浪港股市场新闻（补足港股解读类内容，披露易公告偏英文公司级）
// 2026-08-27 升级为港股解读主源（用户要求：港股总结走新浪而非东方财富）
import { SinaHkStockCrawler } from "./sources/sina-hk-stock";
import { SinaAStockCrawler } from "./sources/sina-a-stock";
// 2026-08-22：chinanews-gd（中新网广东）命中率 0% 已砍掉，Crawler 文件保留便于未来恢复。
// 2026-08-20 用户决定：取消南沙信息源（只看广州市政府 gz-gov），GzNanshaCrawler 停用，
// 文件保留便于未来恢复。
// 2026-08-20 本地化停用：TonghuashunIPOCrawler / NfraCrawler / PbcCrawler / ClsCrawler
// 已被 WAF 拦截国外 IP，改由本地 skill（local-acquire，scripts/acquire-local.mts）抓取后
// 经 data/local-acquired.json 并入 daily 管线；此处不再 import/实例化（远程不查），
// 文件保留便于未来恢复。

export interface CrawledBundle {
  ipo: CrawledArticle[];
  gz: CrawledArticle[];
  stocks: CrawledArticle[];
}

/** 按 URL 去重（保留首次出现） */
function dedupeByUrl<T extends { url?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const key = it.url || "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * 启用的 IPO 源清单（P1-6，2026-09-10）：抽为导出函数，供注册一致性测试遍历
 * （`tests/ipo-source-registry.test.ts` 读每个实例的 `sourceIds`，校验
 * 「产出的 sourceId ∈ sources.config.json 白名单 且 ∈ SOURCE_ROUTE」）。
 * 此前测试硬编码 5 个 gd-* id，新增 hk-filing / hk-filing-gd 时完全没被覆盖到。
 *
 * 2026-09-11 拆分：本函数**恒返回全量**（注册一致性测试必须覆盖每一个源，不随环境变化，
 * 否则 CI 下漏注册的新源会静默逃过校验）。「哪些源只能本地抓」= `buildLocalOnlyIpoCrawlers()`，
 * 「本次 run 实际抓哪些」= `selectIpoCrawlersForRun()`（CI 跳过本地专供源）。
 */
export function buildIpoCrawlers(): BaseCrawler[] {
  return [...buildLocalOnlyIpoCrawlers(), ...buildOnlineIpoCrawlers()];
}

/**
 * **只能本地抓取**的官方 IPO 源（2026-09-11 用户拍板 + 实锤）。
 *
 * 铁证：这两个源被站点 CDN/WAF 拦 GitHub runner 的海外出口 IP ——
 *   - `csrcfd`（证监会辅导备案）：CI 恒 **405**（阿里云 Tengine/云盾），自 09-09 接入起从未成功；
 *   - **深交所** `www.szse.cn`（审核项目动态；listed-check 的 B2 腿同域同样挂）：CI 恒 `fetch failed`；
 * 本地（国内网络，同版本 Node + 同 headers）实测完全可达（csrcfd 3 条深圳企业 / 深交所 2 条拟创业板）。
 *
 * 产物由本地 skill `local-ipo-sync`（`npm run ipo:local`）写入 `data/local-ipo.json` 入库，
 * 远端 `selectLocalIpoItems()` 从该文件补数 —— **两个源的数据照旧进日报，只是抓取地换到本地**。
 *
 * ⚠️ 白名单一致性红线：`LOCAL_ONLY_IPO_SOURCE_IDS`（`lib/sources/local-ipo.ts`）必须与本清单
 * 一一对应（本地文件的 sourceId 白名单据此校验），由 `tests/local-ipo.test.ts` 断言。
 */
export function buildLocalOnlyIpoCrawlers(): BaseCrawler[] {
  return [new CsrcCoachCrawler(), new SzseAuditCrawler()];
}

/** CI 可达的在线 IPO 源（与本地专供源互补；两集合互斥且并集 = `buildIpoCrawlers()`）。 */
export function buildOnlineIpoCrawlers(): BaseCrawler[] {
  return [new SseAuditCrawler(), new BseAuditCrawler(), new HkFilingCrawler()];
}

/**
 * 「本次 run 实际要跑的 IPO 源」= 在线源 +（**非 CI 环境**才跑本地专供源）。
 *
 * 为什么 CI 要跳过本地专供源：它们从未在 CI 成功过（三次 run 逐字复现），继续跑只是
 * 白等 ~20s 重试退避 + 刷一屏误导性报错；数据已由 `data/local-ipo.json` 补齐。
 * 逃生口：若将来站点放开海外访问，设 `IPO_LOCAL_ONLY_IN_REMOTE=1` 让远端重新尝试。
 */
export function selectIpoCrawlersForRun(): BaseCrawler[] {
  const forceRemoteTry = process.env.IPO_LOCAL_ONLY_IN_REMOTE === "1";
  const isCi = process.env.CI === "true" || process.env.CI === "1";
  const online = buildOnlineIpoCrawlers();
  if (isCi && !forceRemoteTry) {
    const names = buildLocalOnlyIpoCrawlers()
      .map((c) => c.name)
      .join(" / ");
    console.log(
      `[daily] ⏭ CI 环境跳过本地专供 IPO 源（${names}）→ 由 data/local-ipo.json 补数（本地 skill local-ipo-sync 产出）`,
    );
    return online;
  }
  return [...buildLocalOnlyIpoCrawlers(), ...online];
}

/** listed-check 是 IPO 候选的 post-process（非 BaseCrawler 子类），单独导出供测试遍历。 */
export function buildListedChecker(): ListedChecker {
  return new ListedChecker();
}

export async function fetchCrawledArticles(): Promise<CrawledBundle> {
  // —— IPO / 新股（2026-09-09 IPO 体系重设计：东财双代理退役 → 官方源优先）——
  // 2026-08-25 曾全部停用（数据太老/方案要重设计）；08-30 数据源检视后按新方案恢复；
  // 2026-09-09 用户拍板整套重设计（旧体系一周 1 条、sourceId 错位被渲染静默丢弃）：
  //   ✅ CsrcCoachCrawler（2026-09-09 新增）：证监会权威辅导库 csrcfd，倒序早停增量抓（今昨窗口），
  //      sourceId=gd-csrc-tutoring（弃用 em-ipo——config 无注册 → render 白名单丢弃），region='gd' 进「广东地区IPO」。
  //   ⏸ 退役（文件保留便于恢复，同 hkex 先例）：EastMoneyDeclareCrawler（东财在审代理，源稀疏近7天广东仅1条）
  //      / EastMoneyIPOCrawler（东财辅导代理，全国前100条上限漏广东）。
  //   ✅ SzseAuditCrawler（2026-09-09 P1）：深交所审核项目动态 projectrends/query（GET），
  //      updtdt 严格倒序 → 窗口内过滤 + 倒序早停（发 1~2 请求），sourceId=gd-szse-audit，
  //      官方 regloc 字段判定广东（替代东财在审代理，源稀疏根因）。region='gd' 进「广东地区IPO」。
  //   ✅ SseAuditCrawler（2026-09-10 P2a）：上交所审核项目动态 commonSoaQuery.do（sqlId=SH_XM_LB），
  //      currStatus 1~9 分批（防漂移丢主板）+ 各状态内 updateDate 倒序早停，sourceId=gd-sse-audit，
  //      官方 s_province 判定广东。region='gd' 进「广东地区IPO」。
  //   ✅ BseAuditCrawler（2026-09-10 P2b）：北交所审核项目动态 infoSelectResult.do（cookie 预热），
  //      registerAddress 前缀"广东省"判定，updateDate 倒序早停，sourceId=gd-bse-audit。region='gd'。
  //   🔜 P3：listed-check（候选复核，不拉全量）将作为 post-process 挂接在 ipo 候选上。
  //   ⏸ 停用（文件保留）：HKEXCrawler（港股披露易，对 A 股在审无意义）/ SSEAPI·SZSEAPI
  //      （巨潮 cninfo 只能检索**已上市**证券，对在审企业无效）/ BSEAPICrawler（北交所发行期）。
  //   ✅ HkFilingCrawler（2026-09-10 batch 5）：港交所披露易「处理中申请」JSON 接口
  //      （主板 appactive_app_sehk_c / GEM appactive_app_gem_c），与官网综合索引 xlsx 同源、
  //      结构化、零解析依赖。繁体申请人名识别广东企业 → hk-filing-gd（gd-ipo 跨境融资商机），
  //      其余 → hk-filing（ipo 全国参考）。窗口 365d + 上限 40 条音量控制。
  // 2026-09-11：源集合二分（在线 / 本地专供）见 selectIpoCrawlersForRun 注释。
  const ipoCrawlers = selectIpoCrawlersForRun();

  const ipo: CrawledArticle[] = [];
  for (const crawler of ipoCrawlers) {
    try {
      await crawler.run();
      ipo.push(...(crawler.toGzcmbdf3Format() as CrawledArticle[]));
    } catch (err) {
      console.error(`[${crawler.name}] 爬虫异常:`, (err as Error).message);
    }
  }

  // 本地专供源补数（2026-09-11）：与上面在线爬虫产物汇入**同一个 ipo 批次**，
  // 之后仍走 mergeCrawledBatch(..., "ipo") 归一化 —— 下游（漏斗 / gdIpo / render）
  // 完全无法也不需要区分条目来自本地还是在线。见 lib/sources/local-ipo.ts。
  ipo.push(...selectLocalIpoItems(ipo));

  // P3 listed-check（候选复核，不拉全量）：拉近期广东上市字典 → 发现已上市卡片 + 复核候选升级 stage-listed
  // 单源失败由 ListedChecker 内部兜底，不连坐。
  try {
    const listed = await buildListedChecker().run(ipo);
    if (listed.length) ipo.push(...(listed as CrawledArticle[]));
  } catch (err) {
    console.error(`[listed-check] 复核异常:`, (err as Error).message);
  }

  // —— 广州商机 + 财经媒体（2026-08-20 起南沙停用；nfra/pbc/cls 已本地化停用）→ 取原始 results（保留 category/subcategory/region/sourceId）——
  // 注：nfra/pbc/cls（国家金融监督管理总局/中国人民银行/财联社）被 WAF 拦国外 IP，
  // 已本地化停用（本地 skill local-acquire → data/local-acquired.json → daily 读取并入）；
  // 其 SOURCE_ROUTE（finance/cn-policy、finance/cn-finance）仍保留供 local-acquired 路由。
  // 2026-08-25 用户决定：废弃广州市政府 gz-gov / 广州统计局 gz-stats（数据太老，无用），代码保留
  const gzCrawlers: BaseCrawler[] = [
    // new GzStatsCrawler(),  // 2026-08-25 废弃：数据太老
    // new GzGovCrawler(),    // 2026-08-25 废弃：数据太老
    new CnfinCrawler(),
    new StcnCrawler(),
    new SinaBankCrawler(),
    new GuanchaCrawler(),
    // 2026-08-21 广州本地媒体第一梯队（config enabled:false + 实测通过后启用）
    new DayooGzCrawler(),
    new SouthcnEconomyCrawler(),
    // 2026-08-22：chinanews-gd 命中率 0% 已停用（Crawler 类保留）
    new CnrGdCrawler(),
  ];

  const gz: CrawledArticle[] = [];
  for (const crawler of gzCrawlers) {
    try {
      await crawler.run();
      gz.push(...(crawler.results as CrawledArticle[]));
    } catch (err) {
      console.error(`[${crawler.name}] 异常:`, (err as Error).message);
    }
  }

  // —— 昨日股市信息源（2026-08-25 新增）：A股（东方财富 + 新浪A股交叉验证）+ 港股（披露易公告 + 新浪港股解读）——
  // 美股由 RSS 源 investing-news 走 fetchAll 抓取（CI 可达），不在此列。
  const stocksCrawlers: BaseCrawler[] = [
    new EastMoneyStockCrawler(),
    new SinaAStockCrawler(),
    // ⏸ HKEXStockCrawler（港交所披露易）：2026-09-05 用户拍板关闭。
    //   理由：40 条全英文公司级公告，rankHkStockItems 永远把它排在最后（进不了 LLM 的 top12），
    //   纯抓不用；港股解读主源已是 SinaHkStockCrawler，IPO 另有东财专源。文件保留便于恢复。
    // new HKEXStockCrawler(),
    new SinaHkStockCrawler(),
  ];

  const stocks: CrawledArticle[] = [];
  for (const crawler of stocksCrawlers) {
    try {
      await crawler.run();
      stocks.push(...(crawler.results as CrawledArticle[]));
    } catch (err) {
      console.error(`[${crawler.name}] 异常:`, (err as Error).message);
    }
  }

  return { ipo: dedupeByUrl(ipo), gz: dedupeByUrl(gz), stocks: dedupeByUrl(stocks) };
}
