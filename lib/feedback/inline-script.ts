/**
 * 反馈回路内联脚本生成器（P0-D）。
 *
 * 输出一个可嵌入 HTML 的纯 JS 字符串：
 * - 监听 .fb-btn click → 写 localStorage
 * - 监听 .fb-audio-btn click → 写 localStorage（audio 整体反馈）
 * - 监听 #fb-export click → 触发 JSON 下载
 * - 页面加载时恢复历史投票的视觉态
 * - 实时更新 #fb-stats 文本
 *
 * 设计：纯 vanilla JS（无 jQuery / React），gzip 后约 1.2KB。
 * 嵌入位置：renderHtml 输出末尾，</body> 之前。
 */

import { STORAGE_KEY, SECTION_KEYS } from "./storage";

export function generateInlineFeedbackScript(reportDate: string): string {
  // SECTION_KEYS 注入（白名单校验）
  const sectionsJson = JSON.stringify(SECTION_KEYS);

  return `
(function(){
  var STORAGE_KEY = ${JSON.stringify(STORAGE_KEY)};
  var REPORT_DATE = ${JSON.stringify(reportDate)};
  var SECTIONS = ${sectionsJson};

  function listAll(){
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch(e) { return []; }
  }
  function saveAll(arr){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); } catch(e) {}
  }
  function recordVote(url, section, vote){
    if (SECTIONS.indexOf(section) < 0) return listAll();
    var all = listAll();
    var key = REPORT_DATE + "|" + url + "|" + section;
    var idx = -1;
    for (var i = 0; i < all.length; i++) {
      if ((all[i].date + "|" + all[i].url + "|" + all[i].section) === key) { idx = i; break; }
    }
    var entry = { date: REPORT_DATE, url: url, section: section, vote: vote, ts: Date.now() };
    if (idx >= 0) all[idx] = entry; else all.push(entry);
    saveAll(all);
    return all;
  }
  function todayCount(){
    var all = listAll();
    var up = 0, down = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i].date !== REPORT_DATE) continue;
      if (all[i].vote === "up") up++; else if (all[i].vote === "down") down++;
    }
    return { up: up, down: down, total: up + down };
  }
  function renderStats(){
    var el = document.getElementById("fb-stats");
    if (!el) return;
    var c = todayCount();
    el.textContent = "本次反馈（" + REPORT_DATE + "）：" + c.up + " 👍 / " + c.down + " 👎";
  }
  function restoreVisual(){
    var all = listAll();
    for (var i = 0; i < all.length; i++) {
      if (all[i].date !== REPORT_DATE) continue;
      var sel = '[data-url="' + cssEscape(all[i].url) + '"][data-vote="' + all[i].vote + '"]';
      var btn = document.querySelector(sel);
      if (btn) btn.classList.add("fb-active");
    }
  }
  function cssEscape(s){
    return String(s).replace(/[\\\\"']/g, "\\\\$&");
  }
  function bindCardButtons(){
    var btns = document.querySelectorAll(".fb-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function(e){
        e.preventDefault();
        e.stopPropagation();
        var url = this.getAttribute("data-url");
        var section = this.getAttribute("data-section");
        var vote = this.getAttribute("data-vote");
        if (!url || !section || !vote) return;
        recordVote(url, section, vote);
        // 视觉态：同卡片内互斥
        var card = this.closest("[data-fb-card]");
        if (card) {
          var siblings = card.querySelectorAll(".fb-btn");
          for (var j = 0; j < siblings.length; j++) siblings[j].classList.remove("fb-active");
        }
        this.classList.add("fb-active");
        renderStats();
      });
    }
  }
  function bindAudioButtons(){
    var btns = document.querySelectorAll(".fb-audio-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function(e){
        e.preventDefault();
        var vote = this.getAttribute("data-vote");
        if (!vote) return;
        recordVote("__audio__", "audio", vote);
        var all = document.querySelectorAll(".fb-audio-btn");
        for (var j = 0; j < all.length; j++) all[j].classList.remove("fb-active");
        this.classList.add("fb-active");
        renderStats();
      });
    }
  }
  function bindExport(){
    var btn = document.getElementById("fb-export");
    if (!btn) return;
    btn.addEventListener("click", function(){
      var blob = new Blob([JSON.stringify(listAll(), null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "gzinfo-feedback-" + REPORT_DATE + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    });
  }
  function init(){
    bindCardButtons();
    bindAudioButtons();
    bindExport();
    restoreVisual();
    renderStats();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
`;
}

/** 嵌入到 HTML 的 CSS（极简，避免污染 render.ts 主题）。 */
export const FEEDBACK_CSS = `
.fb-btn, .fb-audio-btn { background:transparent; border:1px solid #ddd; border-radius:6px; padding:2px 8px; margin:0 2px; cursor:pointer; font-size:12px; color:#888; transition:all 0.15s; }
.fb-btn:hover, .fb-audio-btn:hover { background:#f5f5f5; color:#333; }
.fb-btn.fb-active[data-vote="up"], .fb-audio-btn.fb-active[data-vote="up"] { background:#e6f7e6; border-color:#5cb85c; color:#3d8b3d; }
.fb-btn.fb-active[data-vote="down"], .fb-audio-btn.fb-active[data-vote="down"] { background:#fbeaea; border-color:#d9534f; color:#a94442; }
.fb-row { display:flex; gap:4px; margin-top:8px; padding-top:8px; border-top:1px dashed #eee; }
.fb-footer { margin:32px auto 24px; padding:16px; max-width:960px; background:#fafafa; border-radius:8px; display:flex; align-items:center; gap:16px; font-size:13px; color:#666; }
.fb-footer #fb-stats { flex:1; }
.fb-footer #fb-export { padding:6px 12px; border:1px solid #ccc; border-radius:4px; background:#fff; cursor:pointer; font-size:12px; }
.fb-footer #fb-export:hover { background:#f0f0f0; }
.audio-fb { margin-top:8px; display:flex; gap:6px; align-items:center; font-size:12px; color:#666; }
.audio-fb span { margin-right:4px; }
/* v2 音频联动高亮（I-A 实施）：当前段对应的卡片淡蓝边框 + 浅蓝背景 */
.audio-highlight { box-shadow: 0 0 0 3px rgba(64,158,255,0.45); background: rgba(64,158,255,0.06); border-radius: 8px; transition: box-shadow 0.2s, background 0.2s; }
.must-card.audio-highlight, .insight.audio-highlight, .stock-card.audio-highlight { transform: translateZ(0); }
`.trim();

/**
 * 音频段落 → HTML 卡片联动脚本（P0-A v2）。
 *
 * 监听 <audio> timeupdate 事件，根据当前时间查找匹配 segment，
 * 给所有 data-audio-section="<segmentId>" 的卡片加 .audio-highlight class。
 *
 * 调用方需在 HTML 中放置：
 *   - <audio id="audio-player">
 *   - <script type="application/json" id="audio-segments">[{...segments}]</script>
 */
export function generateAudioHighlightScript(): string {
  return `
(function(){
  var audio = document.getElementById("audio-player");
  var dataEl = document.getElementById("audio-segments");
  if (!audio || !dataEl) return;
  var segments;
  try { segments = JSON.parse(dataEl.textContent || "[]"); } catch(e) { return; }
  if (!Array.isArray(segments) || segments.length === 0) return;

  var lastId = null;
  function currentSegment(t) {
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (t >= s.startSec && t < s.startSec + s.durationSec) return s;
    }
    return null;
  }
  function clearAll() {
    var els = document.querySelectorAll(".audio-highlight");
    for (var i = 0; i < els.length; i++) els[i].classList.remove("audio-highlight");
  }
  function applyHighlight(seg) {
    if (!seg) { lastId = null; return; }
    if (seg.id === lastId) return;
    clearAll();
    var cards = document.querySelectorAll('[data-audio-section="' + seg.id + '"]');
    for (var i = 0; i < cards.length; i++) cards[i].classList.add("audio-highlight");
    lastId = seg.id;
  }
  audio.addEventListener("timeupdate", function() {
    var seg = currentSegment(audio.currentTime || 0);
    applyHighlight(seg);
  });
  audio.addEventListener("ended", function() { clearAll(); lastId = null; });
  audio.addEventListener("seeked", function() {
    var seg = currentSegment(audio.currentTime || 0);
    applyHighlight(seg);
  });
})();
`;
}

/** 卡片底部 fb-row HTML（接受 url + section） */
export function renderCardFeedbackBar(url: string, section: string): string {
  const safeUrl = url.replace(/"/g, "&quot;");
  return `<div class="fb-row">
  <button class="fb-btn" type="button" data-url="${safeUrl}" data-section="${section}" data-vote="up" title="有用">👍</button>
  <button class="fb-btn" type="button" data-url="${safeUrl}" data-section="${section}" data-vote="down" title="没用">👎</button>
</div>`;
}

/** 音频播放器下方反馈条 */
export function renderAudioFeedbackBar(): string {
  return `<div class="audio-fb">
  <span>本次听完：</span>
  <button class="fb-audio-btn" type="button" data-vote="up" title="有用">👍</button>
  <button class="fb-audio-btn" type="button" data-vote="down" title="没用">👎</button>
</div>`;
}

/** 页脚 widget（统计 + 导出） */
export function renderFeedbackFooter(): string {
  return `<footer class="fb-footer">
  <span id="fb-stats">本次反馈：— 👍 / — 👎</span>
  <button id="fb-export" type="button" title="下载 localStorage 中的反馈 JSON，发给开发团队聚合">📤 导出反馈 (JSON)</button>
</footer>`;
}
