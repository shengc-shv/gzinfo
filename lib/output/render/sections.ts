/**
 * 渲染 sections（M3-C 二期拆分自 lib/output/render.ts）：
 * 市场行情/交易面板与执行摘要板块（trading/executive）。
 */
import { STR } from "./i18n";
import { REPORT_LOCALE } from "../../sources/registry";
import { getAssetGroupLabels, ASSET_GROUP_ORDER, type AssetGroup } from "../../trading/watchlist";
import type { TradingSection } from "../../types";
import type { WatchlistPick } from "../../ai/trading-commentary";
import type { TickerAnalysis } from "../../trading/signals";
import type { ExecutiveSummary } from "../../ai/executive-summary";
import { escapeHtml } from "./cards";

const ASSET_GROUP_LABELS_LOCALIZED = getAssetGroupLabels(REPORT_LOCALE);

export const TREND_LABEL: Record<TickerAnalysis["trend"], string> = {
  bullish: STR.trendBullish,
  bearish: STR.trendBearish,
  neutral: STR.trendNeutral,
};

export function stanceClass(stance: string): "bull" | "bear" | "neutral" {
  // Supports both legacy ("看多"/"看空") and current ("偏上行"/"偏下行")
  // stance values. The current values were chosen to avoid Sonnet's
  // "no investment advice" guardrail; rendering keeps both readable.
  if (/多|涨|上行|bull/i.test(stance)) return "bull";
  if (/空|跌|下行|bear/i.test(stance)) return "bear";
  return "neutral";
}

export function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  // Use thousand separators only for prices >= 1000
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(dp).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n.toFixed(dp);
}

export function fmtPct(n: number, dp = 2): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(dp)}%`;
}

export function renderPickCard(p: WatchlistPick): string {
  const cls = stanceClass(p.stance);
  const symbol = escapeHtml(p.symbol);
  const name = escapeHtml(p.display_name ?? p.symbol);
  const stance = escapeHtml(p.stance);
  const rationale = escapeHtml(p.rationale ?? "");
  return `<article class="trading-pick stance-${cls}">
    <header class="pick-head">
      <div class="pick-symbol-block">
        <span class="pick-symbol">${symbol}</span>
        <span class="pick-name">${name}</span>
      </div>
      <span class="pick-stance pick-stance-${cls}">${stance}</span>
    </header>
    <p class="pick-rationale">${rationale}</p>
  </article>`;
}

export function renderTickerCard(t: TickerAnalysis): string {
  const trendCls = t.trend;
  const priceCls = t.pct1Day >= 0 ? "positive" : "negative";
  const pct5Cls = t.pct5Day >= 0 ? "positive" : "negative";
  const signals = t.signals
    .map((s) => {
      const tone = SIGNAL_TONE[s.type] ?? "caution";
      const ageSuffix =
        s.daysAgo !== undefined
          ? ` <span class="signal-age">(${s.daysAgo === 0 ? STR.signalToday : `${s.daysAgo} ${STR.signalDaysAgoSuffix}`})</span>`
          : "";
      return `<span class="signal-pill tone-${tone}">${escapeHtml(s.label)}${ageSuffix}</span>`;
    })
    .join("");
  const currencyPrefix = t.currency === "USD" ? "$" : t.currency === "HKD" ? "HK$" : t.currency === "CNY" ? "¥" : "";
  return `<article class="ticker-card">
    <header class="ticker-head">
      <div class="ticker-id">
        <h3 class="ticker-symbol">${escapeHtml(t.symbol)}</h3>
        <p class="ticker-name">${escapeHtml(t.displayName)}</p>
      </div>
      <div class="ticker-price-block">
        <span class="ticker-price">${currencyPrefix}${fmtNum(t.currentPrice)}</span>
        <span class="ticker-pct ${priceCls}">${fmtPct(t.pct1Day)}</span>
      </div>
    </header>
    <dl class="ticker-indicators">
      <div><dt>${STR.ticker5d}</dt><dd class="${pct5Cls}">${fmtPct(t.pct5Day)}</dd></div>
      <div><dt>${STR.tickerVs52wHigh}</dt><dd>${fmtPct(t.pct52WeekHigh, 1)}</dd></div>
      <div><dt>RSI(14)</dt><dd class="rsi-${t.rsiState}">${fmtNum(t.rsi14, 1)}</dd></div>
      <div><dt>${STR.tickerTrend}</dt><dd class="trend-${trendCls}">${TREND_LABEL[t.trend]}</dd></div>
      <div><dt>SMA 20 / 50 / 200</dt><dd>${fmtNum(t.sma20)} / ${fmtNum(t.sma50)} / ${fmtNum(t.sma200)}</dd></div>
      <div><dt>${STR.tickerMacd}</dt><dd>${fmtNum(t.macd, 3)} / ${fmtNum(t.macdSignal, 3)}</dd></div>
    </dl>
    ${signals ? `<div class="ticker-signals">${signals}</div>` : ""}
  </article>`;
}

export function fearGreedTone(value: number): "fear-extreme" | "fear" | "neutral" | "greed" | "greed-extreme" {
  if (value <= 24) return "fear-extreme";
  if (value <= 44) return "fear";
  if (value <= 55) return "neutral";
  if (value <= 74) return "greed";
  return "greed-extreme";
}

export function fmtBigUsd(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)} T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)} B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)} M`;
  return `$${n.toFixed(0)}`;
}

export function renderCryptoWidgets(t: TradingSection): string {
  const fg = t.crypto_fear_greed;
  const cg = t.crypto_global;
  if (!fg && !cg) return "";
  const items: string[] = [];
  if (fg) {
    const tone = fearGreedTone(fg.value);
    items.push(`<div class="crypto-widget fg-${tone}">
      <div class="widget-label">${STR.widgetCryptoFearGreed}</div>
      <div class="widget-value">${fg.value}</div>
      <div class="widget-sub">${escapeHtml(fg.classificationCn)}</div>
    </div>`);
  }
  if (cg) {
    const tone = cg.marketCapChangePct24h >= 0 ? "positive" : "negative";
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetCryptoCap}</div>
      <div class="widget-value">${fmtBigUsd(cg.totalMarketCapUsd)}</div>
      <div class="widget-sub ${tone}">${fmtPct(cg.marketCapChangePct24h)} / 24h</div>
    </div>`);
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetBtcDom}</div>
      <div class="widget-value">${cg.btcDominance.toFixed(1)}%</div>
      <div class="widget-sub">ETH ${cg.ethDominance.toFixed(1)}%</div>
    </div>`);
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetVolume24h}</div>
      <div class="widget-value">${fmtBigUsd(cg.total24hVolumeUsd)}</div>
      <div class="widget-sub">${STR.widgetActiveCoins} ${cg.activeCryptocurrencies.toLocaleString()}</div>
    </div>`);
  }
  return `<div class="crypto-widgets">${items.join("")}</div>`;
}

/** 商机 tag 色系（2026-08-21 重构 #6：统一 cmb 红及衍生色系，业务线可辨识） */
function tagClsOf(tag: string): string {
  if (/财富|私行/.test(tag)) return "t-wealth";
  if (/代发|客群/.test(tag)) return "t-mass";
  if (/政银|住房|监管|政策/.test(tag)) return "t-policy";
  return "";
}

/**
 * 执行摘要板块：今日必读 + 商机洞察（页面顶部横幅）。
 * 2026-08-21 重构 #5/#6：商机洞察默认展开（去折叠）；insights 带业务线中文 tag。
 */
export function renderExecutiveSummary(exec: ExecutiveSummary): string {
  const must = exec.must_read
    .map((m, i) => {
      const body = `<strong>${escapeHtml(m.title)}</strong><span class="must-why">${escapeHtml(m.why)}</span>`;
      const inner = m.url
        ? `<a class="must-body must-link" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${body}</a>`
        : `<div class="must-body">${body}</div>`;
      return `<li class="must-card">
        <span class="must-index">${i + 1}</span>
        ${inner}
      </li>`;
    })
    .join("");
  const insights = exec.insights
    .map((it) => {
      const srcMarks = (it.sources && it.sources.length > 0)
        ? ` <span class="insight-srcs">${it.sources.slice(0, 3).map((s, i) =>
            `<a class="insight-src" href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(s.title || "来源" + (i + 1))}" aria-label="来源${i + 1}">${["①","②","③","④","⑤"][i]}</a>`
          ).join("")}</span>`
        : "";
      return `<article class="insight">
        ${(it.tag ?? []).length > 0
          ? `<div class="insight-tags">${(it.tag ?? [])
              .map((t) => `<span class="tag ${tagClsOf(t)}">${escapeHtml(t)}</span>`)
              .join("")}</div>`
          : ""}
        <h3>${escapeHtml(it.topic)}${srcMarks}</h3>
        <p><b>影响：</b>${escapeHtml(it.impact)}</p>
        <p><b>建议：</b>${escapeHtml(it.action)}</p>
      </article>`;
    })
    .join("");
  return `<section class="exec-summary">
    <div class="exec-head">
      <h2 class="exec-title">执行摘要</h2>
      <span class="exec-sub">今日必读 · 商机洞察（AI 生成）</span>
    </div>
    <div class="exec-must">
      <h3 class="exec-col-title">📌 今日必读<span class="must-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3>
      <ul class="must-scroller">${must}</ul>
    </div>
    <div class="exec-insights">
      <h3 class="exec-col-title">💡 商机洞察（默认展开）</h3>
      <div class="insight-grid">${insights}</div>
    </div>
  </section>`;
}

/**
 * 市场总览卡（2026-08-21 重构 #17/#18/#19）：用 tickers 结构化渲染 A股/汇率/商品/海外
 * 四条 bullet，替代 300 字技术流长文；不渲染货币符号（修 $4.70/$16.01 bug）。
 * 行情语言规则化人话化：多头/空头/中性 + RSI 超买/超卖 + 52周位次。
 */
export function renderMarketOverview(trading: TradingSection, date: string): string {
  const tickers = trading.tickers ?? [];
  if (tickers.length === 0) return "";
  const fmtPct = (v?: number): string =>
    v === undefined || Number.isNaN(v) ? "" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
  const trendLabel = (t: TickerAnalysis): string =>
    t.trend === "bullish" ? "多头排列" : t.trend === "bearish" ? "空头排列" : "方向待定";
  const rsiLabel = (t: TickerAnalysis): string =>
    t.rsiState === "overbought" ? "RSI 超买" : t.rsiState === "oversold" ? "深度超卖" : "RSI 中性";
  const pos52 = (t: TickerAnalysis): string => {
    if (t.pct52WeekHigh === undefined || Number.isNaN(t.pct52WeekHigh)) return "";
    return t.pct52WeekHigh > -3 ? "贴近52周高位" : "远离52周高位";
  };
  const cnEq = tickers.filter((t) => t.group === "china-equity");
  const fx = tickers.filter((t) => /CNY|CNH/.test(t.symbol));
  const comm = tickers.filter((t) => t.group === "commodity-fx" && !/CNY|CNH/.test(t.symbol));
  const oseas = tickers.filter((t) => t.group === "macro" || t.group === "us-equity");
  const bullets: string[] = [];
  if (cnEq.length) {
    bullets.push(`<li><b>A股：</b>${cnEq
      .map((t) => `${t.displayName} ${t.currentPrice?.toFixed(0) ?? ""}（${fmtPct(t.pct1Day)}，${trendLabel(t)}）`)
      .join("；")}</li>`);
  }
  if (fx.length) {
    bullets.push(`<li><b>汇率：</b>${fx
      .map((t) => `${t.displayName} ${t.currentPrice?.toFixed(2) ?? ""}（${fmtPct(t.pct1Day)}，${rsiLabel(t)}，${pos52(t)}）`)
      .join("；")}</li>`);
  }
  if (comm.length) {
    bullets.push(`<li><b>商品：</b>${comm
      .map((t) => `${t.displayName} ${t.currentPrice?.toFixed(2) ?? ""}（5日${fmtPct(t.pct5Day)}，${rsiLabel(t)}）`)
      .join("；")}</li>`);
  }
  if (oseas.length) {
    bullets.push(`<li><b>海外：</b>${oseas
      .map((t) => `${t.displayName} ${t.currentPrice?.toFixed(2) ?? ""}（单日${fmtPct(t.pct1Day)}${t.symbol.includes("VIX") ? "" : `，${pos52(t)}`}）`)
      .join("；")}</li>`);
  }
  if (bullets.length === 0) return "";
  return `<section class="brief market-card">
  <div class="bm"><span class="src-badge src-official">市场</span><span>截至 ${escapeHtml(date)}</span></div>
  <h3>市场总览</h3>
  <ul class="market-bullets">${bullets.join("")}</ul>
</section>`;
}

export function renderTradingPanel(trading: TradingSection): string {
  const tickers = trading.tickers;
  const groupCounts: Record<AssetGroup, number> = {
    "us-equity": 0,
    crypto: 0,
    "china-equity": 0,
    "commodity-fx": 0,
    macro: 0,
  };
  for (const t of tickers) groupCounts[t.group as AssetGroup] = (groupCounts[t.group as AssetGroup] ?? 0) + 1;

  // 2026-08-21：过滤无 ticker 的分组（加密组已移除），只渲染有资产的组 tab
  const activeGroups = ASSET_GROUP_ORDER.filter((g) => (groupCounts[g] ?? 0) > 0);

  const groupTabs = activeGroups.map(
    (g, i) =>
      `<button class="trading-group-tab${i === 0 ? " active" : ""}" data-group="${g}">${escapeHtml(ASSET_GROUP_LABELS_LOCALIZED[g])}<span class="count">${groupCounts[g] ?? 0}</span></button>`,
  ).join("");

  const groupPanels = activeGroups.map((g, i) => {
    const groupTickers = tickers.filter((t) => t.group === g);
    return `<div class="trading-group-content${i === 0 ? " active" : ""}" data-group="${g}">
      ${groupTickers.length === 0 ? `<p class="empty">${STR.emptyGroup}</p>` : groupTickers.map(renderTickerCard).join("")}
    </div>`;
  }).join("");

  const overview = escapeHtml(trading.market_overview ?? "");
  const risk = escapeHtml(trading.risk_caveat ?? "");

  return `${overview ? `<section class="trading-overview-card">
    <span class="eyebrow">${STR.tradingMarketOverview}</span>
    <p class="overview-text trading-overview-text">${overview}</p>
  </section>` : ""}

  ${
    (trading.watchlist ?? []).length > 0
      ? `<section class="trading-watchlist">
    <h2 class="category-title trading-section-title">${STR.tradingTodayFocus}</h2>
    <div class="trading-picks">
      ${(trading.watchlist ?? []).map(renderPickCard).join("\n")}
    </div>
  </section>`
      : ""
  }

  <section class="trading-tickers">
    <h2 class="category-title trading-section-title">${STR.tradingAllAssets}</h2>
    <nav class="trading-group-tabs">${groupTabs}</nav>
    <div class="trading-group-contents">${groupPanels}</div>
  </section>

  ${
    risk
      ? `<section class="trading-risk">
    <span class="eyebrow">${STR.tradingRiskCaveat}</span>
    <p>${risk}</p>
  </section>`
      : ""
  }`;
}

const SIGNAL_TONE: Record<string, "bull" | "bear" | "caution"> = {
  buy: "bull",
  sell: "bear",
  hold: "caution",
  neutral: "caution",
};
