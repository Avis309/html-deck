// HtmlDeck FX runtime: declarative effects (data-fx) on the Web Animations API.
// fxRuntime is self-contained: it is serialized into documents (inline <script data-htmldeck-fx>)
// and also called directly by the editor for previews and parsing, so it takes the window it
// works on and touches no module scope.
//
// Animations never write attributes or inline styles: transform offsets are composited onto the
// author's transform, opacity ends at the author's computed value, and once an animation ends or
// is cancelled the element is exactly as authored. The only DOM state the runtime owns: the class
// `fx-on` on <html>, `fx-wait` on targets waiting to play, and count-up text while it counts —
// all undone by settle()/dispose(). It never runs in the editor's edit frame.

export const FX_VERSION = 2;
export const FX_PRESETS = ['fade-in', 'fade-up', 'zoom-in', 'slide-left', 'count-up'];

export function fxRuntime(win, opts) {
  opts = opts || {};
  var doc = win.document, root = doc.documentElement;
  var PRESETS = {
    'fade-in': { opacity: true, from: null },
    'fade-up': { opacity: true, from: 'translateY(40px)' },
    'zoom-in': { opacity: true, from: 'scale(0.85)' },
    'slide-left': { opacity: true, from: 'translateX(60px)' },
    'count-up': { opacity: false, from: null, count: true },
  };

  // One number with an unambiguous format, the rest of the text kept verbatim.
  // → { pre, post, value, decimals, group, dec } | null
  function parseCount(text) {
    var m = /^(\D*?)(-?\d[\d.,   ]*\d|-?\d)(\D*)$/.exec(text);
    if (!m) return null;
    var num = m[2], neg = num.charAt(0) === '-';
    if (neg) num = num.slice(1);
    var seps = num.replace(/\d/g, ''), kinds = [];
    for (var i = 0; i < seps.length; i++) if (kinds.indexOf(seps[i]) < 0) kinds.push(seps[i]);
    var group = '', dec = '';
    if (kinds.length === 2) { dec = num.match(/\D(?=\d+$)/)[0]; group = kinds[0] === dec ? kinds[1] : kinds[0]; }
    else if (kinds.length === 1) {
      var k = kinds[0], parts = num.split(k);
      if (parts.length > 2 || /[   ]/.test(k)) group = k;
      else if (parts[1].length === 3) return null;           // "1.234": thousands or decimals?
      else dec = k;
    } else if (kinds.length > 2) return null;
    if (dec && !/[.,]/.test(dec)) return null;
    var intPart = dec ? num.slice(0, num.lastIndexOf(dec)) : num, frac = dec ? num.slice(num.lastIndexOf(dec) + 1) : '';
    if (group) {
      var g = intPart.split(group);
      if (!/^\d{1,3}$/.test(g[0]) || g.slice(1).some(function (x) { return !/^\d{3}$/.test(x); })) return null;
      intPart = g.join('');
    }
    if (!/^\d+$/.test(intPart) || (frac && !/^\d+$/.test(frac))) return null;
    var value = parseFloat(intPart + (frac ? '.' + frac : '')) * (neg ? -1 : 1);
    return { pre: m[1], post: m[3], value: value, decimals: frac.length, group: group, dec: dec, neg: neg };
  }
  function formatCount(p, v) {
    var s = Math.abs(v).toFixed(p.decimals), ip = s.split('.')[0], fp = s.split('.')[1];
    if (p.group) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, p.group);
    return p.pre + (v < 0 ? '-' : '') + ip + (fp ? p.dec + fp : '') + p.post;
  }
  // The single text node a count-up animates, or null.
  function countNode(el) {
    if (el.children.length) return null;
    var texts = [];
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) texts.push(c); else if (c.nodeType !== 8) return null;
    return texts.length === 1 && parseCount(texts[0].nodeValue) ? texts[0] : null;
  }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) && n >= 0 ? n : d; }
  function config(el) {
    var p = PRESETS[el.getAttribute('data-fx')];
    if (!p) return null;
    return { p: p, delay: num(el.getAttribute('data-fx-delay'), 0), dur: num(el.getAttribute('data-fx-dur'), 700), stagger: num(el.getAttribute('data-fx-stagger'), 0) };
  }
  // Elements Reveal animates itself: opacity/transform there belong to Reveal.
  function revealOwned(el) {
    return !!(el.closest('.fragment') || el.querySelector('.fragment') ||
      (el.closest('section[data-auto-animate]') && (el.closest('[data-id]') || el.querySelector('[data-id]'))));
  }
  function targets(el, c) { return c.stagger > 0 && !c.p.count ? Array.prototype.slice.call(el.children) : [el]; }
  var reduce = !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---- state
  var disposed = false, anims = new Set(), rafs = new Set(), texts = new Map(), active = new Set();
  // One run token per scope: leaving (or replaying) a scope ends only its own count-ups.
  var runs = new Map();
  function track(a) { anims.add(a); a.finished.then(function () { anims.delete(a); }, function () { anims.delete(a); }); return a; }
  function stop(scope) {
    if (scope) runs.set(scope, (runs.get(scope) || 0) + 1); else runs.clear();
    anims.forEach(function (a) { var t = a.effect && a.effect.target; if (!scope || (t && scope.contains(t))) { a.cancel(); anims.delete(a); } });
    texts.forEach(function (orig, node) { if (!scope || scope.contains(node)) { node.nodeValue = orig; texts.delete(node); } });
  }

  // ---- scenes: author code per scope (registerScene). The runtime owns their lifecycle: it
  // tracks timers / animations through ctx, and on leaving the scope stops them, removes
  // anime.js (v3) animations on the scope's elements, and restores the scope's authored markup
  // (snapshotted before any scene ran). Scenes should bind listeners by delegation: the scope's
  // children are replaced on restore.
  var scenes = [], sceneRuns = new Map(), sceneBase = new Map();
  function sceneDefsFor(el) { return scenes.filter(function (d) { return el.matches(d.selector); }); }
  function sceneEls(scope) {
    var out = [];
    scenes.forEach(function (d) {
      if (scope.matches(d.selector) && out.indexOf(scope) < 0) out.push(scope);
      Array.prototype.forEach.call(scope.querySelectorAll(d.selector), function (n) { if (out.indexOf(n) < 0) out.push(n); });
    });
    return out;
  }
  // The scope's markup as it is when its scene starts (after any runtime such as Reveal set it
  // up). Only the children are restored: the scope's own class/style can belong to that runtime.
  function snapshot(el) { sceneBase.set(el, el.innerHTML); }
  function startScenes(el) {
    stopScene(el);
    snapshot(el);
    var timers = new Set(), cleanups = [], owned = [], ctrl = 'AbortController' in win ? new win.AbortController() : null, live = true;
    var alive = function () { return live && !disposed; };
    var ctx = {
      alive: alive,
      signal: ctrl && ctrl.signal,
      // Resolves after ms while the scene is alive; never once it is stopped.
      wait: function (ms) { return new Promise(function (r) { var id = win.setTimeout(function () { timers.delete(id); if (alive()) r(); }, ms); timers.add(id); }); },
      timeout: function (fn, ms) { var id = win.setTimeout(function () { timers.delete(id); if (alive()) fn(); }, ms); timers.add(id); return id; },
      animate: function (t, frames, o) { var a = t.animate(frames, o); track(a); owned.push(a); return a; },
      anime: function (params) { var A = win.anime; if (!A) return null; var i = A(params); cleanups.push(function () { i.pause(); }); return i; },
      onCleanup: function (fn) { cleanups.push(fn); },
    };
    sceneRuns.set(el, { stop: function () { live = false; if (ctrl) ctrl.abort(); owned.forEach(function (a) { a.cancel(); anims.delete(a); }); timers.forEach(function (id) { win.clearTimeout(id); }); cleanups.forEach(function (f) { try { f(); } catch (e) { /* scene cleanup */ } }); } });
    sceneDefsFor(el).forEach(function (d) {
      try { var r = d.fn(el, ctx); if (r && typeof r.catch === 'function') r.catch(function () {}); }
      catch (e) { if (win.console) win.console.error('HtmlDeck scene "' + d.name + '":', e); }
    });
  }
  function stopScene(el) {
    var run = sceneRuns.get(el);
    if (!run) return;
    sceneRuns.delete(el);
    run.stop();
    var A = win.anime;
    if (A && typeof A.remove === 'function') { try { A.remove([el].concat(Array.prototype.slice.call(el.querySelectorAll('*')))); } catch (e) { /* not v3 */ } }
    stop(el);
    var html = sceneBase.get(el);
    sceneBase.delete(el);
    if (html != null && el.innerHTML !== html) el.innerHTML = html;
    // Reveal re-applies fragment visibility for the current slide after its children changed.
    var R = win.Reveal;
    if (R && typeof R.syncFragments === 'function' && el.closest && el.closest('.reveal')) { try { R.syncFragments(); } catch (e) { /* not ready */ } }
  }
  function registerScene(name, fn, o) {
    if (opts.preview || typeof fn !== 'function') return;
    var d = { name: String(name), fn: fn, selector: (o && o.selector) || '[data-fx-scene="' + String(name).replace(/"/g, '') + '"]' };
    scenes.push(d);
    if (io) Array.prototype.forEach.call(doc.querySelectorAll(d.selector), function (n) { io.observe(n); });
    active.forEach(function (scope) { sceneEls(scope).forEach(function (n) { if (sceneDefsFor(n).indexOf(d) >= 0) startScenes(n); }); });
  }

  // Play the effects inside `scope` (a slide / section / element). Returns the run token.
  function play(el, c, scope, t) {
    var list = targets(el, c);
    list.forEach(function (target, i) {
      var delay = c.delay + i * c.stagger;
      if (c.p.count) {
        var node = countNode(target);
        if (!node) { target.classList.remove('fx-wait'); return; }
        var spec = parseCount(node.nodeValue), orig = node.nodeValue, start = 0;
        texts.set(node, orig);
        node.nodeValue = formatCount(spec, 0);
        target.classList.remove('fx-wait');
        var t0 = null;
        var step = function (now) {
          rafs.delete(id);
          if (disposed || (runs.get(scope) || 0) !== t || !texts.has(node)) return;
          if (t0 === null) t0 = now + delay;
          var k = Math.min(1, Math.max(0, (now - t0) / c.dur)), e = 1 - Math.pow(1 - k, 3);
          node.nodeValue = k >= 1 ? orig : formatCount(spec, start + (spec.value - start) * e);
          if (k >= 1) { texts.delete(node); return; }
          id = win.requestAnimationFrame(step); rafs.add(id);
        };
        var id = win.requestAnimationFrame(step); rafs.add(id);
        return;
      }
      // Shown first, then measured: the author's opacity (not the waiting state's 0) is the
      // end value. Same task as animate(), so nothing is painted in between.
      target.classList.remove('fx-wait');
      var frames = [{}, {}];
      if (c.p.opacity) { frames[0].opacity = 0; frames[1].opacity = win.getComputedStyle(target).opacity; }
      var a = target.animate(frames, { duration: c.dur, delay: delay, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
      track(a);
      if (c.p.from) track(target.animate([{ transform: c.p.from }, { transform: 'none' }], { duration: c.dur, delay: delay, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards', composite: 'add' }));
    });
  }
  function fxIn(scope) {
    var list = scope.matches && scope.matches('[data-fx]') ? [scope] : [];
    return list.concat(Array.prototype.slice.call(scope.querySelectorAll('[data-fx]')));
  }
  function prepare(scope) {
    fxIn(scope).forEach(function (el) {
      var c = config(el);
      if (!c || revealOwned(el)) return;
      if (c.p.count && !countNode(el)) return;
      if (c.p.opacity) targets(el, c).forEach(function (t) { t.classList.add('fx-wait'); });
    });
  }
  function activate(scope) {
    if (disposed || !scope) return;
    deactivate(scope);
    active.add(scope);
    var t = runs.get(scope) || 0;
    if (reduce) return;
    fxIn(scope).forEach(function (el) {
      var c = config(el);
      if (!c || revealOwned(el) || (c.p.count && !countNode(el))) return;
      play(el, c, scope, t);
    });
    sceneEls(scope).forEach(startScenes);
  }
  // Leaving a scope: cancel and re-arm, so it plays again next time.
  function deactivate(scope) {
    if (!scope) return;
    sceneEls(scope).forEach(stopScene);
    stop(scope);
    active.delete(scope);
    if (!disposed && !reduce) prepare(scope);
  }
  function settle() {
    stop(null);
    rafs.forEach(function (id) { win.cancelAnimationFrame(id); }); rafs.clear();
    Array.prototype.forEach.call(doc.querySelectorAll('.fx-wait'), function (n) { n.classList.remove('fx-wait'); });
  }

  // ---- automatic triggers (standalone file, or a page): IntersectionObserver / Reveal events.
  var io = null, revealHooks = null;
  function scopeOf(el) { return el.closest('section, .slide') || el; }
  function auto() {
    var R = win.Reveal;
    if (R && typeof R.on === 'function' && doc.querySelector('.reveal .slides')) {
      var onChange = function () { if (R.isOverview && R.isOverview()) { settleScopes(); return; } activeOnly(R.getCurrentSlide()); };
      var onReady = function () { onChange(); };
      var hook = function () { ['slidechanged', 'overviewshown', 'overviewhidden'].forEach(function (e) { R.on(e, onChange); }); };
      try { hook(); if (R.isReady && R.isReady()) onReady(); else R.on('ready', onReady); } catch (e) { return; }
      revealHooks = function () { ['slidechanged', 'overviewshown', 'overviewhidden', 'ready'].forEach(function (e) { try { R.off(e, onChange); R.off(e, onReady); } catch (x) {} }); };
      return;
    }
    if (!('IntersectionObserver' in win)) { settle(); return; }
    io = new win.IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var tall = e.boundingClientRect.height > win.innerHeight * 0.6;
        if (e.isIntersecting && (e.intersectionRatio >= 0.3 || tall)) { if (!active.has(e.target)) activate(e.target); }
        else if (!e.isIntersecting && active.has(e.target)) deactivate(e.target);
      });
    }, { threshold: [0, 0.3] });
    var seen = new Set();
    Array.prototype.forEach.call(doc.querySelectorAll('[data-fx]'), function (el) { var s = scopeOf(el); if (!seen.has(s)) { seen.add(s); io.observe(s); } });
    scenes.forEach(function (d) { Array.prototype.forEach.call(doc.querySelectorAll(d.selector), function (n) { if (!seen.has(n)) { seen.add(n); io.observe(n); } }); });
  }
  function activeOnly(scope) {
    active.forEach(function (s) { if (s !== scope) deactivate(s); });
    if (scope) activate(scope);
  }
  function settleScopes() { sceneRuns.forEach(function (r, el) { stopScene(el); }); active.forEach(function (s) { stop(s); }); active.clear(); settle(); }

  var api = {
    version: 2,
    parseCount: parseCount,
    presets: Object.keys(PRESETS),
    // Present bootstraps drive the slides themselves.
    control: function () { if (io) { io.disconnect(); io = null; } if (revealHooks) { revealHooks(); revealHooks = null; } return api; },
    show: activeOnly,
    registerScene: registerScene,
    // Play a scope again from its authored state (e.g. a replay button).
    replay: function (scope) { if (scope && !disposed) { deactivate(scope); activate(scope); } },
    settle: function () { settleScopes(); },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      api.control();
      settleScopes();
      root.classList.remove('fx-on');
      if (style) style.remove();
    },
    // Editor preview: play one element's effect now, cancelled by stopPreview(). Never writes
    // the DOM: a count-up previews as a fade (its text is what the editor is editing).
    preview: function (el) {
      api.stopPreview();
      var c = config(el);
      if (!c || reduce) return;
      if (c.p.count) c = { p: PRESETS['fade-in'], delay: c.delay, dur: c.dur, stagger: 0 };
      play(el, c, el, runs.get(el) || 0);
    },
    stopPreview: function () { stop(null); settle(); },
    // Every data-fx inside a scope at once (the effects panel's "preview slide").
    previewAll: function (scope) {
      api.stopPreview();
      if (reduce || !scope) return;
      fxIn(scope).forEach(function (el) {
        var c = config(el);
        if (!c || revealOwned(el)) return;
        if (c.p.count) c = { p: PRESETS['fade-in'], delay: c.delay, dur: c.dur, stagger: 0 };
        play(el, c, scope, runs.get(scope) || 0);
      });
    },
  };
  if (opts.preview) return api;

  // Never in the editor's edit frame: only when presenting (ed-presenting is set before scripts).
  var editor = false;
  try { editor = win.parent !== win && typeof win.parent.__edKey === 'function'; } catch (e) { editor = false; }
  if (editor && !root.classList.contains('ed-presenting')) return api;
  if (win.__htmldeckFx) return win.__htmldeckFx;            // one runtime per document
  var style = doc.createElement('style');
  style.setAttribute('data-htmldeck-fx-style', '');
  style.textContent = 'html.fx-on .fx-wait{opacity:0!important}';
  doc.head.appendChild(style);
  win.__htmldeckFx = api;
  // Scenes registered before the runtime loaded wait in a queue (see registerScene).
  var queued = win.__htmldeckScenes;
  win.__htmldeckScenes = { push: function (args) { registerScene.apply(null, args); } };
  if (queued && queued.forEach) queued.forEach(function (args) { registerScene.apply(null, args); });
  if (!reduce) {
    Array.prototype.forEach.call(doc.querySelectorAll('[data-fx]'), function (el) { prepare(el); });
    root.classList.add('fx-on');
  }
  if (!opts.controlled) auto();
  return api;
}

// The inline block a document carries once FX is enabled.
export function fxScriptSource() {
  return `\n/* HtmlDeck FX v${FX_VERSION} — data-fx effects (Web Animations). Managed by HtmlDeck: "Tắt FX" removes it. */\n(${fxRuntime.toString()})(window);\n`;
}
