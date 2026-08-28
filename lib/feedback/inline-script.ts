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

/** 嵌入到 HTML 的 CSS（音频联动高亮，极简，避免污染 render.ts 主题）。 */
export const AUDIO_HIGHLIGHT_CSS = `
/* v2 音频联动高亮（I-A 实施）：当前段对应的卡片淡蓝边框 + 浅蓝背景 */
.audio-highlight { box-shadow: 0 0 0 3px rgba(64,158,255,0.45); background: rgba(64,158,255,0.06); border-radius: 8px; transition: box-shadow 0.2s, background 0.2s; }
.must-card.audio-highlight, .insight.audio-highlight, .stock-card.audio-highlight { transform: translateZ(0); }
`.trim();

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
