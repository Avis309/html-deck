// Edit-mode motion policy, run in the edit frame before any document script (serialized after
// the frame guard). Moving content cannot be edited reliably, so every animation is shown in its
// end state: finite CSS animations, transitions and Web Animations are paused at their end
// (fill forwards keeps content that fades in visible), infinite ones at 0. Nothing in the DOM is
// written — only animation timing — so it never shows up as a runtime change or in a save.
// Script-driven motion (requestAnimationFrame, timers) is not touched here: provenance locks
// whatever it rewrites. Cooperative documents read window.__HTMLDECK__.mode === 'edit'.
export function editFreeze(win) {
  win.__HTMLDECK__ = { mode: 'edit', version: 1 };
  // Paused at its end, not finished: `finished` then never resolves, so a script awaiting it
  // in a loop waits instead of spinning through microtasks (finish() would hang the editor).
  function freeze(a) {
    if (a.__edPreview || a.playState === 'paused' || a.playState === 'finished' || a.playState === 'idle') return;
    try {
      var end = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : Infinity;
      a.pause();
      a.currentTime = isFinite(end) ? end : 0;
    } catch (e) { /* removed meanwhile */ }
  }
  // The editor's own previews set __edNoFreeze around their animate() calls.
  var animate = win.Element.prototype.animate;
  if (animate) {
    win.Element.prototype.animate = function () {
      var a = animate.apply(this, arguments);
      if (win.__edNoFreeze) a.__edPreview = true; else freeze(a);
      return a;
    };
  }
  // Animations started later by any route (play() again, new Animation(), a class with a long
  // delay added after load) are caught by a sweep; the events only make CSS ones immediate.
  function sweep() { if (win.document.getAnimations) win.document.getAnimations().forEach(freeze); }
  function onEvent(e) { var t = e.target; if (t && t.getAnimations) t.getAnimations().forEach(freeze); }
  ['animationstart', 'transitionrun'].forEach(function (type) { win.addEventListener(type, onEvent, true); });
  win.document.addEventListener('DOMContentLoaded', sweep);
  win.addEventListener('load', sweep);
  win.setInterval(sweep, 200);
}
