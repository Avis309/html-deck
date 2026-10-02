// The document the present iframe loads: a clone of the model (never the model itself, never
// the edit iframe's DOM). Everything the deck must see from its first script on — classes,
// slide markers, the start slide, the present CSS — is set on the clone before the author's
// scripts; the trusted runtime goes last in <body> and only wires navigation and messages.
import { neuterScripts } from '../core/sanitize.mjs';
import { fxRuntime } from '../fx/runtime.mjs';

function presentCSS(mode, w, h) {
  if (mode !== 'deck') return '';
  return `
html.ed-deck, html.ed-deck body { overflow: hidden !important; width: ${w}px !important; height: ${h}px !important; margin: 0 !important; padding: 0 !important; }
html.ed-deck [data-ed-slide] { position: fixed !important; left: 0 !important; top: 0 !important; right: auto !important; bottom: auto !important;
  width: ${w}px !important; height: ${h}px !important; min-height: 0 !important; max-height: none !important; margin: 0 !important;
  transform: none !important; translate: none !important; scale: none !important; z-index: 2147483000 !important;
  box-shadow: none !important; border-radius: 0 !important; visibility: visible !important; opacity: 1 !important; }
html.ed-deck [data-ed-slide]:not([data-ed-cur]) { display: none !important; }
html.ed-deck [data-ed-slide-anc] { transform: none !important; translate: none !important; scale: none !important; rotate: none !important;
  will-change: auto !important; filter: none !important; backdrop-filter: none !important; perspective: none !important; contain: none !important; }`;
}

// Runs inside the present iframe (serialized with toString): self-contained, no module scope.
// The legacy provider owns slide navigation; keys still reach the deck's own handlers.
function presentRuntime(cfg) {
  var P = window.parent;
  if (!P || P === window) return;
  var deck = cfg.mode === 'deck', cur = cfg.start, slides = [];
  var TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
  var ACTIVATES = 'a, button, summary, [role=button]';
  var INTERACTIVE = 'a, button, input, select, textarea, label, summary, video, audio, [contenteditable], [role=button], [tabindex]';
  var NEXT = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'], PREV = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'];
  function send(type, extra) {
    var m = { ns: cfg.ns, v: cfg.v, type: type, sessionId: cfg.sessionId, docRevision: cfg.docRevision };
    for (var k in extra) m[k] = extra[k];
    P.postMessage(m, cfg.origin);
  }
  function show(i, requestId) {
    if (!deck) return;
    i = Math.max(0, Math.min(slides.length - 1, i));
    if (i !== cur) { slides[cur].removeAttribute('data-ed-cur'); slides[i].setAttribute('data-ed-cur', ''); cur = i; }
    if (window.__htmldeckFx) window.__htmldeckFx.show(slides[cur]);
    send('state', { index: cur, requestId: requestId });
  }
  if (deck) {
    for (var i = 0; i < cfg.slideIds.length; i++) {
      var s = document.querySelector('[data-ed-slide][data-ed-id="' + cfg.slideIds[i] + '"]');
      if (!s) { send('error', { reason: 'slide-missing' }); return; }
      slides.push(s);
    }
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { send('exit'); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); send('save'); return; }
    if (!deck || e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target && e.target.closest ? e.target : null;
    if (t && t.closest(TYPING)) return;
    if ((e.key === ' ' || e.key === 'Enter') && t && t.closest(ACTIVATES)) return;
    if (NEXT.indexOf(e.key) >= 0) { e.preventDefault(); show(cur + 1); }
    else if (PREV.indexOf(e.key) >= 0) { e.preventDefault(); show(cur - 1); }
    else if (e.key === 'Home') { e.preventDefault(); show(0); }
    else if (e.key === 'End') { e.preventDefault(); show(slides.length - 1); }
  }, true);
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
    // A link would navigate the present frame away from its runtime: open it beside instead.
    var a = t && t.closest('a[href]');
    if (a && !e.defaultPrevented && a.getAttribute('href').charAt(0) !== '#') { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); return; }
    if (!deck || e.button !== 0 || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (t && t.closest(INTERACTIVE)) return;
    show(cur + 1);
  });
  window.addEventListener('message', function (e) {
    if (e.source !== P || e.origin !== cfg.origin) return;
    var m = e.data;
    if (!m || m.ns !== cfg.ns || m.v !== cfg.v || m.sessionId !== cfg.sessionId) return;
    if (m.type === 'navigate' && typeof m.index === 'number') show(m.index, m.requestId);
  });
  if (deck && window.__htmldeckFx) window.__htmldeckFx.show(slides[cur]);
  send('ready', { count: slides.length, index: deck ? cur : 0 });
}

// Reveal provider: the author's Reveal runtime owns keys, fragments and navigation. This only
// maps editor leaves (by data-ed-id) to Reveal's runtime indices once Reveal is ready — hidden
// slides are gone from the runtime and plugin-made slides have no editor leaf — and reports
// the current leaf back. Self-contained (serialized with toString).
function revealRuntime(cfg) {
  var P = window.parent;
  if (!P || P === window) return;
  var ids = cfg.slideIds, cur = cfg.start, R = null, done = false;
  function send(type, extra) {
    var m = { ns: cfg.ns, v: cfg.v, type: type, sessionId: cfg.sessionId, docRevision: cfg.docRevision };
    for (var k in extra) m[k] = extra[k];
    P.postMessage(m, cfg.origin);
  }
  function leafOf(slide) {
    for (var n = slide; n && n.getAttribute; n = n.parentElement) {
      var k = ids.indexOf(n.getAttribute('data-ed-id'));
      if (k >= 0) return k;
    }
    return -1;
  }
  function indicesOf(i) {
    var el = document.querySelector('[data-ed-id="' + ids[i] + '"]');
    if (!el || !el.isConnected) return null;
    var cfgR = R.getConfig ? R.getConfig() : {};
    if (!cfgR.showHiddenSlides && el.closest('[data-visibility="hidden"]')) return null;
    try { var x = R.getIndices(el); return x && typeof x.h === 'number' ? x : null; } catch (e) { return null; }
  }
  // The leaf asked for, else the next one Reveal has, else the previous one.
  function go(i) {
    var order = [], k;
    for (k = i; k < ids.length; k++) order.push(k);
    for (k = i - 1; k >= 0; k--) order.push(k);
    for (var j = 0; j < order.length; j++) {
      var x = indicesOf(order[j]);
      if (x) { R.slide(x.h, x.v || 0); return true; }
    }
    return false;
  }
  function current() { var k = leafOf(R.getCurrentSlide()); if (k >= 0) cur = k; return cur; }
  function start() {
    if (done) return;
    done = true;
    var fx = function () { var F = window.__htmldeckFx; if (!F) return; if (R.isOverview && R.isOverview()) F.settle(); else F.show(R.getCurrentSlide()); };
    R.on('slidechanged', function () { fx(); send('state', { index: current() }); });
    R.on('overviewshown', fx); R.on('overviewhidden', fx);
    if (!go(cfg.start)) { send('error', { reason: 'no-slide' }); return; }
    // A plugin (markdown) can split one authored section into several pages sharing its id:
    // those pages all map to that one leaf, which the editor tells the user.
    var split = 0;
    for (var i = 0; i < ids.length; i++) if (document.querySelectorAll('[data-ed-id="' + ids[i] + '"]').length > 1) split++;
    fx();
    send('ready', { count: ids.length, index: current(), split: split });
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { send('exit'); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); send('save'); }
  }, true);
  window.addEventListener('message', function (e) {
    if (e.source !== P || e.origin !== cfg.origin || !R || !done) return;
    var m = e.data;
    if (!m || m.ns !== cfg.ns || m.v !== cfg.v || m.sessionId !== cfg.sessionId) return;
    if (m.type === 'navigate' && typeof m.index === 'number') { go(m.index); send('state', { index: current(), requestId: m.requestId }); }
  });
  var t0 = Date.now(), bound = false;
  (function wait() {
    R = window.Reveal || null;
    if (R && typeof R.isReady === 'function' && R.isReady()) return start();
    if (R && typeof R.on === 'function' && !bound) { bound = true; try { R.on('ready', start); } catch (e) { bound = false; } }
    // An ES-module Reveal is not on window: present it as is, without slide sync.
    if (!R && document.querySelector('.reveal.ready') && !done) { done = true; send('ready', { count: ids.length, index: cfg.start }); return; }
    if (Date.now() - t0 > 7000) { send('error', { reason: 'reveal-not-ready' }); return; }
    if (!done) setTimeout(wait, 50);
  })();
}

// opts: { untrusted, mode: 'deck'|'page', provider: 'legacy'|'reveal'|'page', slideIds, displays, start,
//         deckW, deckH, extraCSS, bodyClass, session: {ns, v, sessionId, docRevision, origin} }
// displays[i]: the display slide i renders with when shown (an authored display:none would
// otherwise leave the current slide blank).
export function renderPresentHTML(model, doctype, opts) {
  const { untrusted, mode, provider = mode === 'deck' ? 'legacy' : 'page', slideIds = [], displays = [], start = 0, deckW, deckH, extraCSS = '', bodyClass = '', session } = opts;
  const legacy = provider === 'legacy';
  const root = model.documentElement.cloneNode(true);
  // Author scripts go first, so the trusted runtime added below is never removed with them.
  if (untrusted) neuterScripts(root);
  root.classList.add('ed-presenting', mode === 'deck' ? 'ed-deck' : 'ed-page');
  if (legacy) {
    slideIds.forEach((id, i) => {
      const s = root.querySelector(`[data-ed-id="${id}"]`);
      if (!s) throw new Error(`slide ${id} không có trong model`);
      s.setAttribute('data-ed-slide', '');
      if (i === start) s.setAttribute('data-ed-cur', '');
      for (let n = s.parentElement; n && n !== root; n = n.parentElement) n.setAttribute('data-ed-slide-anc', '');
    });
  }
  const css = (legacy ? presentCSS('deck', deckW, deckH) : '') + extraCSS + (legacy ? slideIds.map((id, i) =>
    `\nhtml.ed-deck [data-ed-slide][data-ed-cur][data-ed-id="${id}"] { display: ${/^[a-z-]+$/.test(displays[i] || '') ? displays[i] : 'block'} !important; }`).join('') : '');
  if (css) {
    const style = model.createElement('style');
    style.textContent = css;
    root.querySelector('head').appendChild(style);
  }
  // Effects and scenes: exactly one trusted runtime, current version, driven by the present
  // runtime (a page scrolls, so there it triggers itself). The file's own copy is replaced.
  const usesFx = root.querySelector('[data-fx], [data-fx-scene], script[data-htmldeck-fx]') ||
    [...root.querySelectorAll('script')].some(n => /__htmldeckScenes/.test(n.textContent));
  if (usesFx) {
    root.querySelectorAll('script[data-htmldeck-fx]').forEach(n => n.remove());
    const fx = model.createElement('script');
    fx.textContent = `(${fxRuntime.toString()})(window, ${JSON.stringify({ controlled: provider !== 'page' })});`;
    root.querySelector('body').appendChild(fx);
  }
  if (bodyClass) root.querySelector('body').classList.add(...bodyClass.split(/\s+/).filter(Boolean));
  const cfg = { ...session, mode, slideIds: mode === 'deck' ? slideIds : [], start: mode === 'deck' ? start : 0 };
  const script = model.createElement('script');
  const runtime = provider === 'reveal' ? revealRuntime : presentRuntime;
  script.textContent = `(${runtime.toString()})(${JSON.stringify(cfg).replace(/</g, '\\u003c')});`;
  root.querySelector('body').appendChild(script);
  return (doctype || '<!DOCTYPE html>') + '\n' + root.outerHTML;
}
