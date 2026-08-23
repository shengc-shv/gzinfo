/**
 * 渲染主题（M3-C 拆分自 lib/output/render.ts）：
 * 全站 CSS（THEME_CSS，静态无插值）与源等级角标配色（TIER_COLORS）。
 */
import type { SourceTier } from "../../sources/tiers";

export const TIER_COLORS: Record<SourceTier, string> = {
    T1: "#c0392b",
    "T1.5": "#b9770e",
    T2: "#6b7280",
};

/** 全站样式（renderHtml 的 <style> 内容，静态文本、无插值）。 */
export const THEME_CSS = `
  :root {
    --bg: #f6f5f3;
    --bg-elevated: #ffffff;
    --fg: #1a1a1f;
    --fg-soft: #4a4a52;
    --muted: #797986;
    --rule: #e7e5e1;
    --card: #ffffff;
    --card-alt: #f1efec;
    --link: #2f4cdd;
    --accent: #1a1a1f;
    --accent-fg: #ffffff;
    --accent-cmb: #e60012;
    --rank-high-bg: #fde8e8;
    --rank-high-fg: #c01c1c;
    --rank-mid-bg: #fdf0d9;
    --rank-mid-fg: #9a5b09;
    --rank-low-bg: #e6e9fd;
    --rank-low-fg: #3b36a8;
    --c-tech: #4f46e5;
    --c-trading: #0d9488;
    --c-finance: #d97706;
    --c-gdipo: #e11d48;
    --c-ipo: #7c3aed;
    --c-gz: #059669;
    --c-pol: #2f6fed;
    --hero-grad-from: #f6f5f3;
    --hero-grad-to: #efedea;
    --r-sm: 0.5rem;
    --r-md: 0.75rem;
    --r-lg: 1rem;
    --shadow-sm: 0 1px 2px rgba(20, 20, 30, 0.05), 0 1px 3px rgba(20, 20, 30, 0.06);
    --shadow-md: 0 6px 16px rgba(20, 20, 30, 0.09);
    --shadow-lg: 0 14px 32px rgba(20, 20, 30, 0.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0d11;
      --bg-elevated: #15191f;
      --fg: #f3f4f6;
      --fg-soft: #c2c6cf;
      --muted: #8b909c;
      --rule: #262b33;
      --card: #15191f;
      --card-alt: #1b2027;
      --link: #8aa0ff;
    --accent: #f3f4f6;
    --accent-fg: #0b0d11;
    --accent-cmb: #ff5a5f;
      --rank-high-bg: rgba(239, 68, 68, 0.16);
      --rank-high-fg: #fca5a5;
      --rank-mid-bg: rgba(245, 158, 11, 0.16);
      --rank-mid-fg: #fcd34d;
      --rank-low-bg: rgba(99, 102, 241, 0.16);
      --rank-low-fg: #a5b4fc;
      --c-tech: #818cf8;
      --c-trading: #2dd4bf;
      --c-finance: #fbbf24;
      --c-gdipo: #fb7185;
      --c-ipo: #a78bfa;
      --c-gz: #34d399;
      --c-pol: #5b8def;
      --hero-grad-from: #15191f;
      --hero-grad-to: #0b0d11;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
      --shadow-md: 0 6px 16px rgba(0, 0, 0, 0.5);
      --shadow-lg: 0 14px 32px rgba(0, 0, 0, 0.55);
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    line-height: 1.62;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  ::selection { background: rgba(79, 70, 229, 0.22); }
  main { max-width: 1040px; margin: 0 auto; padding: 2.75rem 1.5rem 4rem; }

  /* ===== header / masthead ===== */
  header.report-header {
    margin-bottom: 0.5rem;
    padding-bottom: 1.4rem;
    border-bottom: 1px solid var(--rule);
  }
  .eyebrow {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    color: var(--muted);
    font-weight: 500;
  }
  h1.report-title {
    font-family: Georgia, "Times New Roman", "Songti SC", "Noto Serif CJK SC", serif;
    font-size: 2.6rem;
    font-weight: 700;
    margin: 0.5rem 0 0.2rem;
    letter-spacing: -0.01em;
    line-height: 1.08;
  }
  .archive-link {
    display: inline-block;
    margin-top: 0.9rem;
    font-size: 0.85rem;
    color: var(--muted);
    text-decoration: none;
    border-bottom: 1px dashed var(--rule);
    padding-bottom: 1px;
    transition: color 0.15s, border-color 0.15s;
  }
  .archive-link:hover { color: var(--accent); border-bottom-style: solid; }

  /* per-category accent wiring */
  .panel[data-panel="tech"] { --cat: var(--c-tech); }
  .panel[data-panel="trading"] { --cat: var(--c-trading); }
  .panel[data-panel="finance"] { --cat: var(--c-finance); }
  .panel[data-panel="gd-ipo"] { --cat: var(--c-gdipo); }
  .panel[data-panel="ipo"] { --cat: var(--c-ipo); }
  .panel[data-panel="gz"] { --cat: var(--c-gz); }
  .tab[data-tab="tech"] { --cat: var(--c-tech); }
  .tab[data-tab="trading"] { --cat: var(--c-trading); }
  .tab[data-tab="finance"] { --cat: var(--c-finance); }
  .tab[data-tab="gd-ipo"] { --cat: var(--c-gdipo); }
  .tab[data-tab="ipo"] { --cat: var(--c-ipo); }
  .tab[data-tab="gz"] { --cat: var(--c-gz); }

  .hero-card {
    margin-top: 1.4rem;
    background: linear-gradient(135deg, var(--hero-grad-from) 0%, var(--hero-grad-to) 100%);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--c-tech);
    padding: 1.1rem 1.5rem;
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
  }
  .hero-eyebrow {
    font-size: 0.7rem;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 500;
  }
  .hero-headline {
    font-size: 1.3rem;
    font-weight: 600;
    margin: 0.4rem 0 0;
    line-height: 1.5;
    color: var(--fg);
  }
  .overview-card {
    margin: 0.8rem 0 0;
    padding: 0.8rem 1.2rem;
    background: var(--card-alt);
    border-radius: var(--r-md);
    border-left: 3px solid var(--muted);
  }
  .overview-card .eyebrow { display: block; margin-bottom: 0.3rem; }
  .overview-text {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.7;
    color: var(--fg-soft);
  }

  /* ===== 执行摘要板块（今日必读 + 商机提示，移动端优先折叠）===== */
  .exec-summary {
    margin: 1rem 0 0.4rem;
    border: 1px solid color-mix(in srgb, var(--accent-cmb) 22%, transparent);
    border-left: 4px solid var(--accent-cmb);
    border-radius: 14px;
    padding: 0.85rem 1rem;
    background: color-mix(in srgb, var(--accent-cmb) 5%, var(--bg));
    box-shadow: var(--shadow-md);
  }
  .exec-head { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.55rem; }
  .exec-title { margin: 0; font-size: 1.02rem; color: var(--fg); letter-spacing: 0.02em; }
  .exec-sub { font-size: 0.72rem; color: var(--muted); }
  .exec-col-title { margin: 0 0 0.45rem; font-size: 0.8rem; color: var(--muted); font-weight: 600; }

  /* 今日必读：横向滑动卡片（Apple News 风），桌面转为 5 列网格 */
  .exec-must { position: relative; margin-bottom: 0.5rem; }
  .must-scroller {
    list-style: none; margin: 0; padding: 0 0.75rem 0.5rem 0;
    display: flex; flex-direction: row; gap: 0.5rem;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
    scroll-snap-type: x mandatory;
    scrollbar-width: thin; scrollbar-color: var(--rule) transparent;
  }
  .must-scroller::-webkit-scrollbar { height: 5px; }
  .must-scroller::-webkit-scrollbar-thumb { background: var(--rule); border-radius: 4px; }
  .must-card {
    flex: 0 0 auto; width: 80vw; max-width: 300px;
    display: flex; gap: 0.55rem; align-items: flex-start;
    border: 1px solid var(--rule); border-radius: 12px;
    padding: 0.6rem 0.75rem; background: var(--bg-elevated);
    box-shadow: var(--shadow-sm);
  }
  /* 移动端横向滑动提示：右侧渐隐遮罩，暗示右侧还有更多必读卡片 */
  .exec-must::after {
    content: ""; position: absolute; top: 1.7rem; right: 0; bottom: 0.5rem;
    width: 3.25rem; pointer-events: none; z-index: 3;
    background: linear-gradient(to left, color-mix(in srgb, var(--accent-cmb) 16%, var(--bg)) 0%, color-mix(in srgb, var(--accent-cmb) 4%, transparent) 55%, transparent 100%);
  }
  /* 今日必读标题旁的滑动提示（移动端横向滑动时可见；桌面网格下隐藏） */
  .must-hint-inline {
    display: inline-block; margin-left: 0.45rem; vertical-align: middle;
    font-size: 0.68rem; font-weight: 500; color: var(--accent-cmb);
    white-space: nowrap;
  }
  .must-hint-inline .hint-arrow { display: inline-block; animation: nudge 1.1s ease-in-out infinite; }
  @keyframes nudge { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(4px); } }
  .must-link { text-decoration: none; color: inherit; border-radius: 8px; transition: border-color 0.15s ease; }
  .must-link:hover strong { color: var(--accent-cmb); }
  .must-card:hover { border-color: color-mix(in srgb, var(--accent-cmb) 40%, var(--rule)); }
  .must-index {
    flex: none; width: 1.2rem; height: 1.2rem; border-radius: 50%;
    background: var(--accent-cmb); color: #fff; font-size: 0.72rem; font-weight: 700;
    display: inline-flex; align-items: center; justify-content: center; margin-top: 0.05rem;
  }
  .must-body { display: flex; flex-direction: column; min-width: 0; }
  .must-body strong { font-size: 0.85rem; color: var(--fg); font-weight: 600; line-height: 1.35; }
  .must-why {
    font-size: 0.74rem; color: var(--fg-soft); line-height: 1.45; margin-top: 0.2rem;
  }
  @media (min-width: 720px) {
    /* 必读卡片自适应列数：不足 5 条时不再留白撑开（auto-fit 按条数收窄），
       最多 5 列；避免「执行摘要条数少 → 版面被商机洞察撑大」的失衡。 */
    .must-scroller { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); overflow: visible; padding-bottom: 0; padding-right: 0; scroll-snap-type: none; }
    .must-card { width: auto; max-width: none; }
    /* 桌面转为网格后无横向滑动，渐隐遮罩与滑动提示均隐藏 */
    .exec-must::after { display: none; }
    .must-hint-inline { display: none; }
  }

  /* 商机提示：默认折叠，点击展开 */
  .exec-insights { margin-top: 0.2rem; }
  .insight-toggle {
    display: inline-flex; align-items: center; justify-content: space-between; gap: 0.3rem;
    width: 100%; box-sizing: border-box;
    background: color-mix(in srgb, var(--accent-cmb) 8%, var(--bg));
    border: 1px solid color-mix(in srgb, var(--accent-cmb) 22%, transparent);
    color: var(--accent-cmb); font-weight: 600; font-size: 0.84rem;
    border-radius: 10px; padding: 0.55rem 0.8rem; cursor: pointer;
    font-family: inherit;
  }
  .insight-caret { transition: transform 0.2s ease; font-size: 0.8rem; }
  .insight-toggle[aria-expanded="true"] .insight-caret { transform: rotate(180deg); }
  .insight-collapse { display: none; margin-top: 0.6rem; }
  .insight-collapse.is-open { display: block; }

  .insight-grid { display: flex; flex-direction: column; gap: 0.5rem; }
  .insight-card {
    border: 1px solid var(--rule); border-radius: 10px; padding: 0.55rem 0.7rem;
    background: var(--bg);
  }
  .insight-topic { margin: 0 0 0.3rem; font-size: 0.85rem; color: var(--c-finance); font-weight: 700; }
  .insight-impact, .insight-action { margin: 0.2rem 0 0; font-size: 0.78rem; color: var(--fg-soft); line-height: 1.55; }
  /* 商机洞察来源标记 ①/②/③：标题后内联，移动端点击区域加大（≥26px），便于手机点开溯源 */
  .insight-srcs { display: inline-flex; gap: 0.22rem; margin-left: 0.35rem; vertical-align: middle; }
  .insight-src {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 1.65rem; min-height: 1.65rem; padding: 0 0.22rem;
    font-size: 0.92rem; font-weight: 700; line-height: 1; text-decoration: none;
    color: var(--accent-cmb);
    border: 1px solid color-mix(in srgb, var(--accent-cmb) 40%, transparent);
    border-radius: 7px; background: color-mix(in srgb, var(--accent-cmb) 8%, transparent);
    -webkit-tap-highlight-color: transparent; transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
  }
  .insight-src:active { background: color-mix(in srgb, var(--accent-cmb) 26%, transparent); transform: scale(0.94); }
  .insight-src:hover { background: color-mix(in srgb, var(--accent-cmb) 16%, transparent); border-color: color-mix(in srgb, var(--accent-cmb) 60%, transparent); }
  .tag {
    display: inline-block; font-size: 0.66rem; font-weight: 700; color: var(--accent-cmb);
    background: color-mix(in srgb, var(--accent-cmb) 11%, transparent);
    border-radius: 5px; padding: 0.08rem 0.4rem; margin-right: 0.35rem; vertical-align: 0.08em; letter-spacing: 0.02em;
  }
  .tag-action { color: var(--c-gdipo); background: color-mix(in srgb, var(--c-gdipo) 12%, transparent); }

  /* ===== sticky primary tabs ===== */
  .tabs {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    gap: 0.15rem;
    margin: 0 0 1rem;
    padding: 0.7rem 0 0;
    border-bottom: 1px solid var(--rule);
    flex-wrap: wrap;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: saturate(180%) blur(10px);
    -webkit-backdrop-filter: saturate(180%) blur(10px);
  }
  .tab {
    background: none;
    border: none;
    padding: 0.65rem 1.05rem 0.85rem;
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--muted);
    cursor: pointer;
    border-bottom: 2.5px solid transparent;
    margin-bottom: -1px;
    font-family: inherit;
    transition: color 0.15s;
    border-radius: var(--r-sm) var(--r-sm) 0 0;
  }
  .tab:hover { color: var(--fg); }
  .tab.active {
    color: var(--cat, var(--accent));
    border-bottom-color: var(--cat, var(--accent));
    font-weight: 600;
  }
  .tab .count {
    font-size: 0.72rem;
    color: var(--muted);
    margin-left: 0.4rem;
    font-weight: 400;
  }
  /* 科创动态（T3 降权）：tab 弱化折叠——小号、浅色、末尾竖线分隔 */
  .tab.tab-fold {
    font-size: 0.82rem;
    color: var(--muted);
    opacity: 0.72;
    margin-left: 0.25rem;
    border-left: 1px solid var(--rule);
    padding-left: 1.1rem;
    border-radius: 0;
  }
  .tab.tab-fold.active { opacity: 1; }
  .panel { display: none; }
  .panel.active { display: block; animation: fade 0.25s ease; }
  @keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  /* ===== digest (AI 简报) — compact ===== */
  .digest-category { margin-bottom: 1.2rem; }
  .category-header {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    margin: 0 0 0.6rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
  }
  .category-title {
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--fg);
    margin: 0;
    letter-spacing: 0.05em;
  }
  .category-count {
    font-size: 0.7rem;
    color: var(--muted);
    background: var(--card-alt);
    padding: 0.12rem 0.45rem;
    border-radius: 999px;
  }
  .brief-list {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.6rem;
  }
  @media (min-width: 720px) {
    .brief-list { grid-template-columns: 1fr 1fr; }
  }
  .brief {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: 0.8rem 1rem;
    box-shadow: var(--shadow-sm);
    transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
  }
  .brief:hover {
    border-color: var(--muted);
    transform: translateY(-2px);
    box-shadow: var(--shadow-md);
  }
  .brief-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    margin-bottom: 0.35rem;
  }
  .brief-source {
    font-size: 0.72rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }
  .brief-rank {
    font-size: 0.7rem;
    padding: 0.12rem 0.5rem;
    border-radius: 999px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .brief-rank.high { background: var(--rank-high-bg); color: var(--rank-high-fg); }
  .brief-rank.mid  { background: var(--rank-mid-bg);  color: var(--rank-mid-fg); }
  .brief-rank.low  { background: var(--rank-low-bg);  color: var(--rank-low-fg); }
  .brief-title {
    font-size: 0.98rem;
    font-weight: 600;
    margin: 0 0 0.3rem;
    line-height: 1.4;
  }
  .brief-title a { color: var(--fg); text-decoration: none; }
  .brief-title a:hover { color: var(--link); text-decoration: underline; }
  .brief-summary {
    margin: 0;
    color: var(--fg-soft);
    font-size: 0.86rem;
    line-height: 1.6;
  }

  .editor-card {
    background: var(--card-alt);
    border-left: 3px solid var(--muted);
    border-radius: var(--r-md);
    padding: 1.1rem 1.4rem;
    margin: 1.6rem 0 1.3rem;
    box-shadow: var(--shadow-sm);
  }
  .editor-card .eyebrow { display: block; margin-bottom: 0.45rem; }
  .editor-text {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.75;
    color: var(--fg);
  }
  .keywords { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 0 0 1.6rem; }
  .keyword {
    background: var(--card);
    border: 1px solid var(--rule);
    color: var(--fg-soft);
    padding: 0.28rem 0.75rem;
    border-radius: 999px;
    font-size: 0.8rem;
    transition: border-color 0.15s, color 0.15s;
  }
  .keyword:hover { border-color: var(--muted); color: var(--fg); }

  /* ===== L2 sub-tabs ===== */
  .sub-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin: 1.1rem 0;
  }
  .sub-tab {
    background: var(--card);
    border: 1px solid var(--rule);
    padding: 0.5rem 1.05rem;
    border-radius: var(--r-sm);
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .sub-tab:hover { border-color: var(--muted); color: var(--fg); transform: translateY(-1px); }
  .sub-tab.active {
    background: var(--cat, var(--accent));
    color: #fff;
    border-color: transparent;
    box-shadow: var(--shadow-sm);
  }
  .sub-tab .count {
    font-size: 0.7rem;
    opacity: 0.75;
    margin-left: 0.4rem;
    font-weight: 400;
  }
  .sub-content { display: none; }
  .sub-content.active { display: block; animation: fade 0.2s ease; }
  .biz-tip {
    margin: 0 0 0.7rem;
    padding: 0.5rem 0.7rem;
    border-left: 3px solid var(--accent-cmb);
    border-radius: 6px;
    background: var(--bg-elevated);
    font-size: 0.78rem;
    color: var(--fg-soft);
    line-height: 1.5;
  }

  /* ===== time split (当天 / 过去7天) ===== */
  .time-tabs {
    display: flex;
    gap: 0.4rem;
    margin: 0 0 1rem;
  }
  .time-tab {
    background: var(--card);
    border: 1px solid var(--rule);
    padding: 0.34rem 0.9rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .time-tab:hover { border-color: var(--muted); color: var(--fg); }
  .time-tab.active {
    background: var(--cat, var(--fg));
    color: #fff;
    border-color: transparent;
  }
  .time-tab .count {
    font-size: 0.68rem;
    opacity: 0.8;
    margin-left: 0.35rem;
  }
  .time-content { display: none; }
  .time-content.active { display: block; }

  /* L3 source-tabs 已移除（2026-08-21：渲染只到子标签，子标签内为单一合并流） */

  /* ===== article cards in raw panels ===== */
  .article {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: 1rem 1.15rem;
    margin-bottom: 0.7rem;
    box-shadow: var(--shadow-sm);
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
  }
  .article:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-md);
    border-color: var(--muted);
  }
  .article:first-child { padding-top: 1rem; }
  .article:last-child { border-bottom: 1px solid var(--rule); }
  .article-title {
    font-size: 1.02rem;
    margin: 0 0 0.35rem;
    font-weight: 600;
    line-height: 1.45;
  }
  .article-title a { color: var(--fg); text-decoration: none; }
  .article-title a:hover { color: var(--link); text-decoration: underline; }
  .article-meta { color: var(--muted); font-size: 0.76rem; margin: 0 0 0.4rem; }
  .article-stats {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0 0 0.45rem;
    font-feature-settings: "tnum";
  }
  .article-excerpt {
    margin: 0;
    color: var(--fg-soft);
    font-size: 0.9rem;
    line-height: 1.62;
  }
  .article-summary {
    margin: 0.6rem 0 0;
    padding: 0.65rem 0.9rem;
    background: var(--card-alt);
    border-left: 3px solid var(--cat, var(--link));
    border-radius: 0 var(--r-sm) var(--r-sm) 0;
    font-size: 0.9rem;
    line-height: 1.62;
    color: var(--fg);
  }
  .summary-label {
    display: inline-block;
    font-size: 0.68rem;
    color: var(--link);
    margin-right: 0.4rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .empty {
    color: var(--muted);
    text-align: center;
    padding: 2.2rem 0;
    font-size: 0.9rem;
    background: var(--card);
    border: 1px dashed var(--rule);
    border-radius: var(--r-md);
  }

  /* ===== 合并流：官方 / 媒体 子标签 tab（任务三 #43 改版，长条带 → tab 页）===== */
  .band-tabs {
    display: flex; flex-wrap: wrap; gap: 0.4rem;
    margin: 0.2rem 0 0.55rem; padding-bottom: 0.3rem;
    border-bottom: 1px solid var(--rule);
  }
  .band-tab {
    display: inline-flex; align-items: center; gap: 0.35rem;
    border: 1px solid var(--rule); background: var(--bg);
    color: var(--fg-soft); font-size: 0.78rem; font-weight: 600;
    border-radius: 999px; padding: 0.28rem 0.75rem; cursor: pointer;
    font-family: inherit; transition: all 0.15s ease;
  }
  .band-tab:hover { border-color: var(--muted); color: var(--fg); transform: translateY(-1px); }
  .band-tab.active { background: var(--accent-cmb); border-color: var(--accent-cmb); color: #fff; }
  .band-tab .count { font-size: 0.7rem; opacity: 0.85; }
  .band-panel { display: none; }
  .band-panel.active { display: block; }

  /* ===== trading panel ===== */
  .crypto-widgets {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.6rem;
    margin: 0.4rem 0 1.3rem;
  }
  @media (min-width: 720px) {
    .crypto-widgets { grid-template-columns: repeat(4, 1fr); }
  }
  .crypto-widget {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: 0.8rem 0.9rem;
    text-align: center;
    box-shadow: var(--shadow-sm);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .crypto-widget:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
  .widget-label {
    font-size: 0.7rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 0.3rem;
  }
  .widget-value {
    font-size: 1.5rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--fg);
    line-height: 1.1;
  }
  .widget-sub {
    font-size: 0.78rem;
    color: var(--muted);
    margin-top: 0.25rem;
  }
  .widget-sub.positive { color: #16a34a; }
  .widget-sub.negative { color: #dc2626; }
  @media (prefers-color-scheme: dark) {
    .widget-sub.positive { color: #4ade80; }
    .widget-sub.negative { color: #fca5a5; }
  }
  .crypto-widget.fg-fear-extreme { border-left: 4px solid #b91c1c; }
  .crypto-widget.fg-fear-extreme .widget-value { color: #b91c1c; }
  .crypto-widget.fg-fear { border-left: 4px solid #d97706; }
  .crypto-widget.fg-fear .widget-value { color: #d97706; }
  .crypto-widget.fg-neutral { border-left: 4px solid var(--muted); }
  .crypto-widget.fg-greed { border-left: 4px solid #65a30d; }
  .crypto-widget.fg-greed .widget-value { color: #65a30d; }
  .crypto-widget.fg-greed-extreme { border-left: 4px solid #16a34a; }
  .crypto-widget.fg-greed-extreme .widget-value { color: #16a34a; }
  @media (prefers-color-scheme: dark) {
    .crypto-widget.fg-fear-extreme .widget-value,
    .crypto-widget.fg-fear .widget-value { color: #fca5a5; }
    .crypto-widget.fg-greed .widget-value,
    .crypto-widget.fg-greed-extreme .widget-value { color: #4ade80; }
  }

  .trading-overview-card {
    margin: 0 0 1.6rem;
    padding: 1.1rem 1.4rem;
    background: var(--card);
    border-radius: var(--r-md);
    border-left: 4px solid var(--c-trading);
    box-shadow: var(--shadow-sm);
  }
  .trading-overview-card .eyebrow { display: block; margin-bottom: 0.45rem; }
  .trading-overview-text { font-size: 0.92rem; line-height: 1.75; color: var(--fg-soft); margin: 0; }

  .trading-section-title {
    font-size: 0.98rem;
    font-weight: 600;
    margin: 1.6rem 0 0.9rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
    color: var(--fg);
    letter-spacing: 0.05em;
  }

  .trading-picks {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.65rem;
  }
  @media (min-width: 720px) {
    .trading-picks { grid-template-columns: 1fr 1fr; }
  }
  .trading-pick {
    background: var(--card);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--muted);
    border-radius: var(--r-md);
    padding: 0.85rem 1.1rem;
    box-shadow: var(--shadow-sm);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .trading-pick:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
  .trading-pick.stance-bull { border-left-color: #16a34a; }
  .trading-pick.stance-bear { border-left-color: #dc2626; }
  .trading-pick.stance-neutral { border-left-color: var(--muted); }
  .pick-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    margin-bottom: 0.5rem;
  }
  .pick-symbol-block {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .pick-symbol { font-weight: 700; font-size: 1rem; color: var(--fg); }
  .pick-name { color: var(--muted); font-size: 0.82rem; }
  .pick-stance {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.2rem 0.65rem;
    border-radius: 999px;
    white-space: nowrap;
  }
  .pick-stance-bull { background: rgba(22,163,74,0.12); color: #16a34a; }
  .pick-stance-bear { background: rgba(220,38,38,0.12); color: #dc2626; }
  .pick-stance-neutral { background: var(--card-alt); color: var(--muted); }
  .pick-rationale { margin: 0; font-size: 0.88rem; line-height: 1.65; color: var(--fg-soft); }

  .trading-group-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin: 0.7rem 0 1.3rem;
  }
  .trading-group-tab {
    background: var(--card);
    border: 1px solid var(--rule);
    padding: 0.5rem 1rem;
    border-radius: var(--r-sm);
    font-size: 0.88rem;
    font-weight: 500;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .trading-group-tab:hover { border-color: var(--muted); color: var(--fg); transform: translateY(-1px); }
  .trading-group-tab.active {
    background: var(--c-trading);
    color: #fff;
    border-color: transparent;
    box-shadow: var(--shadow-sm);
  }
  .trading-group-tab .count {
    font-size: 0.7rem;
    opacity: 0.8;
    margin-left: 0.4rem;
    font-weight: 400;
  }
  .trading-group-content { display: none; }
  .trading-group-content.active { display: block; animation: fade 0.2s ease; }

  .ticker-card {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: 0.9rem 1.15rem;
    margin-bottom: 0.7rem;
    box-shadow: var(--shadow-sm);
    transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
  }
  .ticker-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: var(--muted); }
  .ticker-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.7rem;
  }
  .ticker-id { min-width: 0; }
  .ticker-symbol { margin: 0; font-size: 1.02rem; font-weight: 700; font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; }
  .ticker-name { margin: 0.15rem 0 0; font-size: 0.82rem; color: var(--muted); }
  .ticker-price-block { text-align: right; flex-shrink: 0; }
  .ticker-price { display: block; font-size: 1.08rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .ticker-pct { display: inline-block; font-size: 0.84rem; font-weight: 500; margin-top: 0.15rem; font-variant-numeric: tabular-nums; }
  .ticker-pct.positive, .positive { color: #16a34a; }
  .ticker-pct.negative, .negative { color: #dc2626; }

  .ticker-indicators {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.4rem 0.9rem;
    margin: 0;
    font-size: 0.82rem;
    color: var(--fg-soft);
  }
  @media (min-width: 720px) {
    .ticker-indicators { grid-template-columns: repeat(3, 1fr); }
  }
  .ticker-indicators > div { display: flex; gap: 0.4rem; align-items: baseline; min-width: 0; }
  .ticker-indicators dt { color: var(--muted); font-size: 0.74rem; margin: 0; white-space: nowrap; }
  .ticker-indicators dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 500; color: var(--fg); }
  .trend-bullish { color: #16a34a; }
  .trend-bearish { color: #dc2626; }
  .trend-neutral { color: var(--muted); }
  .rsi-overbought { color: #d97706; }
  .rsi-oversold { color: #2563eb; }

  .ticker-signals {
    margin-top: 0.7rem;
    padding-top: 0.6rem;
    border-top: 1px dashed var(--rule);
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .signal-pill {
    font-size: 0.72rem;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    font-weight: 500;
  }
  .signal-pill.tone-bull { background: rgba(22,163,74,0.13); color: #166534; }
  .signal-pill.tone-bear { background: rgba(220,38,38,0.13); color: #991b1b; }
  .signal-pill.tone-caution { background: rgba(217,119,6,0.15); color: #92400e; }
  @media (prefers-color-scheme: dark) {
    .signal-pill.tone-bull { color: #4ade80; }
    .signal-pill.tone-bear { color: #fca5a5; }
    .signal-pill.tone-caution { color: #fcd34d; }
    .trend-bullish, .positive, .ticker-pct.positive { color: #4ade80; }
    .trend-bearish, .negative, .ticker-pct.negative { color: #fca5a5; }
    .rsi-overbought { color: #fcd34d; }
    .rsi-oversold { color: #93c5fd; }
    .trading-pick.stance-bull { border-left-color: #4ade80; }
    .trading-pick.stance-bear { border-left-color: #fca5a5; }
    .pick-stance-bull { background: rgba(74,222,128,0.15); color: #4ade80; }
    .pick-stance-bear { background: rgba(252,165,165,0.15); color: #fca5a5; }
  }
  .signal-age { opacity: 0.7; font-weight: 400; }

  .trading-risk {
    margin: 1.6rem 0 0;
    padding: 0.95rem 1.3rem;
    background: var(--card);
    border-radius: var(--r-md);
    border-left: 4px solid #d97706;
    box-shadow: var(--shadow-sm);
  }
  .trading-risk .eyebrow { display: block; margin-bottom: 0.4rem; }
  .trading-risk p { margin: 0; font-size: 0.82rem; line-height: 1.65; color: var(--fg-soft); }

  footer {
    margin-top: 2.75rem;
    border-top: 1px solid var(--rule);
    padding-top: 1.2rem;
    color: var(--muted);
    font-size: 0.82rem;
  }

  /* ===== 2026-08-21 交互重构（demo 对齐）：报头 / 单层 tab / 卡片徽章 / 商机默认展开 / 字号体系 ===== */
  html { font-size: 17px; }
  body { line-height: 1.65; }
  main { max-width: 980px; margin: 0 auto; padding: 2rem 1.25rem 3.5rem; }

  .masthead { border-bottom: 1px solid var(--rule); padding-bottom: 1.1rem; }
  .masthead .eyebrow { font-size: 0.72rem; letter-spacing: 0.2em; color: var(--muted); text-transform: uppercase; font-weight: 600; }
  .masthead h1 { font-family: Georgia, "Songti SC", "Noto Serif CJK SC", serif; font-size: 2rem; margin: 0.35rem 0 0.1rem; letter-spacing: -0.01em; }
  .hero-line { margin: 0.7rem 0 0; font-size: 1.02rem; line-height: 1.7; border-left: 3px solid var(--cmb, #e60012); padding-left: 0.8rem; }
  .meta-line { margin: 0.6rem 0 0; font-size: 0.82rem; color: var(--muted); }
  .meta-line .archive { color: var(--muted); }

  /* 今日必读字号加大（#7） */
  .must-card strong { font-size: 0.92rem; }
  .must-card .must-why { font-size: 0.85rem; }

  /* 商机洞察默认展开 + tag 中文（#5/#6）：桌面端双列网格压缩高度，
     避免 5 条洞察单列纵向堆叠把执行摘要区撑高（与必读不足 5 条时一起失衡）。 */
  .exec-insights .insight-collapse { display: block; }
  .insight-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0.55rem; }
  .insight-card, .insight { background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 0.7rem 0.85rem; }
  .insight h3 { margin: 0.3rem 0 0.35rem; font-size: 0.98rem; line-height: 1.45; }
  .insight p { margin: 0.25rem 0 0; font-size: 0.9rem; color: var(--fg-soft); line-height: 1.6; }
  .insight p b { color: var(--fg); }
  .insight-tags { margin-bottom: 0.1rem; }
  .tag { display: inline-block; font-size: 0.7rem; font-weight: 700; border-radius: 4px; padding: 0.08rem 0.42rem; margin-right: 0.35rem; color: var(--cmb, #e60012); background: rgba(230, 0, 18, 0.1); }
  .tag.t-wealth { color: #7c3aed; background: rgba(124, 58, 237, 0.12); }
  .tag.t-mass { color: #059669; background: rgba(5, 150, 105, 0.12); }
  .tag.t-policy { color: #b45309; background: rgba(180, 83, 9, 0.12); }
  /* 粤标签（2026-08-23）：广东企业/事件地域标记，招行红描边胶囊，区别于业务线彩底 */
  .tag.t-gd { color: var(--accent-cmb, #e60012); background: color-mix(in srgb, var(--accent-cmb, #e60012) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent-cmb, #e60012) 45%, transparent); font-weight: 800; }

  /* 单层 tab：横滑不折行（#11） */
  .tabs { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 0.1rem; margin: 1.4rem 0 0; padding: 0.6rem 0 0; border-bottom: 1px solid var(--rule); background: color-mix(in srgb, var(--bg) 90%, transparent); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
  .tabs .tab { flex: none; background: none; border: none; font-family: inherit; cursor: pointer; padding: 0.6rem 0.9rem 0.75rem; font-size: 0.95rem; font-weight: 500; color: var(--muted); border-bottom: 2.5px solid transparent; margin-bottom: -1px; white-space: nowrap; }
  .tabs .tab .n { font-size: 0.72rem; color: var(--muted); margin-left: 0.2rem; }
  .tabs .tab.active { color: var(--cat, var(--fg)); border-bottom-color: var(--cat, var(--fg)); font-weight: 600; }
  .panel { display: none; padding-top: 1rem; }
  .panel.active { display: block; }

  /* 卡片：来源徽章 + 摘要平铺（#12/#15） */
  .brief { background: var(--card); border: 1px solid var(--rule); border-radius: 12px; padding: 0.8rem 0.95rem; margin-bottom: 0.55rem; box-shadow: var(--shadow); }
  .brief .bm { display: flex; align-items: center; gap: 0.45rem; font-size: 0.78rem; color: var(--muted); margin-bottom: 0.25rem; flex-wrap: wrap; }
  .src-badge { font-size: 0.66rem; font-weight: 700; border-radius: 4px; padding: 0.06rem 0.35rem; }
  .src-official { color: #b45309; background: rgba(217, 119, 6, 0.14); }
  .src-media { color: #4f46e5; background: rgba(79, 70, 229, 0.12); }
  .brief h3 { margin: 0; font-size: 0.98rem; line-height: 1.5; }
  .brief .sum { margin: 0.35rem 0 0; font-size: 0.92rem; color: var(--fg-soft); line-height: 1.65; }
  .brief .sum b { color: var(--fg); }
  .brief.more { display: none; }
  .panel.expanded .brief.more { display: block; }
  .expand-btn { width: 100%; margin: 0.2rem 0 0.4rem; padding: 0.6rem; border: 1px dashed var(--rule); border-radius: 10px; background: var(--bg-elevated, var(--card)); color: var(--muted); font-size: 0.88rem; font-family: inherit; cursor: pointer; }
  .expand-btn:hover { color: var(--fg); border-style: solid; }
  /* 板块内标签筛选条（2026-08-22 用户） */
  .filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin: 0.4rem 0 0.9rem; padding: 0.5rem 0.65rem; background: var(--bg-elevated, var(--card)); border: 1px solid var(--rule); border-radius: 12px; }
  .filter-label { font-size: 0.82rem; color: var(--fg-soft, var(--muted)); margin-right: 0.15rem; }
  .filter-group { display: inline-flex; align-items: center; gap: 0.4rem; }
  .filter-group + .filter-group { padding-left: 0.7rem; margin-left: 0.35rem; border-left: 1px solid var(--rule); }
  .filter-gtitle { font-size: 0.8rem; color: var(--fg-soft, var(--muted)); }
  .filter-chip { border: 1px solid var(--rule); background: var(--bg, var(--card)); color: var(--fg-soft, var(--muted)); border-radius: 999px; padding: 0.28rem 0.8rem; font-size: 0.84rem; cursor: pointer; user-select: none; transition: all 0.15s; font-family: inherit; }
  .filter-chip:hover { border-color: var(--accent-cmb); color: var(--accent-cmb); }
  .filter-chip.active { background: var(--accent-cmb); border-color: var(--accent-cmb); color: #fff; font-weight: 600; box-shadow: 0 2px 8px color-mix(in srgb, var(--accent-cmb) 38%, transparent); }
  .filter-reset { margin-left: auto; border: 1px solid var(--rule); background: transparent; color: var(--fg-soft, var(--muted)); border-radius: 999px; padding: 0.28rem 0.8rem; font-size: 0.84rem; cursor: pointer; font-family: inherit; }
  .filter-reset:hover { border-color: var(--accent-cmb); color: var(--accent-cmb); }
  .brief.filtered-out { display: none !important; }

  /* 市场总览 bullet（#17/#18/#19） */
  .market-card .bm { margin-bottom: 0.35rem; }
  .market-bullets { margin: 0.35rem 0 0; padding-left: 1.1rem; font-size: 0.92rem; color: var(--fg-soft); line-height: 1.7; }
  .market-bullets b { color: var(--fg); }

  footer p { margin: 0.25rem 0; line-height: 1.7; }
`;
