// HtmlDeck editor — composition root and (for now) the rest of the editor.
// Split plan: docs/superpowers/plans/2026-10-02-htmldeck-2.md
import { storedLang, layerName, translate, translateToastFor } from './i18n.mjs';
import { $, $$, fmtSize, clamp, escapeHTML, rgbToHex, parseTranslate, isTypingTarget, textHash } from './core/utils.mjs';
import { api, postJSON } from './services/api.mjs';
import * as Model from './core/model.mjs';
import { contentForSave as serializeForSave, tokenize, alignTokens, stripIds, VOID_TAGS } from './core/serializer.mjs';
import * as History from './core/history.mjs';
import * as Ops from './core/operations.mjs';
import { provenance, EDITOR_ATTRS } from './runtime/provenance.mjs';
import { textEditBlock, structureBlock, formatBlock } from './policy/edit-policy.mjs';
import { inspect as inspectFormat } from './formats/registry.mjs';
import * as Reveal from './formats/reveal.mjs';
import { fxRuntime, fxScriptSource, FX_VERSION } from './fx/runtime.mjs';
import { neuterScripts } from './core/sanitize.mjs';
import { editFreeze } from './runtime/freeze.mjs';
import { renderPresentHTML } from './present/render.mjs';
import { NS as PRESENT_NS, VERSION as PRESENT_V, newSessionId, createPresentSession } from './present/session.mjs';
import { setStyleAttr, setAttrs, nodeRefs, doRemove } from './core/operations.mjs';

// Language-bound wrappers over the pure i18n module (call sites stay unchanged).
const curLang = () => (typeof S !== 'undefined' && S && S.lang) || storedLang();
function getLayerName(tag) { return layerName(curLang(), tag); }
function t(key, fallback = '') { return translate(curLang(), key, fallback); }

function applyLanguage(lang) {
  if (typeof S !== 'undefined' && S) S.lang = lang;
  try { localStorage.setItem('gs9_editor_lang', lang); } catch {}
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  const ind = $('#lang-indicator');
  if (ind) ind.textContent = lang === 'zh' ? 'ZH' : lang.toUpperCase();
  
  // Update elements with data-i18n
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (!val) return;
    const textNodes = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0);
    if (textNodes.length) {
      const hasPrecedingIcon = el.classList.contains('rail-item') || el.classList.contains('tb-ghost') || el.classList.contains('btn-download') || el.classList.contains('btn-save') || el.classList.contains('btn-primary');
      textNodes[textNodes.length - 1].textContent = hasPrecedingIcon ? ' ' + val.trim() : val.trim();
    } else {
      const spanTarget = el.querySelector('span:not(.ic):not(.dot)');
      if (spanTarget) spanTarget.textContent = val;
      else if (!el.querySelector('svg, img')) el.textContent = val;
    }
  });

  // Update data-i18n-html
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    const val = t(key);
    if (val) el.innerHTML = val;
  });

  // Update data-i18n-title
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const val = t(key);
    if (val) el.title = val;
  });

  // Update data-i18n-placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const val = t(key);
    if (val) el.placeholder = val;
  });

  // Update dynamic elements
  if (typeof el !== 'undefined' && el.panel && el.panel.dataset.view) {
    const titleKey = 'panel_' + el.panel.dataset.view;
    const pt = $('#panel-title');
    if (pt) pt.textContent = t(titleKey);
  }
  if (typeof updateChrome === 'function') updateChrome();
  const idle = $('#idle-text');
  if (idle) idle.textContent = t('idle_hint');

  // Re-render open panels & dynamic views
  if (typeof boxVisible === 'function' && boxVisible()) drawBoxPanel();
  if (typeof layersVisible === 'function' && layersVisible()) buildLayers();
  if (typeof el !== 'undefined' && el.panel?.classList.contains('open')) {
    const view = el.panel.dataset.view;
    if (view === 'outline' && typeof buildOutline === 'function') buildOutline();
    else if (view === 'review' && typeof renderNoteList === 'function') renderNoteList();
    else if (view === 'files' && typeof renderFileList === 'function') renderFileList();
  }
  if (typeof applyModeUI === 'function') applyModeUI();
}

function openLangMenu() {
  const pop = $('#pop-lang');
  if (!pop) return;
  const isShowing = pop.classList.contains('show');
  if (isShowing) { pop.classList.remove('show'); return; }
  
  const cur = (typeof S !== 'undefined' && S && S.lang) || 'vi';
  pop.querySelectorAll('.lang-opt').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.lang === cur);
  });
  
  const btn = $('#btn-lang');
  if (btn) {
    const r = btn.getBoundingClientRect();
    pop.style.left = (r.right + 10) + 'px';
    pop.style.bottom = Math.max(12, innerHeight - r.bottom) + 'px';
  }
  pop.classList.add('show');
}

function selectLanguage(lang) {
  const pop = $('#pop-lang');
  if (pop) pop.classList.remove('show');
  applyLanguage(lang);
  const msgs = {
    vi: 'Đã chuyển sang Tiếng Việt',
    en: 'Switched language to English',
    zh: '已切换为简体中文'
  };
  toast(msgs[lang] || lang);
}


const DECK_W = 1280, DECK_H = 720;
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'canvas', 'video', 'audio', 'object', 'embed', 'select', 'textarea', 'input', 'button', 'img', 'picture', 'head', 'option']);
// Tags an inserted flow block must not land inside (the browser would re-parent it on reload).
const NO_BLOCK_PARENT = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'b', 'strong', 'em', 'i', 'u', 's', 'small', 'label', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'summary', 'code', 'pre', 'sup', 'sub', 'mark']);
const FONTS = [
  ['Be Vietnam Pro', 'sans-serif', '400;500;600;700;800;900'], ['Inter', 'sans-serif', '400;500;600;700;800;900'],
  ['Inter Tight', 'sans-serif', '400;500;600;700;800;900'], ['Montserrat', 'sans-serif', '400;500;600;700;800;900'],
  ['Roboto', 'sans-serif', '400;500;700;900'], ['Open Sans', 'sans-serif', '400;500;600;700;800'],
  ['Lexend', 'sans-serif', '400;500;600;700;800'], ['Oswald', 'sans-serif', '400;500;600;700'],
  ['Anton', 'sans-serif', '400'], ['Playfair Display', 'serif', '400;500;600;700;800;900'],
  ['JetBrains Mono', 'monospace', '400;500;700'], ['Arial', 'sans-serif', null], ['Georgia', 'serif', null],
  ['Times New Roman', 'serif', null],
];
const DEFAULT_COLORS = ['#0e0e11', '#3a3a42', '#55555e', '#8a8a94', '#dcdce2', '#ffffff', '#ff5a1f', '#e94209', '#b73108', '#ffe0d3', '#ec7f00', '#ffe7be', '#2e8a36', '#d1edcf', '#0072e0', '#cee5fe', '#da1e28', '#ffdad5', '#007995', '#e0f7fe', '#db41a5', '#ffe9f4', '#8e4ec6', '#f5eeff', '#44a948', '#5553e8', '#20a578'];
const PRESETS = {
  heading: { tag: 'h2', text: 'Thêm tiêu đề', css: { 'font-size': '56px', 'font-weight': '800', 'line-height': '1.05' }, top: 250 },
  subheading: { tag: 'h3', text: 'Thêm tiêu đề phụ', css: { 'font-size': '30px', 'font-weight': '700', 'line-height': '1.15' }, top: 330 },
  body: { tag: 'p', text: 'Thêm một đoạn văn bản', css: { 'font-size': '18px', 'font-weight': '400', 'line-height': '1.5' }, top: 380 },
};

// Editor CSS injected into the rendered document only (never into the saved model).
const FRAME_CSS = `
html.ed-deck, html.ed-deck body { overflow: hidden !important; height: 100% !important; }
html.ed-deck [data-ed-slide] { position: fixed !important; left: 0 !important; top: 0 !important; right: auto !important; bottom: auto !important;
  width: var(--ed-deck-w, ${DECK_W}px) !important; height: var(--ed-deck-h, ${DECK_H}px) !important; min-height: 0 !important; max-height: none !important; margin: 0 !important;
  transform: none !important; translate: none !important; scale: none !important; z-index: 2147483000 !important;
  box-shadow: none !important; border-radius: 0 !important; visibility: visible !important; opacity: 1 !important; }
html.ed-deck [data-ed-slide-anc] { transform: none !important; translate: none !important; scale: none !important; rotate: none !important;
  will-change: auto !important; filter: none !important; backdrop-filter: none !important; perspective: none !important; contain: none !important; }
[data-ed-edit] { cursor: text; }
[data-ed-edit]:not([contenteditable]):hover { outline: 1.5px solid rgba(255,90,31,.6) !important; outline-offset: 2px; }
[data-ed-edit][contenteditable] { outline: none !important; caret-color: #ff5a1f; }
::selection { background: rgba(255,90,31,.24); }
::highlight(ed-find) { background-color: rgba(255,196,0,.45); }
::highlight(ed-find-cur) { background-color: #ff9a1f; color: #000; }
[data-ed-overflow] { outline: 2px dashed #e5484d !important; outline-offset: 2px; }`;

// Runs before the document's own scripts: keyboard goes to the editor, never to deck handlers.
const FRAME_GUARD = `(function(){var P=window.parent;if(!P||P===window)return;
['keydown','keyup','keypress'].forEach(function(t){window.addEventListener(t,function(e){if(t==='keydown'&&P.__edKey)P.__edKey(e,true);e.stopImmediatePropagation();},true);});
window.addEventListener('wheel',function(e){if((e.ctrlKey||e.metaKey)&&P.__edWheel){e.preventDefault();e.stopImmediatePropagation();P.__edWheel(e);}},{capture:true,passive:false});
['beforeinput','input'].forEach(function(t){window.addEventListener(t,function(e){if(e.isTrusted&&P.__edInput)P.__edInput(e);},true);});})();`;

// Thumbnails render the slide inside a copy of its ancestor chain (theme selectors such as
// `.reveal .slides section` keep matching), with the same neutralised ancestors as the preview.
const thumbCSS = () => `html,body{margin:0!important;padding:0!important;width:${S.deckW}px!important;height:${S.deckH}px!important;overflow:hidden!important}
[data-ed-slide]{position:fixed!important;left:0!important;top:0!important;width:${S.deckW}px!important;height:${S.deckH}px!important;min-height:0!important;max-height:none!important;margin:0!important;transform:none!important;translate:none!important;scale:none!important;box-shadow:none!important;border-radius:0!important;visibility:visible!important;opacity:1!important}
[data-ed-slide-anc]{transform:none!important;translate:none!important;scale:none!important;rotate:none!important;will-change:auto!important;filter:none!important;backdrop-filter:none!important;perspective:none!important;contain:none!important}
*,*::before,*::after{animation:none!important;transition:none!important}`;

const S = {
  lang: storedLang(),
  source: null, doctype: '', model: null, nextId: 1, doc: null, win: null, baseURL: '',
  mode: 'page', slides: [], sections: [], cur: 0, scale: 1, fit: true, pageW: 1600,
  sel: null, editing: false, textDirty: false, savedRange: null, lastWrap: null, commitTimer: 0,
  undo: [], redo: [], seq: 0, savedSeq: 0, loadToken: 0, liveById: new Map(),
  presenting: false, present: null, format: null, readOnly: null, deckW: DECK_W, deckH: DECK_H, colorTarget: 'text', styleClip: null, trackRaf: 0, lastBox: '',
  thumbTimers: new Map(), files: [], saving: false, saveError: '',
};

const el = {
  frame: $('#frame'), stage: $('#stage'), scroller: $('#scroller'), sizer: $('#sizer'), sheet: $('#sheet'),
  ctx: $('#ctx'), box: $('#sel-box'), pill: $('#pill'), menu: $('#pill-menu'), shield: $('#shield'),
  filmstrip: $('#filmstrip'), notes: $('#notes'), notesText: $('#notes-text'), panel: $('#panel'),
};

// ================================================================ utilities
function translateToast(msg) { return translateToastFor(curLang(), msg); }

function toast(msg, { err = false, ms = 2600, action = null } = {}) {
  const tEl = $('#toast');
  tEl.textContent = translateToast(msg);
  tEl.classList.toggle('has-action', !!action);
  if (action) {
    const b = document.createElement('button');
    b.className = 't-act';
    b.textContent = action.label;
    b.addEventListener('click', () => { clearTimeout(toast.timer); tEl.classList.remove('show', 'has-action'); action.fn(); });
    tEl.appendChild(b);
  }
  tEl.classList.toggle('err', err);
  tEl.classList.add('show');
  clearTimeout(toast.timer);
  // Hidden with the toast: an action toast must not keep catching clicks once it fades.
  toast.timer = setTimeout(() => tEl.classList.remove('show', 'has-action'), ms);
}

// ================================================================ document model
// The model is a DOMParser copy of the source: scripts never run in it, so saving it back
// can never capture runtime DOM (minimaps, clones, classes added by the page's own JS).
// Every element gets a data-ed-id; the rendered iframe carries the same ids, which is how
// an edit in the live view is mapped back onto the model.
function buildModel(html) { Model.buildModel(S, html); }
function touchOp(op) { Model.touchOp(S, op); }
function reId(root) { Model.reId(S, root); }
function modelEl(id) { return Model.modelEl(S, id); }
// A live node is "original" only if it sits where the model says it does. A page script that
// clones an element keeps its data-ed-id, so id presence alone would let a clone edit the
// original's model node. The set is filled by walking model and live trees together.
function isOriginal(node) { return !!node && !!S.liveOriginal && S.liveOriginal.has(node); }
function markOriginals(live, model) {
  if (!live || !model) return;
  S.liveOriginal.add(live);
  // Siblings sharing one model id (a page script cloned it): which one is the authored node
  // cannot be told, so none of them is original and all are locked as ambiguous.
  const byId = new Map(), dup = new Set();
  for (const c of live.children) {
    const id = c.getAttribute('data-ed-id');
    if (!id) continue;
    if (byId.has(id)) { dup.add(id); S.liveAmbiguous.add(byId.get(id)); S.liveAmbiguous.add(c); } else byId.set(id, c);
  }
  for (const mc of model.children) { const id = mc.getAttribute('data-ed-id'); if (id && !dup.has(id)) markOriginals(byId.get(id), mc); }
}
// Provenance of a live node (plain data; see runtime/provenance.mjs).
const PROV_ENV = {
  isOriginal: n => isOriginal(n),
  isAmbiguous: n => !!S.liveAmbiguous && S.liveAmbiguous.has(n),
  modelOf: n => modelEl(n.dataset?.edId),
};
const provenanceOf = node => provenance(node, PROV_ENV);
function liveEl(id) {
  let node = S.liveById.get(id);
  if (node && node.isConnected) return node;
  node = S.doc ? $$(`[data-ed-id="${id}"]`, S.doc).find(isOriginal) || null : null;
  if (node) S.liveById.set(id, node);
  return node;
}
function renderHTML() {
  const root = S.model.documentElement.cloneNode(true);
  if (S.source && S.source.kind !== 'server') neuterScripts(root);
  const head = root.querySelector('head');
  const guard = S.model.createElement('script');
  guard.textContent = FRAME_GUARD;
  head.insertBefore(guard, head.firstChild);
  const freeze = S.model.createElement('script');
  freeze.textContent = `(${editFreeze.toString()})(window);`;
  head.insertBefore(freeze, guard.nextSibling);
  // The document's FX runtime stays inert while editing (it also refuses to run here).
  for (const n of root.querySelectorAll('script[data-htmldeck-fx]')) n.setAttribute('type', 'text/x-htmldeck-inert');
  if (S.format?.format === 'reveal') {
    const boot = S.model.createElement('script');
    boot.textContent = Reveal.EDIT_BOOTSTRAP;
    head.insertBefore(boot, freeze.nextSibling);
  }
  const style = S.model.createElement('style');
  style.textContent = FRAME_CSS;
  head.appendChild(style);
  return (S.doctype || '<!DOCTYPE html>') + '\n' + root.outerHTML;
}
function cleanFragment(html) { return Model.cleanFragment(S, html); }

function contentForSave() { return serializeForSave(S); }

// ================================================================ editable roots
function hasDirectText(node) {
  for (const c of node.childNodes) if (c.nodeType === 3 && /\S/.test(c.nodeValue)) return true;
  return false;
}
// Mark the outermost original elements that carry their own text as editable roots.
function markRoots(scope, includeSelf) {
  const walk = (node, isScope) => {
    if (SKIP_TAGS.has(node.localName) || !isOriginal(node) || node.classList.contains('notes')) return;
    if ((!isScope || includeSelf) && !node.hasAttribute('data-ed-slide') && hasDirectText(node)) {
      node.setAttribute('data-ed-edit', '');
      S.liveById.set(node.dataset.edId, node);
      return;
    }
    for (const c of node.children) walk(c, false);
  };
  walk(scope, true);
}
const isRoot = node => !!node && node.hasAttribute('data-ed-edit');

// ================================================================ open / load
const LAST_FILE_KEY = 'gs9_editor_last_file';
// The display mode picked by hand is remembered per file.
const modeKey = src => src ? 'gs9_editor_mode:' + (src.kind === 'server' ? src.path : src.name) : null;
function storedMode(src) {
  try { const m = localStorage.getItem(modeKey(src)); return m === 'deck' || m === 'page' ? m : null; } catch { return null; }
}
function storeMode(src, mode) {
  try { mode ? localStorage.setItem(modeKey(src), mode) : localStorage.removeItem(modeKey(src)); } catch {}
}
async function openServerFile(path) {
  if (!confirmDiscard()) return;
  setLoading(true);
  docState('loading', path);
  try {
    const data = await api(`/api/load?path=${encodeURIComponent(path)}`);
    await openDocument(data.content, { kind: 'server', path: data.path, name: data.filename, mtime: data.mtime_ns, size: data.size });
    try { localStorage.setItem(LAST_FILE_KEY, data.path); } catch {}
    return true;
  } catch (e) {
    setLoading(false);
    docState('error');
    toast('Không mở được file: ' + e.message, { err: true, ms: 5000 });
    return false;
  }
}
async function openFromHandle(handle) {
  const file = await handle.getFile();
  await openDocument(await file.text(), { kind: 'handle', handle, name: file.name, size: file.size });
}
async function pickLocalFile() {
  if (!confirmDiscard()) return;
  if (!window.showOpenFilePicker) { $('#file-input').click(); return; }
  try {
    const [handle] = await window.showOpenFilePicker({ types: [{ description: 'HTML', accept: { 'text/html': ['.html', '.htm'] } }] });
    setLoading(true);
    await openFromHandle(handle);
  } catch (e) {
    setLoading(false);
    if (e.name !== 'AbortError') toast('Không mở được file: ' + e.message, { err: true });
  }
}
async function openUpload(file) {
  setLoading(true);
  try { await openDocument(await file.text(), { kind: 'upload', name: file.name, size: file.size }); }
  catch (e) { setLoading(false); toast('Không đọc được file: ' + e.message, { err: true }); }
}
function confirmDiscard() {
  flushPending();
  if (!isDirty()) return true;
  const ok = confirm(S.lang === 'zh' ? '文档有未保存的更改。是否放弃这些更改？' : (S.lang === 'en' ? 'Document has unsaved changes. Discard changes?' : 'Tài liệu có thay đổi chưa lưu. Bỏ các thay đổi đó?'));
  if (ok) clearDraft();
  return ok;
}
function resetState() {
  endPresent({ restore: false });
  S.revealObs?.disconnect(); S.revealObs = null;
  S.centerRO?.disconnect(); S.centerRO = null;
  S.readOnly = null;
  stopFxPreview(); S.fxPreview = null;
  stopTrack();
  endEditSession();
  S.touchedInFlight = null;
  S.sel = null; S.editing = false; S.textDirty = false; S.savedRange = null; S.lastWrap = null;
  clearTimeout(S.commitTimer);
  S.undo = []; S.redo = []; S.seq = 0; S.savedSeq = 0; S.saveError = '';
  if (S.crop) { S.crop.cancelDrag?.(); S.crop = null; el.ctx.classList.remove('crop-mode'); el.box.classList.remove('crop'); }
  clearTimeout(S.notesTimer); S.notesTimer = 0; S.saving = false;
  clearTimeout(S.draftTimer);
  S.liveById = new Map(); S.slides = []; S.sections = []; S.cur = 0; S.doc = null; S.win = null;
  S.layerScope = null; S.linkCtx = null; S.spacingDrag = false;
  S.find = null; S.overflows = []; clearTimeout(S.findTimer); clearTimeout(S.overflowTimer);
  $('#sb-overflow').hidden = true;
  S.thumbTimers.forEach(t => clearTimeout(t)); S.thumbTimers.clear();
  hideOverlay();
  drawOffsets(null);
  drawSnapGuides(null);
  closePopups();
  refreshToolbar();
}
async function openDocument(html, source) {
  const token = ++S.loadToken;
  resetState();
  S.forceMode = storedMode(source);
  $('#sb-mode').value = S.forceMode || 'auto';
  try {
    buildModel(html);
    S.format = inspectFormat(S.model);
    S.source = source;
    S.diskHash = source.diskHash || textHash(html);
    const dir = source.kind === 'server' ? source.path.split('/').slice(0, -1).map(encodeURIComponent).join('/') : '';
    S.baseURL = location.origin + '/' + (dir ? dir + '/' : '');
    await mountModel(token);
    loadAgentNotes();
    if (!source.restored) offerDraft(html, source).catch(() => {});
  } catch (e) {
    if (e.status === 404) e.message = 'server đang chạy là bản cũ — tắt (Ctrl+C) rồi chạy lại htmldeck';
    // Never leave the previous document on screen bound to a half-built model.
    S.model = null; S.source = null;
    el.frame.onload = null;
    el.frame.src = 'about:blank';
    el.stage.classList.add('empty');
    updateChrome();
    throw e;
  }
}
// Remote scripts (CDN…) do not run in the edit frame unless the user trusted this file: the
// server's CSP enforces it in the browser (also for scripts loaded dynamically). Trust is kept
// per file together with the list of remote script URLs it was given for.
function remoteScripts() {
  const out = [];
  for (const n of S.model?.querySelectorAll('script') || []) {
    const src = n.getAttribute('src') || '';
    if (/^(https?:)?\/\//i.test(src)) out.push(src);
    for (const m of (n.textContent || '').matchAll(/(?:import\s*\(?|from)\s*['"]((?:https?:)?\/\/[^'"]+)['"]/gi)) out.push(m[1]);
  }
  return [...new Set(out)].sort();
}
const trustKey = () => S.source?.kind === 'server' ? 'htmldeck_trust:' + S.source.path : null;
function trustRemote() {
  const k = trustKey(), sig = remoteScripts().join('\n');
  if (!k || !sig) return false;
  try { return localStorage.getItem(k) === sig; } catch { return false; }
}
// Applied first, remembered only once the edit frame was rebuilt with it: a cancelled or
// failed rebuild leaves both the stored choice and the running frame as they were.
async function setTrust(on) {
  const k = trustKey();
  if (!k) return;
  S.trustOverride = on;
  let ok = false;
  try { ok = await rerender(); } finally { S.trustOverride = undefined; }
  if (ok) try { on ? localStorage.setItem(k, remoteScripts().join('\n')) : localStorage.removeItem(k); } catch {}
  renderTrustChip();
}
function renderTrustChip() {
  const b = $('#sb-trust'), remote = S.source?.kind === 'server' && remoteScripts().length;
  b.hidden = !remote;
  if (!remote) return;
  const on = !!S.mountedTrust;   // what the running frame was built with
  b.classList.toggle('on', on);
  b.textContent = t(on ? 'trust_on' : 'trust_off');
  b.title = t(on ? 'trust_on_title' : 'trust_off_title');
}
async function mountModel(token) {
  const trust = S.trustOverride ?? trustRemote();
  const { url } = await postJSON('/api/preview', { path: S.source.kind === 'server' ? S.source.path : null, content: renderHTML(), target: 'edit', trust_remote: trust });
  S.mountedTrust = trust;
  if (token !== S.loadToken) return;
  el.frame.onload = () => { if (token === S.loadToken) onFrameReady(); };
  el.frame.src = url;
}
// Re-render the current model (e.g. after switching slide/page mode). Live nodes are
// replaced, so undo history cannot survive; unsaved edits are kept in the model.
async function rerender({ force = false, dirty: knownDirty } = {}) {
  if (!S.model) return false;
  if (S.saving) { toast('Đang lưu — đợi lưu xong rồi đổi cách hiển thị'); return false; }
  if (!force) flushPending();
  if (!force && (S.undo.length || S.redo.length) && !confirm(S.lang === 'zh' ? '切换显示模式将清空撤销历史（更改仍将保留）。是否继续？' : (S.lang === 'en' ? 'Switching display mode will clear undo history (changes will remain). Continue?' : 'Đổi cách hiển thị sẽ xoá lịch sử hoàn tác (các thay đổi vẫn giữ nguyên). Tiếp tục?'))) return false;
  const dirty = knownDirty ?? isDirty(), token = ++S.loadToken;
  resetState();
  S.savedSeq = dirty ? -1 : 0;
  setLoading(true);
  try { await mountModel(token); }
  catch (e) { setLoading(false); toast('Không dựng lại được: ' + e.message, { err: true }); return false; }
  return true;
}
function onFrameReady() {
  const doc = el.frame.contentDocument, win = el.frame.contentWindow;
  if (!doc || !doc.body) { setLoading(false); toast('Không dựng được tài liệu', { err: true }); return; }
  S.doc = doc; S.win = win;
  S.liveOriginal = new WeakSet();
  S.liveAmbiguous = new WeakSet();
  markOriginals(doc.documentElement, S.model.documentElement);
  // Detection measures layout: the frame must be displayed first. On the first document of a
  // session the empty stage hides it, and every block would measure 0×0.
  el.stage.classList.remove('empty');

  S.deckW = DECK_W; S.deckH = DECK_H; S.revealCenter = false;
  const slides = S.format?.format === 'reveal' ? setupReveal(doc, win) : detectSlides(doc, win);
  const fmtStyle = doc.createElement('style');
  fmtStyle.id = 'ed-format';
  fmtStyle.textContent = `:root { --ed-deck-w: ${S.deckW}px; --ed-deck-h: ${S.deckH}px; }` + (S.format?.format === 'reveal' ? Reveal.editCSS() + Reveal.backgroundCSS(Reveal.leaves(S.model)) : '');
  doc.head.appendChild(fmtStyle);
  S.mode = S.forceMode || (slides.length ? 'deck' : 'page');
  if (S.mode === 'deck' && !slides.length) {
    S.mode = 'page';
    S.forceMode = null;
    $('#sb-mode').value = 'auto';
    toast('Tài liệu không có khối .slide nào — giữ dạng trang web', { ms: 4000 });
  }
  if (S.mode === 'page') slides.length = 0;
  for (const s of slides) {
    const d = win.getComputedStyle(s).display;
    s.dataset.edDisplay = d && d !== 'none' ? d : 'block';
    s.setAttribute('data-ed-slide', '');
  }
  S.slides = slides;
  // A transformed ancestor (e.g. a deck track with will-change: transform) becomes the containing
  // block of the fixed slide, which the 0-height overflow-hidden body then clips to nothing.
  const ancs = new Set();
  for (const s of slides) for (let n = s.parentElement; n && n !== doc.documentElement; n = n.parentElement) ancs.add(n);
  ancs.forEach(n => n.setAttribute('data-ed-slide-anc', ''));
  doc.documentElement.classList.add(S.mode === 'deck' ? 'ed-deck' : 'ed-page');
  if (S.mode === 'deck') slides.forEach(s => markRoots(s, false));
  else if (isOriginal(doc.body)) markRoots(doc.body, false);

  bindFrameEvents(doc, win);
  // Feedback lives in a sidecar next to a workspace file; nothing to pin for other files.
  $('#pill-note').disabled = S.source.kind !== 'server';
  S.fit = true;
  applyModeUI();
  if (S.mode === 'deck') { showSlide(0); centerAllSlides(); buildFilmstrip(); }
  else if (S.sections.length) { buildFilmstrip(); trackSection(); }
  buildOutline();
  buildDocColors();
  layout();
  updateChrome();
  renderPins();
  setLoading(false);
  docState('ready', S.source.kind === 'server' ? S.source.path : S.source.name);
  renderFileList();
  if (!$('#findbar').hidden) runFind();
  S.overflows = [];
  setTimeout(() => { if (S.doc === doc) checkOverflow(true); }, 700);
  const n = S.liveById.size;
  renderTrustChip();
  if (S.readOnly) toast(t(S.readOnly), { ms: 6000 });
  else if (!$('#sb-trust').hidden && !S.mountedTrust) toast(t('trust_toast'), { ms: 8000, action: { label: t('trust_action'), fn: () => setTrust(true) } });
  else toast(`Đã mở ${S.source.name} · ${S.mode === 'deck' ? S.slides.length + ' slide' : 'trang web'} · ${n} khối chữ sửa được`);
  if (S.afterReady) { const f = S.afterReady; S.afterReady = null; f(); }
}
// A deck is a group of ≥2 sibling `.slide` blocks at presentation width; a carousel of small
// `.slide` cards on a normal page must stay in page mode.
function detectSlides(doc, win) {
  const all = $$('.slide', doc).filter(s => isOriginal(s) && !s.parentElement.closest('.slide'));
  const groups = new Map();
  for (const s of all) groups.set(s.parentElement, [...(groups.get(s.parentElement) || []), s]);
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
  if (S.forceMode === 'deck') return best;
  // `.slide` blocks laid out as one long scrolling page are report sections, not slides: keep
  // page mode (nothing gets cut off) and use them only as jump targets in the filmstrip.
  if (isSectionReport(best, win)) { S.sections = best.filter(s => win.getComputedStyle(s).display !== 'none'); return []; }
  const wide = best.filter(s => { const w = parseFloat(win.getComputedStyle(s).width); return !(w > 0) || w >= 900; });
  return best.length >= 2 && wide.length === best.length ? best : [];
}
// Reveal deck in the edit preview: its runtime was intercepted by the bootstrap (see
// formats/reveal.mjs), so the DOM is the authored one. Returns the leaf slides.
function setupReveal(doc, win) {
  const st = win.__htmldeckReveal || {};
  const size = Reveal.slideSize(st.config);
  S.deckW = Math.round(size.width); S.deckH = Math.round(size.height); S.revealCenter = size.center;
  if (size.unsupported) toast(t('reveal_size_warn'), { ms: 5000 });
  // A runtime that ran (or may still run: an ES module cannot be intercepted) owns this DOM.
  const rt = S.format.runtime;
  if (Reveal.runtimeRan(doc) || rt.module || (rt.classic && win.Reveal && !st.intercepted)) setReadOnly('lock_reveal_runtime');
  else {
    // A late start (plugin loaded after load, a timer) is caught when it marks the DOM.
    const box = doc.querySelector('.reveal');
    S.revealObs = new win.MutationObserver(() => { if (Reveal.runtimeRan(doc)) setReadOnly('lock_reveal_runtime'); });
    if (box) S.revealObs.observe(box, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }
  // The theme styles the body through this class, which Reveal's runtime would have added.
  doc.body.classList.add('reveal-viewport');
  return Reveal.leaves(doc).map(l => l.el).filter(isOriginal);
}
// Read-only document: every path that writes the model is refused (pushOp is the safety net).
function setReadOnly(key) {
  if (S.readOnly) return;
  flushPending();
  if (S.sel) deselect();
  S.readOnly = key;
  el.notesText.disabled = true;
  lockedHint(key);
  updateChrome();
}
// Reveal centres a slide vertically from its content height (config.center, or .center).
function centerSlide(s) {
  if (!s || S.format?.format !== 'reveal') return;
  const on = S.revealCenter || s.classList.contains('center');
  const top = on ? Math.max(0, Math.round((S.deckH - s.offsetHeight) / 2)) : 0;
  s.style.setProperty('--ed-top', top + 'px');
}
function centerAllSlides() {
  if (S.format?.format !== 'reveal' || S.mode !== 'deck') return;
  S.slides.forEach((s, i) => {
    const hidden = i !== S.cur;
    if (hidden) s.style.setProperty('display', s.dataset.edDisplay, 'important');
    centerSlide(s);
    if (hidden) s.style.setProperty('display', 'none', 'important');
  });
  S.centerRO?.disconnect();
  S.centerRO = new S.win.ResizeObserver(() => centerSlide(S.slides[S.cur]));
  if (S.slides[S.cur]) S.centerRO.observe(S.slides[S.cur]);
}
const formatFlags = node => S.format?.format === 'reveal' ? Reveal.nodeFlags(node) : null;
// Judged on the layout the document actually renders, not on class names: ≥2 visible blocks
// in normal flow, stacked top to bottom, and not all 16:9 (a Marp-style export that stacks
// real slides vertically keeps every block at 16:9 and stays a deck).
function isSectionReport(list, win) {
  const vis = list.filter(s => win.getComputedStyle(s).display !== 'none');
  if (vis.length < 2) return false;
  if (!vis.every(s => ['static', 'relative', 'sticky'].includes(win.getComputedStyle(s).position))) return false;
  const r = vis.map(s => s.getBoundingClientRect());
  if (!r.slice(1).every((b, k) => b.top >= r[k].bottom - 2)) return false;
  return !r.every(x => x.width > 0 && Math.abs(x.height / x.width - 9 / 16) < 0.06);
}
function setLoading(on) { $('#loading').classList.toggle('show', on); }
// Stable, DOM-level load signal (tests and tools wait on it instead of on timers):
// <body data-doc-state="loading|ready|error" data-doc-path="…" data-doc-seq="n">.
function docState(state, path) {
  const b = document.body;
  b.dataset.docState = state;
  if (path != null) b.dataset.docPath = path;
  if (state === 'ready') b.dataset.docSeq = String((+b.dataset.docSeq || 0) + 1);
}

// ================================================================ frame events
function bindFrameEvents(doc, win) {
  doc.addEventListener('pointerdown', e => {
    if (S.presenting || e.button !== 0) return;
    closePopups();
    const t = e.target.nodeType === 1 ? e.target : e.target.parentElement;
    if (e.altKey) {
      const block = t && pickBlock(t);
      e.preventDefault();
      if (block) select(block, { edit: false }); else deselect();
      return;
    }
    const img = t && t.closest('img');
    if (img && isOriginal(img)) {
      e.preventDefault();
      select(img, { edit: false });
      return;
    }
    const root = t && t.closest('[data-ed-edit]');
    if (root && isOriginal(root)) {
      if (root !== S.sel || !S.editing) select(root, { edit: true });
      return;
    }
    if (S.sel) deselect();
    // Text the user clicked that the editor will not touch: say why instead of doing nothing.
    if (t && t !== doc.body && !t.hasAttribute('data-ed-slide') && /\S/.test(t.textContent || '')) {
      const p = provenanceOf(t);
      if (p.mapping !== 'authored') lockedHint(p.mapping === 'ambiguous' ? 'lock_ambiguous' : 'lock_generated');
    }
  }, true);

  doc.addEventListener('click', e => {
    const a = e.target.closest?.('a[href]');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href.startsWith('#') && href.length > 1) {
        const target = doc.getElementById(decodeURIComponent(href.slice(1)));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (!a.closest('[data-ed-edit]')) {
        toast('Liên kết được tắt khi đang chỉnh sửa');
      }
    }
    if (e.target.closest?.('form') && e.target.closest('[type=submit]')) e.preventDefault();
  }, true);
  doc.addEventListener('submit', e => e.preventDefault(), true);

  // Ownership of the browser's edit is claimed by window.__edInput (called from the frame
  // guard, the first capture listener of the frame); this one only schedules the commit.
  doc.addEventListener('input', e => {
    if (!e.isTrusted || !S.editing || !S.session || !S.session.node.contains(e.target)) return;
    S.textDirty = true;
    scheduleCommit();
    updateChrome();
  }, true);
  doc.addEventListener('paste', e => {
    if (!S.editing || !S.sel.contains(e.target)) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    doc.execCommand('insertText', false, text);
  });
  doc.addEventListener('dragstart', e => { if (S.editing || e.target.closest?.('img')) e.preventDefault(); });
  // Drop an image file straight onto a picture on the page to replace it.
  const dropImg = e => { const t = e.target.nodeType === 1 ? e.target : e.target.parentElement; const img = t?.closest('img'); return img && isOriginal(img) ? img : null; };
  doc.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files') && dropImg(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  doc.addEventListener('drop', e => {
    const img = dropImg(e), file = e.dataTransfer?.files?.[0];
    if (img && file) { e.preventDefault(); select(img, { edit: false }); replaceWithFile(img, file); return; }
    if (S.sel && S.sel.contains(e.target)) e.preventDefault();
  });
  doc.addEventListener('dblclick', e => {
    const img = e.target.closest?.('img');
    if (img && isOriginal(img) && !S.presenting) { select(img, { edit: false }); enterCrop(); }
  });
  doc.addEventListener('selectionchange', () => {
    if (!S.editing || !S.sel) return;
    const sel = win.getSelection();
    if (sel.rangeCount && S.sel.contains(sel.getRangeAt(0).commonAncestorContainer)) S.savedRange = sel.getRangeAt(0).cloneRange();
    cancelAnimationFrame(refreshToolbar.raf);
    refreshToolbar.raf = requestAnimationFrame(refreshToolbar);
  });
  win.addEventListener('scroll', () => { if (S.sel) positionOverlay(true); }, { passive: true });
}
// Nearest original element that is a meaningful block (not the slide/body itself).
function pickBlock(t) {
  let node = t.closest('[data-ed-id]');
  while (node && !isOriginal(node)) node = node.parentElement?.closest('[data-ed-id]');
  if (!node || node === S.doc.body || node === S.doc.documentElement || node.hasAttribute('data-ed-slide')) return null;
  if (formatFlags(node)?.section) return null;
  return node;
}

// ================================================================ selection
function select(node, { edit = true } = {}) {
  stopFxPreview();
  if (S.crop && S.crop.img !== node) exitCrop();
  if (S.sel && S.sel !== node) deselect();
  S.sel = node;
  setEditing(edit && isRoot(node));
  el.pill.classList.add('show');
  el.box.classList.add('show');
  el.box.classList.toggle('block', !isRoot(node));
  const slideIdx = S.slides.indexOf(node.closest('[data-ed-slide]'));
  if (slideIdx >= 0 && slideIdx !== S.cur) showSlide(slideIdx, { keepSel: true });
  refreshToolbar();
  startTrack();
  syncLayers();
}
function setEditing(on) {
  const node = S.sel;
  if (!node) return;
  if (on === S.editing && (!on || node.isContentEditable)) return;
  if (on) {
    const block = S.readOnly || textEditBlock(provenanceOf(node)) || formatBlock('text', formatFlags(node));
    if (block) { lockedHint(block, node); return; }
    node.setAttribute('contenteditable', 'true');
    node.setAttribute('spellcheck', 'false');
    S.editing = true;
    startEditSession(node);
    if (S.doc.activeElement !== node) node.focus({ preventScroll: true });
  } else {
    commitText();
    endEditSession();
    node.removeAttribute('contenteditable');
    node.removeAttribute('spellcheck');
    S.editing = false;
    S.savedRange = null;
    S.win.getSelection().removeAllRanges();
    node.blur();
  }
  el.box.classList.toggle('editing', S.editing);
}
function deselect() {
  stopFxPreview();
  exitCrop();
  if (!S.sel) return;
  setEditing(false);
  S.sel = null;
  S.lastWrap = null;
  closePopups();
  hideOverlay();
  refreshToolbar();
  syncLayers();
}
function placeCaretEnd(node) {
  const r = S.doc.createRange();
  r.selectNodeContents(node);
  r.collapse(false);
  const sel = S.win.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
function selectAllIn(node) {
  const r = S.doc.createRange();
  r.selectNodeContents(node);
  const sel = S.win.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  S.savedRange = r.cloneRange();
}

// ================================================================ history
const topSeq = () => History.topSeq(S);
const isDirty = () => History.isDirty(S);
function pushOp(op) {
  stopFxPreview();
  // Read-only: whatever slipped past the UI gates is undone before it is recorded.
  if (S.readOnly) { applyOp(op, false); lockedHint(S.readOnly); return; }
  History.recordOp(S, op);
  updateChrome();
  if (layersVisible()) { clearTimeout(S.layerTimer); S.layerTimer = setTimeout(buildLayers, 150); }
  afterChange();
}
// Keep find results and overflow warnings in step with the document.
function afterChange() {
  if (effectsVisible()) { clearTimeout(S.fxListTimer); S.fxListTimer = setTimeout(renderFxList, 150); }
  if (!$('#findbar').hidden) { clearTimeout(S.findTimer); S.findTimer = setTimeout(() => runFind(true), 200); }
  scheduleOverflowCheck(true);
}
function scheduleCommit() {
  clearTimeout(S.commitTimer);
  S.commitTimer = setTimeout(commitText, 700);
}
function flushPending() {
  if (S.notesTimer) { clearTimeout(S.notesTimer); S.notesTimer = 0; saveNotes(); }
  commitText();
}
// ---------------------------------------------------------------- edit session
// While a block is being typed into, its live subtree is copied back into the model on commit.
// A MutationObserver watches that subtree: changes the editor makes itself (typing, paste,
// formatting, links) are claimed synchronously through markTextDirty(); anything still
// reaching the observer was done by the page's own scripts, and the commit is refused.
function startEditSession(node) {
  endEditSession();
  const mo = new S.win.MutationObserver(records => {
    if (!S.session || S.session.node !== node) return;
    if (records.some(isForeignRecord)) S.session.conflicted = true;
  });
  mo.observe(node, { subtree: true, childList: true, characterData: true, attributes: true });
  S.session = { node, mo, conflicted: false, typed: node.innerText };
}
// Attributes of the block itself are not saved by a text commit (only its children are), and
// the editor's own markers never count.
function isForeignRecord(r) {
  if (r.type !== 'attributes') return true;
  return r.target !== S.session?.node && !EDITOR_ATTRS.has(r.attributeName);
}
function endEditSession() {
  if (!S.session) return;
  S.session.mo.disconnect();
  S.session = null;
}
// Claim the pending records as the editor's own: only right after a synchronous editor change
// (or from the capture-phase input listener), when no page code has run in between.
function markTextDirty() {
  S.textDirty = true;
  claimOwn();
}
function claimOwn() {
  if (!S.session) return;
  S.session.mo.takeRecords();
  // Once the page has rewritten the block, its text is no longer what the user typed.
  if (!S.session.conflicted) S.session.typed = S.session.node.innerText;
}
function noteForeign(records) {
  if (S.session && records.some(isForeignRecord)) S.session.conflicted = true;
}
// Give elements the user created while typing (bold, links, Enter) model ids before they are
// committed, so the block stays editable afterwards. A browser splitting a paragraph copies its
// attributes, data-ed-id included: a repeated id is reassigned too.
function adoptNewElements(root) {
  // An id stays with the original element holding it, wherever a copy of it appears.
  const owner = new Map();
  for (const n of root.querySelectorAll('[data-ed-id]')) if (isOriginal(n)) owner.set(n.getAttribute('data-ed-id'), n);
  const seen = new Set();
  for (const n of root.querySelectorAll('*')) {
    const id = n.getAttribute('data-ed-id');
    const keep = id && id !== root.dataset.edId && (owner.has(id) ? owner.get(id) === n : !seen.has(id));
    if (!keep) n.setAttribute('data-ed-id', String(S.nextId++));
    seen.add(n.getAttribute('data-ed-id'));
  }
}
function lockedHint(key, node = null) {
  const now = Date.now(), k = key + ':' + (node?.dataset?.edId || '') + ':' + S.loadToken;
  if (S.lockHint && S.lockHint.k === k && now - S.lockHint.t < 2500) return;
  S.lockHint = { k, t: now };
  toast(t(key), { ms: 5000 });
}
function commitText() {
  clearTimeout(S.commitTimer);
  const node = S.sel;
  if (!node || !S.textDirty) return;
  S.textDirty = false;
  const id = node.dataset.edId, m = modelEl(id);
  if (!m) return;
  // Only an edit session started on this block may write it back (see startEditSession).
  const session = S.session?.node === node ? S.session : null;
  if (!session) return;
  noteForeign(session.mo.takeRecords());
  if (session.conflicted) {
    // The page rewrote this block while it was being edited: its subtree is no longer the
    // authored one, so nothing of it may reach the model. Put the authored content back and
    // offer what the user had typed (recorded at their last own input) for copying.
    const typed = session.typed;
    node.innerHTML = m.innerHTML;
    markOriginals(node, m);
    S.savedRange = null; S.lastWrap = null;
    placeCaretEnd(node);
    session.mo.takeRecords();
    session.conflicted = false;
    session.typed = node.innerText;
    toast(t('lock_conflict'), { ms: 9000, err: true, action: { label: t('lock_copy_typed'), fn: () => navigator.clipboard?.writeText(typed) } });
    updateChrome();
    return;
  }
  adoptNewElements(node);
  session.mo.takeRecords();
  const before = m.innerHTML, after = cleanFragment(node.innerHTML);
  if (before === after) { updateChrome(); return; }
  m.innerHTML = after;
  markOriginals(node, m);
  pushOp({ type: 'html', id, before, after, label: 'Sửa chữ' });
  queueThumb(node);
}
// Does an inline declaration lose to a stylesheet `!important` rule (Tailwind `important: true`,
// `!` utilities, hand-written overrides)? Measured, not guessed: read the computed values with
// the declaration at normal priority, then at !important; a difference means normal loses.
// Shorthands are compared on their longhands. Transitions are paused during the probe; the
// editor's own slide locks (FRAME_CSS) are never fought.
const STYLE_LONGHANDS = {
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  border: ['border-top-width', 'border-top-style', 'border-top-color', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  background: ['background-color', 'background-image'],
};
function needsImportant(el, prop) {
  if (!el?.isConnected || !S.win || el.hasAttribute('data-ed-slide')) return false;
  const st = el.style, val = st.getPropertyValue(prop);
  if (!val || st.getPropertyPriority(prop)) return false;
  const longs = STYLE_LONGHANDS[prop] || [prop];
  const tv = st.getPropertyValue('transition'), tp = st.getPropertyPriority('transition');
  st.setProperty('transition', 'none', 'important');
  try {
    const cs = S.win.getComputedStyle(el);
    const a = longs.map(p => cs.getPropertyValue(p));
    st.setProperty(prop, val, 'important');
    const b = longs.map(p => cs.getPropertyValue(p));
    st.setProperty(prop, val, '');
    return a.some((x, i) => x !== b[i]);
  } finally {
    if (tv) st.setProperty('transition', tv, tp); else st.removeProperty('transition');
  }
}
// Apply CSS properties to model + live and return the op (not pushed), or null if no change.
// Refuse a command on a node the policy locks (reason shown); true when blocked.
function commandBlocked(node, kind = 'edit') {
  const block = node && (S.readOnly || structureBlock(provenanceOf(node)) || formatBlock(kind, formatFlags(node)));
  if (block) lockedHint(block, node);
  return !!block;
}
function buildStyleOp(node, props) {
  if (commandBlocked(node)) return null;
  const id = node.dataset.edId, m = modelEl(id);
  if (!m) return null;
  const before = m.getAttribute('style');
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === '') { m.style.removeProperty(k); continue; }
    // "value !important" forces priority; otherwise keep the priority the file already gave it.
    const forced = /\s*!important\s*$/i.test(v);
    m.style.setProperty(k, v.replace(/\s*!important\s*$/i, ''), forced ? 'important' : m.style.getPropertyPriority(k));
  }
  let after = m.getAttribute('style');
  if (after === '') { m.removeAttribute('style'); after = null; }
  setStyleAttr(node, after);
  // Escalate only the declarations the page's own !important rules would otherwise ignore.
  let raised = false;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === '' || m.style.getPropertyPriority(k) || !needsImportant(node, k)) continue;
    m.style.setProperty(k, m.style.getPropertyValue(k), 'important');
    raised = true;
  }
  if (raised) { after = m.getAttribute('style'); setStyleAttr(node, after); }
  claimOwn();
  return before === after ? null : { type: 'style', id, before, after, label: 'Định dạng' };
}
function styleEdit(node, props, key) {
  commitText();
  const op = buildStyleOp(node, props);
  if (!op) return;
  op.key = key ? key + ':' + op.id : null;
  pushOp(op);
  queueThumb(node);
}
// How operations reach the rendered iframe (see core/operations.mjs).
const LIVE = {
  el: id => liveEl(id),
  sync: (l, m) => markOriginals(l, m),
  adopt: (l, m) => { markOriginals(l, m); markRoots(l, true); },
  refresh: l => refreshRoots(l),
};
function applyOp(op, redo) { return Ops.applyOp(S, op, redo, LIVE); }
function applyMove(op, redo) { return Ops.applyMove(op, redo, LIVE); }
// Restore the model from before the failed step and rebuild the preview from it. History has
// to go: its ops point at live nodes of the preview being replaced.
async function recoverFailedStep(modelBefore, wasDirty, err) {
  console.error('HtmlDeck: undo/redo step failed', err);
  if (modelBefore) S.model = modelBefore;
  // Shown once the rebuilt preview is up, after (not under) its own "opened" toast.
  S.afterReady = () => toast(t('history_step_failed'), { err: true, ms: 8000 });
  await rerender({ force: true, dirty: wasDirty });
}
const COMPOUND_OPS = new Set(['batch', 'move', 'insert', 'remove']);
function undo() { stepHistory(false); }
function redo() { stepHistory(true); }
function stepHistory(forward) {
  if (!S.model) return;
  stopFxPreview();
  if (S.readOnly) { lockedHint(S.readOnly); return; }
  const wasEditing = S.editing;
  flushPending();
  // The request in flight carries a snapshot; recovering under it would lose track of the save.
  if (S.saving) { toast(t('history_wait_save')); return; }
  const wasDirty = isDirty();
  const next = forward ? S.redo[S.redo.length - 1] : S.undo[S.undo.length - 1];
  // A compound step that throws half way (one sub-op applied, the next failing) would leave model
  // and preview disagreeing: keep the model from before it to fall back on. Single html/style/
  // attrs ops change one node and need no copy (the copy is linear in the document size).
  const before = next && COMPOUND_OPS.has(next.type) ? S.model.cloneNode(true) : null;
  // A single op changes one model element; a copy of just that element is enough to undo it.
  const single = next && !before ? modelEl(next.id) : null, singleCopy = single?.cloneNode(true);
  const op = History.takeStep(S, forward);
  if (!op) { updateChrome(); return; }
  deselect();
  let target;
  try {
    if (S.faultNextStep === 'step' && op.type === 'batch') {
      S.faultNextStep = null;
      applyOp((forward ? op.ops : [...op.ops].reverse())[0], forward);
      throw new Error('injected fault after the first sub-op');
    }
    if (S.faultNextStep === 'single' && op.type === 'html') {
      S.faultNextStep = null;
      modelEl(op.id).innerHTML = forward ? op.after : op.before;  // model written, live not
      throw new Error('injected fault after the model write');
    }
    target = applyOp(op, forward);
  } catch (e) {
    if (single && singleCopy && single.isConnected) single.replaceWith(singleCopy);
    recoverFailedStep(before, wasDirty, e);
    return;
  }
  History.finishStep(S, op, forward);
  if (target && target.isConnected) {
    const slideIdx = S.slides.indexOf(target.closest('[data-ed-slide]'));
    if (slideIdx >= 0 && slideIdx !== S.cur) showSlide(slideIdx);
    select(target, { edit: wasEditing && op.type === 'html' });
    if (S.editing) placeCaretEnd(target);
    queueThumb(target);
  } else {
    queueThumb(S.slides[S.cur]);
  }
  if (!el.notes.hidden) loadNotes();
  renderBoxPanel();
  buildOutline();
  renderPins();
  if (layersVisible()) buildLayers();
  updateChrome();
  afterChange();
}

// ================================================================ element actions
function deleteSel() {
  const node = S.sel;
  if (!node || commandBlocked(node)) return;
  const m = modelEl(node.dataset.edId);
  deselect();
  if (!m) return;
  const op = { type: 'remove', label: 'Xoá', ...nodeRefs(m, node) };
  doRemove(op);
  pushOp(op);
  queueThumb(S.slides[S.cur]);
  buildOutline();
  if (layersVisible()) buildLayers();
  toast('Đã xoá · Ctrl+Z để hoàn tác');
}
function duplicateSel() {
  const node = S.sel;
  if (!node || commandBlocked(node, 'duplicate')) return;
  setEditing(false);
  const m = modelEl(node.dataset.edId);
  if (!m) return;
  const mc = m.cloneNode(true);
  reId(mc);
  const pos = S.win.getComputedStyle(node).position;
  if (pos === 'absolute' || pos === 'fixed') {
    const [tx, ty] = parseTranslate(mc.style.translate);
    mc.style.setProperty('translate', `${tx + 24}px ${ty + 24}px`);
  }
  m.parentNode.insertBefore(mc, m.nextSibling);
  const lc = S.doc.importNode(mc, true);
  node.parentNode.insertBefore(lc, node.nextSibling);
  markOriginals(lc, mc);
  markRoots(lc, true);
  pushOp({ type: 'insert', label: 'Nhân bản', ...nodeRefs(mc, lc) });
  select(lc, { edit: false });
  queueThumb(lc);
  buildOutline();
  if (layersVisible()) buildLayers();
}
function insertText(kind) {
  if (!S.doc) return toast('Mở một tài liệu trước');
  if (S.readOnly) return lockedHint(S.readOnly);
  const p = PRESETS[kind];
  const css = { ...p.css };
  let lParent, lRef = null, mParent, mRef = null;
  if (S.mode === 'deck') {
    lParent = S.slides[S.cur];
    Object.assign(css, { position: 'absolute', left: '120px', top: p.top + 'px', margin: '0', 'z-index': '20', 'max-width': '1040px' });
  } else {
    let anchor = S.sel || rootNearViewportCenter();
    while (anchor && anchor.parentElement && NO_BLOCK_PARENT.has(anchor.parentElement.localName) && isOriginal(anchor.parentElement)) anchor = anchor.parentElement;
    if (!anchor || !anchor.parentElement || !isOriginal(anchor.parentElement)) return toast('Chọn một khối chữ để chèn sau nó');
    lParent = anchor.parentElement;
    lRef = anchor.nextSibling;
    mRef = modelEl(anchor.dataset.edId)?.nextSibling || null;
    css.margin = '12px 0';
  }
  mParent = modelEl(lParent.dataset.edId);
  if (!mParent) return;
  deselect();
  const m = S.model.createElement(p.tag);
  m.setAttribute('data-ed-id', String(S.nextId++));
  for (const [k, v] of Object.entries(css)) m.style.setProperty(k, v);
  m.textContent = t('preset_' + kind, p.text);
  mParent.insertBefore(m, mRef);
  const l = S.doc.importNode(m, true);
  lParent.insertBefore(l, lRef && lRef.parentNode === lParent ? lRef : null);
  markOriginals(l, m);
  markRoots(l, true);
  pushOp({ type: 'insert', label: 'Thêm chữ', ...nodeRefs(m, l) });
  if (S.mode === 'page') l.scrollIntoView({ block: 'center' });
  select(l, { edit: true });
  selectAllIn(l);
  queueThumb(l);
  buildOutline();
}
function rootNearViewportCenter() {
  const mid = S.win.innerHeight / 2;
  let best = null, bestD = Infinity;
  for (const node of S.liveById.values()) {
    if (!node.isConnected) continue;
    const r = node.getBoundingClientRect();
    if (!r.height) continue;
    const d = Math.abs(r.top + r.height / 2 - mid);
    if (d < bestD) { best = node; bestD = d; }
  }
  return best;
}
function selectParent() {
  if (!S.sel) return;
  const parent = pickBlock(S.sel.parentElement || S.sel);
  if (parent) select(parent, { edit: false }); else toast('Đã ở khối ngoài cùng');
}
function copyStyle() {
  if (!S.sel) return;
  S.styleClip = modelEl(S.sel.dataset.edId)?.getAttribute('style') || '';
  toast('Đã sao chép kiểu');
}
function pasteStyle() {
  if (!S.sel || S.styleClip == null) return toast('Chưa sao chép kiểu nào');
  if (commandBlocked(S.sel)) return;
  const node = S.sel, m = modelEl(node.dataset.edId);
  if (!m) return;
  commitText();
  const before = m.getAttribute('style'), after = S.styleClip || null;
  if (before === after) return;
  setStyleAttr(m, after); setStyleAttr(node, after);
  pushOp({ type: 'style', id: node.dataset.edId, before, after, label: 'Dán kiểu' });
  queueThumb(node);
  refreshToolbar();
}
function clearStyle() {
  if (!S.sel || commandBlocked(S.sel)) return;
  const node = S.sel, m = modelEl(node.dataset.edId);
  if (!m) return;
  const orig = m.getAttribute('style');
  if (orig == null) return toast('Khối này không có định dạng inline');
  commitText();
  setStyleAttr(m, null); setStyleAttr(node, null);
  pushOp({ type: 'style', id: node.dataset.edId, before: orig, after: null, label: 'Xoá định dạng' });
  queueThumb(node);
  refreshToolbar();
}

// ================================================================ formatting
function focusSel() {
  if (S.sel && S.doc.activeElement !== S.sel) S.sel.focus({ preventScroll: true });
}
function restoreRange() {
  const r = S.savedRange;
  if (!r || !S.sel || !S.sel.contains(r.commonAncestorContainer)) return;
  const sel = S.win.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
function hasTextSelection() {
  if (!S.editing || !S.sel) return false;
  const sel = S.win.getSelection();
  let r = sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!r || r.collapsed || !S.sel.contains(r.commonAncestorContainer)) r = S.savedRange;
  return !!(r && !r.collapsed && S.sel.contains(r.commonAncestorContainer));
}
function execOnSelection(cmd) {
  focusSel();
  restoreRange();
  S.doc.execCommand('styleWithCSS', false, false);
  S.doc.execCommand(cmd, false, null);
  S.textDirty = true;  // claimed by the trusted input event execCommand fires
  scheduleCommit();
  refreshToolbar();
}
// Wrap the selected text in a span carrying one CSS property. Repeated calls on the same
// selection (slider/colour drags) update that span instead of nesting new ones.
function wrapSelection(prop, value) {
  focusSel();
  restoreRange();
  const sel = S.win.getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const w = S.lastWrap;
  if (w && w.isConnected && r.startContainer === w && r.startOffset === 0 && r.endContainer === w && r.endOffset === w.childNodes.length) {
    w.style.setProperty(prop, value);
  } else {
    const span = S.doc.createElement('span');
    span.style.setProperty(prop, value);
    span.appendChild(r.extractContents());
    r.insertNode(span);
    S.lastWrap = span;
  }
  if (needsImportant(S.lastWrap, prop)) S.lastWrap.style.setProperty(prop, value, 'important');
  const nr = S.doc.createRange();
  nr.selectNodeContents(S.lastWrap);
  sel.removeAllRanges();
  sel.addRange(nr);
  S.savedRange = nr.cloneRange();
  markTextDirty();
  scheduleCommit();
  updateChrome();
}
function computedFor(node) {
  let probe = node;
  if (S.editing) {
    const sel = S.win.getSelection();
    if (sel.rangeCount) {
      let n = sel.getRangeAt(0).startContainer;
      if (n.nodeType === 3) n = n.parentElement;
      if (n && node.contains(n)) probe = n;
    }
  }
  return S.win.getComputedStyle(probe);
}
function toggleStyle(cmd) {
  if (!S.sel) return;
  if (hasTextSelection()) return execOnSelection(cmd);
  const cs = S.win.getComputedStyle(S.sel);
  const deco = new Set(cs.textDecorationLine.split(' ').filter(v => v !== 'none'));
  if (cmd === 'bold') styleEdit(S.sel, { 'font-weight': parseInt(cs.fontWeight, 10) >= 600 ? '400' : '700' });
  else if (cmd === 'italic') styleEdit(S.sel, { 'font-style': cs.fontStyle === 'italic' ? 'normal' : 'italic' });
  else {
    const v = cmd === 'underline' ? 'underline' : 'line-through';
    deco.has(v) ? deco.delete(v) : deco.add(v);
    styleEdit(S.sel, { 'text-decoration-line': deco.size ? [...deco].join(' ') : 'none' });
  }
  refreshToolbar();
}
function setFontSize(px) {
  if (!S.sel || !(px > 0)) return;
  px = clamp(Math.round(px * 10) / 10, 4, 800);
  if (hasTextSelection()) wrapSelection('font-size', px + 'px');
  else styleEdit(S.sel, { 'font-size': px + 'px' }, 'size');
  refreshToolbar();
}
function applyColor(hex) {
  if (!S.sel) return toast('Chọn một khối chữ trước');
  if (S.colorTarget === 'bg') styleEdit(S.sel, { 'background-color': hex }, 'bg');
  else if (hasTextSelection()) wrapSelection('color', hex);
  else { styleEdit(S.sel, { color: hex }, 'color'); offerChildColor(S.sel, hex); }
  refreshToolbar();
}
// Text inside the block that keeps its own colour (a class on a child) does not follow the
// block's new colour. Say so, and offer to apply it to those children as one undo step.
function offerChildColor(node, hex) {
  if (!node?.isConnected) return;
  const want = S.win.getComputedStyle(node).color;
  const kids = $$('*', node).filter(e => isOriginal(e) && hasDirectText(e) && S.win.getComputedStyle(e).color !== want);
  if (!kids.length) return;
  toast(t('color_kids').replace('{n}', kids.length), { ms: 6000, action: { label: t('color_kids_apply'), fn: () => {
    commitText();
    const ops = kids.filter(k => k.isConnected).map(k => buildStyleOp(k, { color: hex })).filter(Boolean);
    if (!ops.length) return;
    pushOp(ops.length === 1 ? ops[0] : { type: 'batch', ops, label: t('color_kids_apply') });
    queueThumb(node);
  } } });
}
function applyFont(name) {
  const f = FONTS.find(x => x[0] === name);
  if (!S.sel || !f) return;
  ensureFontLink(f);
  const family = `'${f[0]}', ${f[1]}`;
  if (hasTextSelection()) wrapSelection('font-family', family);
  else styleEdit(S.sel, { 'font-family': family });
  refreshToolbar();
}
// Google fonts are linked into the model too, so the saved file renders the chosen face.
function ensureFontLink([name, , weights]) {
  if (!weights) return;
  const family = name.replace(/ /g, '+');
  const has = d => $$('link[href*="fonts.googleapis.com"]', d).some(l => l.getAttribute('href').includes('family=' + family + ':') || l.getAttribute('href').includes('family=' + family + '&'));
  if (has(S.model)) return;
  const link = S.model.createElement('link');
  link.setAttribute('rel', 'stylesheet');
  link.setAttribute('href', `https://fonts.googleapis.com/css2?family=${family}:wght@${weights}&display=swap`);
  link.setAttribute('data-ed-id', String(S.nextId++));
  S.model.head.appendChild(link);
  S.touched.add(S.model.head.getAttribute('data-ed-id'));
  S.doc.head.appendChild(S.doc.importNode(link, true));
}
function cycleAlign() {
  if (!S.sel) return;
  const order = ['left', 'center', 'right', 'justify'];
  let cur = S.win.getComputedStyle(S.sel).textAlign;
  cur = cur === 'start' ? 'left' : cur === 'end' ? 'right' : cur;
  styleEdit(S.sel, { 'text-align': order[(order.indexOf(cur) + 1) % order.length] });
  refreshToolbar();
}
function toggleCase() {
  if (!S.sel) return;
  const up = S.win.getComputedStyle(S.sel).textTransform === 'uppercase';
  styleEdit(S.sel, { 'text-transform': up ? 'none' : 'uppercase' });
  refreshToolbar();
}

// ================================================================ links
function activeRange() {
  if (!S.editing || !S.sel) return null;
  const sel = S.win.getSelection();
  const r = sel.rangeCount ? sel.getRangeAt(0) : null;
  if (r && S.sel.contains(r.commonAncestorContainer)) return r;
  return S.savedRange && S.sel.contains(S.savedRange.commonAncestorContainer) ? S.savedRange : null;
}
// Where a link edit applies: a link inside the text being edited (html change), a link that
// is the selected block itself or wraps it (attribute change), or a new link on the selection.
function linkContext() {
  const node = S.sel;
  if (!node) return null;
  const outer = node.localName === 'a' ? node : node.parentElement?.closest('a');
  if (outer && isOriginal(outer)) return { kind: 'attr', a: outer };
  const r = activeRange();
  if (r) {
    let n = r.commonAncestorContainer;
    if (n.nodeType === 3) n = n.parentElement;
    const inner = n.closest('a');
    if (inner && node.contains(inner)) return { kind: 'inner', a: inner };
    if (!r.collapsed) return { kind: 'new', range: r.cloneRange() };
  }
  return null;
}
function normalizeURL(raw) {
  // URL parsers drop ASCII tab/newline anywhere and control chars/spaces at the start, so
  // `java\tscript:` is still javascript:. Strip them before checking the scheme.
  const v = raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '').trim();
  if (!v) return '';
  if (/^(javascript|vbscript|data):/i.test(v.replace(/[\u0000-\u001f\u007f-\u009f\s]/g, ''))) return null;
  if (/^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(v)) return v;
  if (/^[^\s/@]+@[^\s/@]+\.[a-z]{2,}$/i.test(v)) return 'mailto:' + v;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return 'https://' + v;
  return v;
}
function openLinkPop() {
  if (!S.sel) return toast('Chọn chữ trước');
  const ctx = linkContext();
  if (!ctx) return toast(S.editing ? 'Bôi đen phần chữ cần gắn liên kết' : 'Nhấp vào chữ rồi bôi đen phần cần gắn liên kết');
  S.linkCtx = ctx;
  closePopups();
  const a = ctx.a;
  $('#link-url').value = a ? a.getAttribute('href') || '' : '';
  $('#link-blank').checked = a ? a.getAttribute('target') === '_blank' : false;
  $('#link-mode').textContent = ctx.kind === 'new' ? t('link_mode_new') : t('link_mode_existing');
  $('#link-remove').hidden = ctx.kind === 'new';
  const b = $('#tb-link').getBoundingClientRect(), st = el.stage.getBoundingClientRect();
  const pop = $('#pop-link');
  pop.style.left = clamp(b.left - st.left + b.width / 2 - 170, 8, st.width - 350) + 'px';
  pop.hidden = false;
  setTimeout(() => { $('#link-url').focus(); $('#link-url').select(); }, 20);
}
function setLinkAttrs(a, href, blank) {
  a.setAttribute('href', href);
  if (blank) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); }
  else if (a.getAttribute('target') === '_blank') { a.removeAttribute('target'); if (a.getAttribute('rel') === 'noopener noreferrer') a.removeAttribute('rel'); }
}
// Apply attribute changes to model + live and return the op (not pushed), or null.
function buildAttrsOp(node, changes, label) {
  if (commandBlocked(node)) return null;
  const id = node.dataset.edId, m = modelEl(id);
  if (!m) return null;
  const before = {}, after = {};
  for (const [name, value] of Object.entries(changes)) {
    const cur = m.getAttribute(name);
    if (cur === value) continue;
    before[name] = cur;
    after[name] = value;
  }
  if (!Object.keys(after).length) return null;
  setAttrs(m, after);
  setAttrs(node, after);
  claimOwn();
  return { type: 'attrs', id, before, after, label };
}
// Several attributes of one element as a single undo step.
function attrsEdit(node, changes, label) {
  const op = buildAttrsOp(node, changes, label);
  if (op) pushOp(op);
}
function applyLink() {
  const ctx = S.linkCtx;
  const href = normalizeURL($('#link-url').value), blank = $('#link-blank').checked;
  if (href === null) return toast('Liên kết javascript:/data: không được phép', { err: true });
  if (!href) { if (ctx && ctx.kind !== 'new') removeLink(); else toast('Nhập địa chỉ liên kết'); return; }
  $('#pop-link').hidden = true;
  if (!ctx || !S.sel) return;
  if (ctx.kind === 'attr') {
    commitText();
    const a = ctx.a, changes = { href };
    if (blank) Object.assign(changes, { target: '_blank', rel: 'noopener noreferrer' });
    else if (a.getAttribute('target') === '_blank') Object.assign(changes, { target: null, rel: a.getAttribute('rel') === 'noopener noreferrer' ? null : a.getAttribute('rel') });
    attrsEdit(a, changes, 'Liên kết');
  } else if (ctx.kind === 'inner') {
    setLinkAttrs(ctx.a, href, blank);
    markTextDirty();
    commitText();
  } else {
    focusSel();
    const sel = S.win.getSelection();
    sel.removeAllRanges();
    sel.addRange(ctx.range);
    const a = S.doc.createElement('a');
    setLinkAttrs(a, href, blank);
    a.appendChild(ctx.range.extractContents());
    ctx.range.insertNode(a);
    for (const nested of $$('a', a)) nested.replaceWith(...nested.childNodes);
    const nr = S.doc.createRange();
    nr.selectNodeContents(a);
    sel.removeAllRanges();
    sel.addRange(nr);
    S.savedRange = nr.cloneRange();
    markTextDirty();
    commitText();
  }
  queueThumb(S.sel);
  toast('Đã gắn liên kết');
}
function removeLink() {
  const ctx = S.linkCtx;
  $('#pop-link').hidden = true;
  if (!ctx || ctx.kind === 'new' || !ctx.a.isConnected) return;
  if (ctx.kind === 'attr') {
    // The link is a whole block: keep the element (and its layout), drop what makes it a link.
    commitText();
    attrsEdit(ctx.a, { href: null, target: null, rel: null }, 'Gỡ liên kết');
    toast('Đã gỡ liên kết');
    return;
  }
  ctx.a.replaceWith(...ctx.a.childNodes);
  markTextDirty();
  commitText();
  queueThumb(S.sel);
  toast('Đã gỡ liên kết');
}

// ================================================================ frame panel (Khung)
// Friendly controls over inline CSS: presets and sliders, never raw px fields. A block's size
// is changed with the handles on the page; this panel only offers "back to the original size".
const BOX_GROUPS = {
  size: ['width', 'height', 'max-width', 'min-width', 'min-height', 'max-height'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-bottom'],
  bg: ['background-color', 'background'],
  border: ['border-width', 'border-style', 'border-color'],
  radius: ['border-radius'],
  shadow: ['box-shadow'],
};
const SHADOWS = {
  none: 'none',
  soft: '0 1px 3px rgba(14,14,17,.12), 0 1px 2px rgba(14,14,17,.06)',
  medium: '0 6px 18px -2px rgba(14,14,17,.16), 0 2px 6px rgba(14,14,17,.06)',
  strong: '0 20px 44px -8px rgba(14,14,17,.26), 0 6px 12px rgba(14,14,17,.08)',
};
const BOX_PRESETS = {
  padding: [['chip_none', 0], ['chip_tight', 8], ['chip_medium', 16], ['chip_wide', 32]],
  margin: [['chip_none', 0], ['chip_small', 8], ['chip_medium', 16], ['chip_large', 32]],
  radius: [['chip_none', 0], ['chip_subtle', 6], ['chip_medium', 12], ['chip_large', 24], ['chip_round', 999]],
  bw: [['chip_thin', 1], ['chip_medium', 2], ['chip_thick', 4]],
};
const BORDER_STYLES = [['none', 'bstyle_none'], ['solid', 'bstyle_solid'], ['dashed', 'bstyle_dashed'], ['dotted', 'bstyle_dotted']];
const BORDER_COLORS = ['#dcdce2', '#8a8a94', '#0e0e11', '#ff5a1f', '#e94209', '#2e8a36', '#0072e0', '#8e4ec6'];
const BG_COLORS = ['#ffffff', '#fbfbfc', '#f4f4f6', '#e9e9ed', '#0e0e11', '#ff5a1f', '#ffe0d3', '#fff1ea', '#ffe7be', '#d1edcf', '#cee5fe', '#f5eeff'];
const SIDE_NAMES = { top: 'side_top', right: 'side_right', bottom: 'side_bottom', left: 'side_left' };
function boxVisible() { return el.panel.classList.contains('open') && el.panel.dataset.view === 'box'; }
const pxOf = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
// Text an end user recognises a block by: its own words, else the first words inside it.
function contentSnippet(n) {
  if (n.localName === 'img') return n.getAttribute('alt') || '';
  let t = directText(n);
  if (!t) {
    const w = n.ownerDocument.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    for (let i = 0, c = w.nextNode(); c && i < 80; i++, c = w.nextNode()) {
      const v = c.nodeValue.slice(0, 200).replace(/\s+/g, ' ').trim();
      if (v && !c.parentElement.closest('script,style,svg')) { t = v; break; }
    }
  }
  return t.slice(0, 44);
}
function nodeLabel(n) {
  const text = contentSnippet(n);
  return (getLayerName(n.localName) || n.localName) + (text ? ': ' + text : '');
}
function inlineValue(node, prop, m = modelEl(node.dataset.edId)) {
  return m ? m.style.getPropertyValue(prop) : '';
}
function frameStyle(props, key) {
  if (!S.sel) return;
  styleEdit(S.sel, props, key);
  renderBoxPanel();
}
function setSpacing(kind, value, side) {
  const sides = side ? [side] : kind === 'padding' ? ['top', 'right', 'bottom', 'left'] : ['top', 'bottom'];
  const props = {};
  for (const s of sides) props[`${kind}-${s}`] = value + 'px';
  frameStyle(props, `box-${kind}${side ? '-' + side : ''}`);
}
// A border needs a style, a width and a colour to show: fill in whichever the user did not pick.
function setBorder(changes) {
  const cs = S.win.getComputedStyle(S.sel), props = { ...changes };
  const style = props['border-style'] ?? cs.borderTopStyle;
  if (style === 'none' && !props['border-style']) props['border-style'] = 'solid';
  if (props['border-style'] !== 'none' && !props['border-width'] && pxOf(cs.borderTopWidth) === 0) props['border-width'] = '1px';
  if (props['border-style'] !== 'none' && !props['border-color'] && !inlineValue(S.sel, 'border-color') && pxOf(cs.borderTopWidth) === 0) props['border-color'] = '#dcdce2';
  frameStyle(props, 'box-border');
}
// "Reset" means back to what the file itself had inline (keeping !important), not "remove all".
function resetBoxGroup(group) {
  const node = S.sel;
  if (!node) return;
  const orig = S.pristine.querySelector(`[data-ed-id="${node.dataset.edId}"]`);
  const names = [...BOX_GROUPS[group]];
  if (group === 'border') names.push('border', 'border-top', 'border-right', 'border-bottom', 'border-left');
  if (group === 'bg') names.push('background-image');
  if (group === 'margin') names.push('margin-left', 'margin-right');
  const props = {};
  for (const p of names) {
    const v = orig ? orig.style.getPropertyValue(p) : '';
    props[p] = v ? v + (orig.style.getPropertyPriority(p) ? ' !important' : '') : null;
  }
  styleEdit(node, props);
  renderBoxPanel();
}
function renderBoxPanel() {
  if (!boxVisible() || renderBoxPanel.raf) return;
  renderBoxPanel.raf = requestAnimationFrame(() => { renderBoxPanel.raf = 0; drawBoxPanel(); });
}
function markChips(box, current, tol = 0.6) {
  for (const b of $$('button', box)) b.classList.toggle('on', current != null && Math.abs(Number(b.dataset.v) - current) <= tol);
}
function drawBoxPanel() {
  if (!boxVisible()) return;
  const node = S.sel, body = $('.panel-body[data-view="box"]');
  body.classList.toggle('disabled-img', !node);
  $('#box-target').textContent = node ? nodeLabel(node) : t('box_target_empty');
  if (!node) return;
  const cs = S.win.getComputedStyle(node), m = modelEl(node.dataset.edId), isImg = node.localName === 'img';
  $$('[data-noimg]', body).forEach(s => { s.hidden = isImg; });
  const pads = ['top', 'right', 'bottom', 'left'].map(s => pxOf(cs.getPropertyValue('padding-' + s)));
  const uniform = pads.every(v => Math.abs(v - pads[0]) < 0.6) ? pads[0] : null;
  markChips($('#chips-padding'), uniform);
  $('#sl-padding').value = Math.round(uniform ?? pads[0]);
  $('#out-padding').textContent = uniform == null ? t('val_mixed') : Math.round(uniform);
  const mg = ['top', 'bottom'].map(s => pxOf(cs.getPropertyValue('margin-' + s)));
  markChips($('#chips-margin'), Math.abs(mg[0] - mg[1]) < 0.6 ? mg[0] : null);
  for (const r of $$('.side-row')) {
    const v = Math.round(pxOf(cs.getPropertyValue(r.dataset.prop)));
    const s = r.querySelector('input');
    if (document.activeElement !== s) s.value = v;
    r.querySelector('output').textContent = v;
  }
  const sides = ['Top', 'Right', 'Bottom', 'Left'];
  const same = vals => vals.every(v => v === vals[0]);
  const styles = sides.map(k => pxOf(cs['border' + k + 'Width']) === 0 ? 'none' : cs['border' + k + 'Style']);
  const widths = sides.map(k => pxOf(cs['border' + k + 'Width']));
  const bstyle = same(styles) ? styles[0] : null, bw = widths[0];
  for (const b of $$('#chips-bstyle button')) b.classList.toggle('on', bstyle === b.dataset.v);
  markChips($('#chips-bw'), bstyle && bstyle !== 'none' && same(widths) ? bw : null);
  const bc = rgbToHex(cs.borderTopColor);
  for (const b of $$('#box-bc-swatches .swatch[data-hex]')) b.classList.toggle('on', bw > 0 && b.dataset.hex === bc);
  const radii = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(k => pxOf(cs['border' + k + 'Radius']));
  const rad = same(radii) ? radii[0] : null;
  markChips($('#chips-radius'), rad == null ? null : rad >= 999 ? 999 : rad);
  $('#sl-radius').value = Math.min(60, Math.round(rad ?? radii[0]));
  $('#out-radius').textContent = rad == null ? t('val_mixed') : rad >= 999 ? t('val_round') : Math.round(rad);
  const bg = rgbToHex(cs.backgroundColor);
  for (const b of $$('#box-bg-swatches .swatch[data-hex]')) b.classList.toggle('on', b.dataset.hex === bg);
  $('#box-bg-swatches .swatch.none')?.classList.toggle('on', !bg && cs.backgroundImage === 'none');
  const sh = inlineValue(node, 'box-shadow', m);
  for (const b of $$('[data-shadow]')) b.classList.toggle('on', sh ? normalizeCSS('box-shadow', SHADOWS[b.dataset.shadow]) === sh : b.dataset.shadow === 'none' && cs.boxShadow === 'none');
}
// The browser rewrites values it stores (colour order, rgba…); compare like with like.
function normalizeCSS(prop, value) {
  const d = document.createElement('div');
  d.style.setProperty(prop, value);
  return d.style.getPropertyValue(prop);
}
function chipButtons(box, items, onPick) {
  for (const [key, v] of items) {
    const b = document.createElement('button');
    b.textContent = t(key);
    b.dataset.i18n = key;
    b.dataset.v = v;
    b.addEventListener('click', () => onPick(v));
    box.appendChild(b);
  }
}
function swatchButtons(box, colors, onPick, withNone) {
  if (withNone) {
    const n = document.createElement('button');
    n.className = 'swatch none';
    n.title = t('box_bg_none');
    n.dataset.i18nTitle = 'box_bg_none';
    n.addEventListener('click', () => onPick(null));
    box.appendChild(n);
  }
  for (const hex of colors) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = hex;
    b.title = hex;
    b.dataset.hex = hex;
    b.addEventListener('click', () => onPick(hex));
    box.appendChild(b);
  }
  const c = document.createElement('label');
  c.className = 'swatch custom';
  c.title = t('color_custom');
  c.dataset.i18nTitle = 'color_custom';
  c.innerHTML = '<input type="color">';
  c.querySelector('input').addEventListener('input', e => onPick(e.target.value));
  box.appendChild(c);
}
function bindBoxPanel() {
  const body = $('.panel-body[data-view="box"]');
  chipButtons($('#chips-padding'), BOX_PRESETS.padding, v => setSpacing('padding', v));
  chipButtons($('#chips-margin'), BOX_PRESETS.margin, v => setSpacing('margin', v));
  chipButtons($('#chips-radius'), BOX_PRESETS.radius, v => frameStyle({ 'border-radius': v + 'px' }, 'box-radius'));
  chipButtons($('#chips-bw'), BOX_PRESETS.bw, v => setBorder({ 'border-width': v + 'px' }));
  for (const [v, key] of BORDER_STYLES) {
    const b = document.createElement('button');
    b.textContent = t(key);
    b.dataset.i18n = key;
    b.dataset.v = v;
    b.addEventListener('click', () => v === 'none' ? frameStyle({ 'border-style': 'none' }, 'box-border') : setBorder({ 'border-style': v }));
    $('#chips-bstyle').appendChild(b);
  }
  swatchButtons($('#box-bc-swatches'), BORDER_COLORS, hex => setBorder({ 'border-color': hex }));
  // Transparent with !important so a background the file forces really goes away.
  swatchButtons($('#box-bg-swatches'), BG_COLORS, hex => hex
    ? frameStyle({ 'background-color': hex }, 'box-bg')
    : frameStyle({ 'background-color': 'transparent !important', 'background-image': 'none !important' }, 'box-bg'), true);
  $('#sl-padding').addEventListener('input', e => { $('#out-padding').textContent = e.target.value; setSpacing('padding', +e.target.value); });
  $('#sl-radius').addEventListener('input', e => { $('#out-radius').textContent = e.target.value; frameStyle({ 'border-radius': e.target.value + 'px' }, 'box-radius'); });
  for (const [kind, sides] of [['padding', ['top', 'right', 'bottom', 'left']], ['margin', ['top', 'bottom']]]) {
    const box = $('#sides-' + kind);
    for (const s of sides) {
      const row = document.createElement('div');
      row.className = 'side-row';
      row.dataset.prop = `${kind}-${s}`;
      row.innerHTML = `<span data-i18n="${SIDE_NAMES[s]}">${t(SIDE_NAMES[s])}</span><input type="range" min="0" max="${kind === 'padding' ? 80 : 120}"><output></output>`;
      row.querySelector('input').addEventListener('input', e => { row.querySelector('output').textContent = e.target.value; setSpacing(kind, +e.target.value, s); });
      box.appendChild(row);
    }
  }
  for (const b of $$('[data-reset]', body)) b.addEventListener('click', () => resetBoxGroup(b.dataset.reset));
  for (const sec of [$('#chips-padding'), $('#chips-margin')].map(n => n.closest('.box-sec'))) {
    const hover = on => () => { S.spacingHover = on; refreshOffsets(); };
    sec.addEventListener('pointerenter', hover(true));
    sec.addEventListener('pointerleave', hover(false));
    sec.addEventListener('focusin', hover(true));
    sec.addEventListener('focusout', hover(false));
    // A held slider keeps the bands even when the pointer drifts out of the section.
    sec.addEventListener('pointerdown', e => {
      if (e.target.type !== 'range') return;
      S.spacingDrag = true;
      window.addEventListener('pointerup', () => { S.spacingDrag = false; refreshOffsets(); }, { once: true });
    });
  }
  for (const b of $$('[data-shadow]', body)) b.addEventListener('click', () => frameStyle({ 'box-shadow': SHADOWS[b.dataset.shadow] }, 'box-shadow'));
}

// ================================================================ images
const IMG_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif']);
const IMG_MAX_BYTES = 1_000_000, IMG_MAX_EDGE = 2560, IMG_HARD_LIMIT = 4 * 1048576;
function selectedImg() { return S.sel && S.sel.localName === 'img' ? S.sel : null; }
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Không tải được ảnh'));
    im.src = src;
  });
}
const readDataURL = file => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});
const dataURLBytes = u => Math.round((u.length - u.indexOf(',') - 1) * 3 / 4);
// Embed a picked file as a data URL; big raster images are re-encoded so the page stays shareable.
async function fileToDataURL(file) {
  if (!IMG_TYPES.has(file.type)) throw new Error('Chỉ nhận ảnh PNG, JPG, WebP, GIF, SVG, AVIF');
  if ((file.type === 'image/svg+xml' || file.type === 'image/gif') && file.size > IMG_HARD_LIMIT)
    throw new Error(`${file.type === 'image/gif' ? 'GIF' : 'SVG'} nặng ${fmtSize(file.size)} — tối đa ${fmtSize(IMG_HARD_LIMIT)}, hãy nén trước`);
  const raw = await readDataURL(file);
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') return raw;
  const im = await loadImage(raw);
  const edge = Math.max(im.naturalWidth, im.naturalHeight);
  if (file.size <= IMG_MAX_BYTES && edge <= IMG_MAX_EDGE) return raw;
  // Lower quality first, then size, until the embedded image is at most ~1.5 MB.
  const encode = (k, q) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(im.naturalWidth * k));
    c.height = Math.max(1, Math.round(im.naturalHeight * k));
    const ctx = c.getContext('2d');
    ctx.drawImage(im, 0, 0, c.width, c.height);
    const webp = c.toDataURL('image/webp', q);
    if (webp.startsWith('data:image/webp')) return webp;
    // No WebP encoder (older Safari): JPEG has no alpha, so flatten onto white first.
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  };
  let k = Math.min(1, IMG_MAX_EDGE / edge), out = raw;
  for (let step = 0; step < 8; step++) {
    const q = step < 3 ? [0.86, 0.75, 0.62][step] : 0.62;
    if (step >= 3) k *= 0.8;
    const next = encode(k, q);
    if (next.length < out.length) out = next;
    if (dataURLBytes(out) <= IMG_MAX_BYTES * 1.5) break;
  }
  if (dataURLBytes(out) > IMG_HARD_LIMIT) throw new Error('Ảnh vẫn quá nặng sau khi nén — hãy giảm kích thước trước');
  return out;
}
function normalizeImageURL(raw) {
  const v = raw.replace(/[\t\n\r]/g, '').trim();
  if (!v) return '';
  const probe = v.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  if (probe.startsWith('javascript:') || probe.startsWith('vbscript:')) return null;
  if (probe.startsWith('data:') && !probe.startsWith('data:image/')) return null;
  return v;
}
// Swap an image's source as one undo step. If the new picture has another aspect ratio and
// the box does not follow it, crop to fill (object-fit: cover) instead of stretching.
async function replaceImage(node, src) {
  if (!node || !node.isConnected) return toast('Chọn một ảnh trên trang trước');
  const token = S.loadToken;
  let probe;
  // Resolve like the <img> will: against the document's own base (it may have a <base href>).
  try { probe = await loadImage(new URL(src, S.doc.baseURI).href); }
  catch (e) { toast(e.message, { err: true }); return; }
  if (token !== S.loadToken || !node.isConnected || selectedImg() !== node) return;
  commitText();
  const ops = [];
  const main = buildAttrsOp(node, { src, srcset: null, sizes: null }, 'Thay ảnh');
  if (main) ops.push(main);
  const pic = node.parentElement?.localName === 'picture' ? node.parentElement : null;
  if (pic) for (const srcEl of $$('source[srcset]', pic)) {
    if (isOriginal(srcEl)) { const o = buildAttrsOp(srcEl, { srcset: null }, 'Thay ảnh'); if (o) ops.push(o); }
    else srcEl.removeAttribute('srcset');   // added by the page's script: preview only, never saved
  }
  if (!ops.length) return toast('Ảnh này đang được dùng rồi');
  // Record the step now, so a save or undo while the picture decodes already includes it.
  const batch = { type: 'batch', ops, label: 'Thay ảnh' };
  pushOp(batch);
  try { await node.decode(); } catch { /* the box is still measurable */ }
  if (token !== S.loadToken || S.undo[S.undo.length - 1] !== batch) return;
  const r = node.getBoundingClientRect(), fit = S.win.getComputedStyle(node).objectFit;
  const boxAR = r.width / r.height, newAR = probe.naturalWidth / probe.naturalHeight;
  if (r.width && r.height && fit === 'fill' && !node.style.objectFit && Math.abs(newAR - boxAR) / boxAR > 0.02) {
    const o = buildStyleOp(node, { 'object-fit': 'cover' });
    if (o) {
      batch.ops.push(o);
      batch.seq = ++S.seq;   // changed after it may have been saved
      touchOp(o);
      updateChrome();
    }
  }
  queueThumb(node);
  refreshToolbar();
  const size = src.startsWith('data:') ? ' · nhúng ' + fmtSize(dataURLBytes(src)) : '';
  toast(`Đã thay ảnh (${probe.naturalWidth}×${probe.naturalHeight}${size})`);
}
async function replaceWithFile(node, file) {
  if (!node) return toast('Chọn một ảnh trên trang trước');
  try { await replaceImage(node, await fileToDataURL(file)); }
  catch (e) { toast(e.message, { err: true }); }
}
function openAltPop() {
  const img = selectedImg();
  if (!img) return;
  closePopups();
  $('#alt-input').value = img.getAttribute('alt') || '';
  const p = el.pill.getBoundingClientRect(), st = el.stage.getBoundingClientRect();
  const pop = $('#pop-alt');
  pop.style.left = clamp(p.left - st.left, 8, st.width - 350) + 'px';
  pop.style.top = clamp(p.bottom - st.top + 8, 60, st.height - 160) + 'px';
  pop.hidden = false;
  setTimeout(() => $('#alt-input').focus(), 20);
}
function applyAlt() {
  const img = selectedImg();
  $('#pop-alt').hidden = true;
  if (img) attrsEdit(img, { alt: $('#alt-input').value.trim() }, 'Mô tả ảnh');
}
// "Thay ảnh ▾": upload, reuse a picture already in the document, or paste a link.
function openImagePop() {
  if (!selectedImg()) return;
  const open = $('#pop-img').hidden;
  closePopups();
  if (!open) return;
  const b = $('#tb-img-replace').getBoundingClientRect(), st = el.stage.getBoundingClientRect();
  const pop = $('#pop-img');
  pop.style.left = clamp(b.left - st.left, 8, st.width - 360) + 'px';
  renderImageGrid();
  pop.hidden = false;
}
// The attribute value (relative, as written in the file) of the candidate the browser shows.
function displayedSource(n) {
  const shown = n.currentSrc, base = n.ownerDocument.baseURI;
  const cands = [n.getAttribute('src')];
  const addSet = set => { for (const part of (set || '').split(',')) { const url = part.trim().split(/\s+/)[0]; if (url) cands.push(url); } };
  addSet(n.getAttribute('srcset'));
  if (n.parentElement?.localName === 'picture') for (const src of n.parentElement.querySelectorAll('source')) addSet(src.getAttribute('srcset'));
  for (const c of cands) { try { if (c && new URL(c, base).href === shown) return c; } catch { /* malformed candidate */ } }
  return n.getAttribute('src');
}
function renderImageGrid() {
  const grid = $('#img-grid');
  const seen = new Map();
  if (S.doc) for (const n of $$('img', S.doc)) if (isOriginal(n)) { const v = displayedSource(n); if (v && !seen.has(v)) seen.set(v, n.currentSrc || n.src); }
  grid.innerHTML = seen.size ? '' : `<div class="hint" style="grid-column:1/-1">${t('no_other_imgs')}</div>`;
  for (const [value, shown] of seen) {
    const b = document.createElement('button');
    b.title = t('use_this_img');
    const im = document.createElement('img');
    im.src = shown;
    im.alt = '';
    b.appendChild(im);
    b.addEventListener('click', () => { $('#pop-img').hidden = true; replaceImage(selectedImg(), value); });
    grid.appendChild(b);
  }
}
// ---- crop & position: drag the picture inside its frame (object-fit: cover + object-position)
function enterCrop() {
  const img = selectedImg();
  if (!img) return;
  closePopups();
  if (S.editing) setEditing(false);
  if (S.win.getComputedStyle(img).objectFit !== 'cover') styleEdit(img, { 'object-fit': 'cover' });
  S.crop = { img };
  el.ctx.classList.add('crop-mode');
  el.box.classList.add('crop');
  el.pill.classList.remove('show');
}
function exitCrop() {
  if (!S.crop) return;
  S.crop.cancelDrag?.();
  S.crop = null;
  el.ctx.classList.remove('crop-mode');
  el.box.classList.remove('crop');
  if (S.sel) positionOverlay(true);
  refreshToolbar();
}
function setFit(fit) {
  const img = S.crop?.img || selectedImg();
  if (!img) return;
  styleEdit(img, { 'object-fit': fit });
  if (fit !== 'cover') exitCrop();
}
function startCropDrag(e) {
  const img = S.crop?.img;
  if (!img || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const r = img.getBoundingClientRect(), nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh || !r.width || !r.height) return;
  const k = Math.max(r.width / nw, r.height / nh);
  const over = { x: nw * k - r.width, y: nh * k - r.height };
  // object-position may be %, px or keywords; turn each axis into a 0–100 % of the overflow.
  const KW = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
  const toPct = (v, o) => v in KW ? KW[v] : v.endsWith('%') ? parseFloat(v) : v.endsWith('px') && o > 0.5 ? clamp(-parseFloat(v) / o * 100, 0, 100) : 50;
  const parts = S.win.getComputedStyle(img).objectPosition.trim().split(/\s+/);
  const start = { x: e.clientX, y: e.clientY, px: toPct(parts[0] || '50%', over.x), py: toPct(parts[1] || parts[0] || '50%', over.y) };
  el.shield.style.display = 'block';
  el.shield.style.cursor = 'grabbing';
  let last = null;
  const onMove = ev => {
    const dx = (ev.clientX - start.x) / S.scale, dy = (ev.clientY - start.y) / S.scale;
    const x = over.x > 0.5 ? clamp(start.px - dx / over.x * 100, 0, 100) : 50;
    const y = over.y > 0.5 ? clamp(start.py - dy / over.y * 100, 0, 100) : 50;
    last = `${Math.round(x * 10) / 10}% ${Math.round(y * 10) / 10}%`;
    img.style.setProperty('object-position', last);
  };
  const detach = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    el.shield.style.display = 'none';
    if (S.crop) S.crop.cancelDrag = null;
  };
  const onUp = () => { detach(); if (last) styleEdit(img, { 'object-position': last }, 'crop-pos'); };
  // Esc / leaving crop mid-drag: drop the live preview, record nothing.
  S.crop.cancelDrag = () => { detach(); setStyleAttr(img, modelEl(img.dataset.edId)?.getAttribute('style')); };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
function flipImage() {
  const img = selectedImg();
  if (!img) return;
  const cur = S.win.getComputedStyle(img).scale;
  const [sx, sy] = cur === 'none' ? [1, 1] : (() => { const v = cur.split(/\s+/).map(Number); return [v[0], v[1] ?? v[0]]; })();
  const next = [-sx, sy];
  styleEdit(img, { scale: next[0] === 1 && next[1] === 1 ? null : `${next[0]} ${next[1]}` });
}
// Back to the picture the file had: source attributes, <picture> sources and inline style.
function resetImage() {
  const img = selectedImg();
  const orig = img && S.pristine.querySelector(`[data-ed-id="${img.dataset.edId}"]`);
  if (!orig) return toast('Ảnh này mới thêm, không có bản gốc');
  commitText();
  exitCrop();
  const ops = [];
  const a = buildAttrsOp(img, Object.fromEntries(['src', 'srcset', 'sizes', 'alt'].map(n => [n, orig.getAttribute(n)])), 'Đặt lại ảnh');
  if (a) ops.push(a);
  const pic = img.parentElement?.localName === 'picture' ? img.parentElement : null;
  if (pic) for (const srcEl of $$('source', pic)) {
    const o = isOriginal(srcEl) && S.pristine.querySelector(`[data-ed-id="${srcEl.dataset.edId}"]`);
    const op = o && buildAttrsOp(srcEl, { srcset: o.getAttribute('srcset') }, 'Đặt lại ảnh');
    if (op) ops.push(op);
  }
  const m = modelEl(img.dataset.edId), before = m.getAttribute('style'), after = orig.getAttribute('style');
  if (before !== after) {
    setStyleAttr(m, after);
    setStyleAttr(img, after);
    ops.push({ type: 'style', id: img.dataset.edId, before, after, label: 'Đặt lại ảnh' });
  }
  if (!ops.length) return toast('Ảnh đang giống bản gốc');
  pushOp({ type: 'batch', ops, label: 'Đặt lại ảnh' });
  queueThumb(img);
  refreshToolbar();
  toast('Đã đặt lại ảnh gốc');
}

// ================================================================ move / reorder blocks
const NO_CHILDREN = new Set(['img', 'svg', 'canvas', 'video', 'audio', 'iframe', 'textarea', 'select', 'input', 'script', 'style', 'template', 'picture', 'object', 'embed', 'br', 'hr', 'wbr', 'math']);
// Parents whose content model is text-level only: a block dropped inside is re-parented on reload.
const PHRASING_ONLY = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'b', 'strong', 'em', 'i', 'u', 's', 'small', 'label', 'code', 'pre', 'sup', 'sub', 'mark', 'abbr', 'time', 'kbd', 'caption', 'dt', 'legend', 'button']);
const INLINE_TAGS = new Set(['span', 'a', 'b', 'strong', 'em', 'i', 'u', 's', 'small', 'mark', 'sup', 'sub', 'code', 'img', 'br', 'label', 'abbr', 'time', 'kbd']);
// Children that the HTML parser only keeps inside specific parents, and parents that only keep specific children.
const NEEDS_PARENT = { li: ['ul', 'ol', 'menu'], dt: ['dl', 'div'], dd: ['dl', 'div'], tr: ['thead', 'tbody', 'tfoot'], td: ['tr'], th: ['tr'], thead: ['table'], tbody: ['table'], tfoot: ['table'], caption: ['table'], colgroup: ['table'], option: ['select', 'optgroup', 'datalist'], source: ['picture', 'video', 'audio'], figcaption: ['figure'], summary: ['details'] };
const ONLY_CHILDREN = { ul: ['li'], ol: ['li'], menu: ['li'], table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot'], thead: ['tr'], tbody: ['tr'], tfoot: ['tr'], tr: ['td', 'th'], dl: ['dt', 'dd', 'div'] };
function canContain(parent, node) {
  if (!parent || !node || !isOriginal(parent) || parent === node || node.contains(parent)) return false;
  if (NO_CHILDREN.has(parent.localName) || VOID_TAGS.has(parent.localName)) return false;
  const scope = layerScope();
  if (!scope || !(parent === scope || scope.contains(parent))) return false;
  if (!INLINE_TAGS.has(node.localName) && PHRASING_ONLY.has(parent.localName)) return false;
  if (NEEDS_PARENT[node.localName] && !NEEDS_PARENT[node.localName].includes(parent.localName)) return false;
  if (ONLY_CHILDREN[parent.localName] && !ONLY_CHILDREN[parent.localName].includes(node.localName)) return false;
  // Interactive content cannot nest: a link inside a link (or button in button, form in form) is split on reload.
  for (const tag of ['a', 'button', 'form', 'label']) {
    if ((node.localName === tag || node.querySelector(tag)) && (parent.closest(tag))) return false;
  }
  return true;
}
// Would the HTML parser rebuild `el` exactly as it is? Parses its markup in the context of its
// own parent, the same way the file will be parsed when reopened (nested <a>, table parts…).
function survivesReparse(el) {
  // <body>/<head>/<html> never survive fragment parsing as tags: check their children in place.
  const top = ['body', 'head', 'html'].includes(el.localName);
  const ctx = top ? el : el.parentElement || el;
  const r = el.ownerDocument.createRange();
  r.selectNodeContents(ctx);
  const html = top ? stripIds(el).innerHTML : stripIds(el).outerHTML;
  const box = el.ownerDocument.createElement('div');
  box.appendChild(r.createContextualFragment(html));
  return box.innerHTML === html;
}
function refreshRoots(node) {
  if (node.parentElement?.closest('[data-ed-edit]')) {
    node.removeAttribute('data-ed-edit');
    for (const n of node.querySelectorAll('[data-ed-edit]')) n.removeAttribute('data-ed-edit');
  } else markRoots(node, true);
}
// drop = { mode: 'before' | 'after' | 'inside', target }
function moveNode(node, drop) {
  if (!node || !drop || commandBlocked(node, 'move')) return false;
  commitText();   // may replace model subtrees: every model reference below is taken after it
  const m = modelEl(node.dataset.edId);
  const lParent = drop.mode === 'inside' ? drop.target : drop.target.parentElement;
  if (!m || !canContain(lParent, node) || commandBlocked(lParent) || commandBlocked(lParent, 'drop')) return false;
  let lRef = drop.mode === 'inside' ? null : drop.mode === 'before' ? drop.target : drop.target.nextSibling;
  const mParent = modelEl(lParent.dataset.edId), mt = drop.mode === 'inside' ? null : modelEl(drop.target.dataset.edId);
  if (!mParent || (drop.mode !== 'inside' && !mt)) return false;
  let mRef = drop.mode === 'inside' ? null : drop.mode === 'before' ? mt : mt.nextSibling;
  // Dropping an element next to itself changes nothing.
  if (lRef === node) lRef = node.nextSibling;
  if (mRef === m) mRef = m.nextSibling;
  if (lParent === node.parentNode && (lRef === node.nextSibling || (lRef === null && !node.nextSibling))) return false;
  const op = {
    type: 'move', label: 'Di chuyển khối', m, l: node,
    from: { mP: m.parentNode, mN: m.nextSibling, lP: node.parentNode, lN: node.nextSibling },
    to: { mP: mParent, mN: mRef, lP: lParent, lN: lRef },
  };
  applyMove(op, true);
  if (!survivesReparse(mParent)) {
    applyMove(op, false);
    toast('Vị trí này sẽ bị trình duyệt tự sắp xếp lại khi mở file — không đặt được', { err: true, ms: 4000 });
    return false;
  }
  pushOp(op);
  select(node, { edit: false });
  queueThumb(node);
  buildOutline();
  renderPins();
  if (layersVisible()) buildLayers();
  return true;
}
function siblingBlocks(node) { return node.parentElement ? layerKids(node.parentElement) : []; }
function nudgeOrder(dir) {
  const node = S.sel;
  if (!node) return;
  const sibs = siblingBlocks(node), i = sibs.indexOf(node);
  const other = sibs[i + dir];
  if (!other) return toast(dir < 0 ? 'Khối đã ở trên cùng' : 'Khối đã ở dưới cùng');
  moveNode(node, { mode: dir < 0 ? 'before' : 'after', target: other });
}
// ---- dragging rows in the layer tree
function computeDrop(ev, node) {
  const hit = document.elementFromPoint(ev.clientX, ev.clientY);
  const row = hit?.closest?.('#layer-tree .layer-row');
  if (!row) return null;
  const target = layerNode(row);
  if (!target || target === node || node.contains(target)) return null;
  const r = row.getBoundingClientRect(), y = (ev.clientY - r.top) / r.height;
  const order = y < 0.28 ? ['before'] : y > 0.72 ? ['after', 'inside'] : ['inside', y < 0.5 ? 'before' : 'after'];
  for (const mode of order) {
    const parent = mode === 'inside' ? target : target.parentElement;
    if (canContain(parent, node)) return { mode, target, row };
  }
  return null;
}
function showDropIndicator(drop) {
  const tree = $('#layer-tree'), line = $('#drop-line');
  $$('#layer-tree .layer-row.drop-in').forEach(r => r.classList.remove('drop-in'));
  if (!line) return;
  if (!drop) { line.hidden = true; showHoverBox(null); return; }
  showHoverBox(drop.mode === 'inside' ? drop.target : drop.target.parentElement);
  if (drop.mode === 'inside') { drop.row.classList.add('drop-in'); line.hidden = true; return; }
  const tr = tree.getBoundingClientRect(), rr = drop.row.getBoundingClientRect(), label = drop.row.querySelector('.lk').getBoundingClientRect();
  line.style.top = (drop.mode === 'before' ? rr.top : rr.bottom) - tr.top - 1 + 'px';
  line.style.left = label.left - tr.left - 6 + 'px';
  line.hidden = false;
}
function bindLayerDrag() {
  const tree = $('#layer-tree'), scroller = $('.panel-body[data-view="layers"]'), ghost = $('#drag-ghost');
  tree.addEventListener('pointerdown', e => {
    const row = e.target.closest('.layer-row');
    if (!row || e.button !== 0 || e.target.closest('.tg')) return;
    const node = layerNode(row);
    if (!node) return;
    const start = { x: e.clientX, y: e.clientY }, pid = e.pointerId;
    let dragging = false, drop = null, scrollTimer = 0;
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      clearInterval(scrollTimer);
      ghost.hidden = true;
      document.body.classList.remove('layer-dragging');
      row.classList.remove('dragging');
      showDropIndicator(null);
    };
    const onMove = ev => {
      if (ev.pointerId !== pid) return;
      if (!dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        dragging = true;
        row.classList.add('dragging');
        document.body.classList.add('layer-dragging');
        ghost.textContent = row.querySelector('.lk').textContent + ' ' + row.querySelector('.lt').textContent;
        ghost.hidden = false;
      }
      ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
      drop = computeDrop(ev, node);
      showDropIndicator(drop);
      // Auto-scroll near the panel's edges.
      clearInterval(scrollTimer);
      const sr = scroller.getBoundingClientRect(), edge = 36;
      const dir = ev.clientY < sr.top + edge ? -1 : ev.clientY > sr.bottom - edge ? 1 : 0;
      if (dir) scrollTimer = setInterval(() => { scroller.scrollTop += dir * 14; drop = computeDrop(ev, node); showDropIndicator(drop); }, 30);
    };
    const onCancel = ev => { if (ev.pointerId === pid) { dragging = false; stop(); } };
    const onUp = ev => {
      if (ev.pointerId !== pid) return;
      stop();
      if (!dragging) return;
      S.layerDragEnded = Date.now();
      if (drop && !moveNode(node, drop)) toast('Không đặt khối vào vị trí đó được');
    };
    const onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); dragging = false; stop(); } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  });
}

// ================================================================ layer tree
const LAYER_HIDDEN = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'br', 'wbr', 'title', 'base']);
const LAYER_LIMIT = 2500;
function layerKids(n) {
  if (n.localName === 'svg') return [];
  return [...n.children].filter(c => isOriginal(c) && !LAYER_HIDDEN.has(c.localName) && !c.classList.contains('notes'));
}
// Label text from the element's own text nodes only: reading textContent of every row
// rescans whole subtrees and stalls on multi-MB pages.
function directText(n) {
  let out = '';
  for (const c of n.childNodes) {
    if (c.nodeType === 3) out += c.nodeValue.slice(0, 160 - out.length);
    if (out.length >= 120) break;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 48);
}
function layerScope() { return S.mode === 'deck' ? S.slides[S.cur] : S.doc?.body; }
function layersVisible() { return el.panel.classList.contains('open') && el.panel.dataset.view === 'layers'; }
function buildLayers() {
  const tree = $('#layer-tree');
  const scope = S.doc && layerScope();
  if (!scope) { tree.innerHTML = `<div class="hint">${t('layer_empty')}</div>`; $('#layer-scope').textContent = ''; return; }
  $('#layer-scope').textContent = S.mode === 'deck' ? `Slide ${S.cur + 1} · ${slideTitle(scope, S.cur)}` : t('scope_whole_page');
  if (S.layerScope !== scope) { S.layerScope = scope; S.layerOpen = new Set(layerKids(scope).map(c => c.dataset.edId)); }
  if (S.sel && scope.contains(S.sel)) for (let n = S.sel.parentElement; n && n !== scope; n = n.parentElement) if (n.dataset.edId) S.layerOpen.add(n.dataset.edId);
  let count = 0;
  const frag = document.createDocumentFragment();
  const render = (n, box) => {
    for (const c of layerKids(n)) {
      if (++count > LAYER_LIMIT) {
        if (count === LAYER_LIMIT + 1) {
          const more = document.createElement('div');
          more.className = 'hint';
          more.textContent = t('layer_limit_more');
          box.appendChild(more);
        }
        return;
      }
      const kids = layerKids(c), open = S.layerOpen.has(c.dataset.edId);
      const row = document.createElement('div');
      row.className = 'layer-row' + (open && kids.length ? ' open' : '') + (c === S.sel ? ' sel' : '');
      row.dataset.id = c.dataset.edId;
      const text = contentSnippet(c), role = getLayerName(c.localName) || c.localName;
      row.innerHTML = `<span class="tg${kids.length ? '' : ' leaf'}"><svg class="icon"><use href="#i-caret"/></svg></span><span class="lk"></span><span class="lt"></span>`;
      row.querySelector('.lk').textContent = role;
      row.querySelector('.lt').textContent = text;
      row.title = text ? role + ': ' + text : role;
      box.appendChild(row);
      if (kids.length && open) {
        const sub = document.createElement('div');
        sub.className = 'layer-kids';
        box.appendChild(sub);
        render(c, sub);
      }
    }
  };
  render(scope, frag);
  tree.innerHTML = '<div class="drop-line" id="drop-line" hidden></div>';
  tree.appendChild(frag);
  if (!count) tree.innerHTML = `<div class="hint">${t('layer_no_blocks')}</div>`;
  tree.querySelector('.layer-row.sel')?.scrollIntoView({ block: 'nearest' });
}
function syncLayers() {
  if (!layersVisible()) return;
  const row = S.sel && $(`#layer-tree .layer-row[data-id="${S.sel.dataset.edId}"]`);
  if (S.sel && !row && layerScope()?.contains(S.sel)) { buildLayers(); return; }
  $$('#layer-tree .layer-row.sel').forEach(r => r.classList.remove('sel'));
  if (row) { row.classList.add('sel'); row.scrollIntoView({ block: 'nearest' }); }
}
function layerNode(row) { return row ? liveEl(row.dataset.id) : null; }
function showHoverBox(node) {
  const hb = $('#hover-box');
  if (!node || !node.isConnected) { hb.classList.remove('show'); return; }
  const r = node.getBoundingClientRect(), fr = el.frame.getBoundingClientRect(), st = el.stage.getBoundingClientRect();
  if (!r.width && !r.height) { hb.classList.remove('show'); return; }
  hb.style.transform = `translate(${fr.left - st.left + r.left * S.scale}px, ${fr.top - st.top + r.top * S.scale}px)`;
  hb.style.width = r.width * S.scale + 'px';
  hb.style.height = r.height * S.scale + 'px';
  hb.classList.add('show');
}
// Margin (orange) and padding (green) bands around one element, as GrapesJS ShowOffset draws
// them. Shown only while the user works the spacing controls (pointer over the padding / margin
// section, or a slider held), so normal editing stays uncluttered.
function drawOffsets(node) {
  const box = $('#offset-box');
  if (!node || !node.isConnected || S.presenting || S.crop) { if (S.offsetKey) { box.classList.remove('show'); S.offsetKey = ''; } return; }
  const r = node.getBoundingClientRect(), cs = S.win.getComputedStyle(node);
  const px = k => Math.max(0, parseFloat(cs[k]) || 0);
  const m = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'].map(px);
  const b = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].map(px);
  const p = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(px);
  const fr = el.frame.getBoundingClientRect(), st = el.stage.getBoundingClientRect(), s = S.scale;
  const key = [r.left, r.top, r.width, r.height, ...m, ...b, ...p, s, fr.left, fr.top].map(v => v.toFixed(1)).join(',');
  if (key === S.offsetKey) return;
  S.offsetKey = key;
  if (!r.width && !r.height) { box.classList.remove('show'); return; }
  const X = v => fr.left - st.left + v * s, Y = v => fr.top - st.top + v * s;
  const put = (i, x, y, w, h) => {
    const n = box.children[i];
    n.style.transform = `translate(${X(x)}px, ${Y(y)}px)`;
    n.style.width = Math.max(0, w * s) + 'px';
    n.style.height = Math.max(0, h * s) + 'px';
  };
  const { left: L, top: T, right: R, bottom: B } = r;
  put(0, L - m[3], T - m[0], r.width + m[3] + m[1], m[0]);
  put(1, R, T, m[1], r.height);
  put(2, L - m[3], B, r.width + m[3] + m[1], m[2]);
  put(3, L - m[3], T, m[3], r.height);
  const iL = L + b[3], iT = T + b[0], iR = R - b[1], iB = B - b[2];
  put(4, iL, iT, iR - iL, p[0]);
  put(5, iR - p[1], iT + p[0], p[1], iB - iT - p[0] - p[2]);
  put(6, iL, iB - p[2], iR - iL, p[2]);
  put(7, iL, iT + p[0], p[3], iB - iT - p[0] - p[2]);
  box.classList.add('show');
}
function refreshOffsets() {
  const boxOpen = el.panel.classList.contains('open') && el.panel.dataset.view === 'box';
  drawOffsets(boxOpen && (S.spacingHover || S.spacingDrag) ? S.sel : null);
}

// ================================================================ toolbar sync
function refreshToolbar() {
  const node = S.sel;
  el.ctx.classList.toggle('idle', !node);
  el.ctx.classList.toggle('img-mode', !!node && node.localName === 'img');
  if (boxVisible()) renderBoxPanel();
  if (!node || !S.win) return;
  if (node.localName === 'img') {
    const op = Math.round(parseFloat(S.win.getComputedStyle(node).opacity) * 100);
    $('#op-range').value = op; $('#op-out').textContent = op;
    return;
  }
  const cs = computedFor(node);
  const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
  const sel = $('#tb-font');
  if (![...sel.options].some(o => o.value === fam)) {
    $$('option[data-temp]', sel).forEach(o => o.remove());
    const o = new Option(fam, fam);
    o.dataset.temp = '1';
    sel.prepend(o);
  }
  sel.value = fam;
  if (document.activeElement !== $('#tb-size')) $('#tb-size').value = String(Math.round(parseFloat(cs.fontSize) * 10) / 10);
  $('#tb-color-bar').style.background = cs.color;
  const deco = cs.textDecorationLine;
  $('#tb-bold').classList.toggle('on', parseInt(cs.fontWeight, 10) >= 600);
  $('#tb-italic').classList.toggle('on', cs.fontStyle === 'italic');
  $('#tb-underline').classList.toggle('on', deco.includes('underline'));
  $('#tb-strike').classList.toggle('on', deco.includes('line-through'));
  const rcs = S.win.getComputedStyle(node);
  $('#tb-case').classList.toggle('on', rcs.textTransform === 'uppercase');
  let al = rcs.textAlign;
  al = al === 'start' ? 'left' : al === 'end' ? 'right' : al;
  $('#tb-align use').setAttribute('href', '#i-al-' + (['left', 'center', 'right', 'justify'].includes(al) ? al : 'left'));
  const fs = parseFloat(rcs.fontSize) || 16;
  const ls = rcs.letterSpacing === 'normal' ? 0 : Math.round(parseFloat(rcs.letterSpacing) / fs * 1000);
  $('#ls-range').value = ls; $('#ls-out').textContent = ls;
  const lh = rcs.lineHeight === 'normal' ? 1.2 : Math.round(parseFloat(rcs.lineHeight) / fs * 100) / 100;
  $('#lh-range').value = lh; $('#lh-out').textContent = lh;
  const op = Math.round(parseFloat(rcs.opacity) * 100);
  $('#op-range').value = op; $('#op-out').textContent = op;
  const textOnly = !isRoot(node);
  for (const id of ['tb-bold', 'tb-italic', 'tb-underline', 'tb-strike']) $('#' + id).disabled = false;
  el.box.classList.toggle('block', textOnly);
}
function closePopups() {
  $('#pop-fx').hidden = true;
  $('#pop-spacing').hidden = true;
  $('#pop-opacity').hidden = true;
  $('#pop-note').hidden = true;
  $('#pop-link').hidden = true;
  $('#pop-alt').hidden = true;
  $('#pop-img').hidden = true;
  el.menu.hidden = true;
}
function togglePop(id, btn) {
  const pop = $(id);
  const open = pop.hidden;
  closePopups();
  if (!open) return;
  const b = btn.getBoundingClientRect(), s = el.stage.getBoundingClientRect();
  pop.style.left = clamp(b.left - s.left + b.width / 2 - 130, 8, s.width - 268) + 'px';
  pop.hidden = false;
}

// ================================================================ effects (data-fx)
// The same runtime the document carries (js/fx/runtime.mjs), in preview mode: it plays one
// effect on the live node with the Web Animations API, which writes nothing to the DOM.
function fxApi() { return S.win ? (S.fxPreview ||= fxRuntime(S.win, { preview: true })) : null; }
function stopFxPreview() { S.fxPreview?.stopPreview(); }
const FX_ATTRS = ['data-fx', 'data-fx-delay', 'data-fx-dur', 'data-fx-stagger'];
function fxBlock(node, preset) {
  const block = S.readOnly || structureBlock(provenanceOf(node)) || formatBlock('fx', formatFlags(node));
  if (block) return block;
  if (preset === 'count-up' && (node.children.length || !fxApi()?.parseCount(node.textContent))) return 'fx_count_bad';
  return null;
}
function openFxPop(btn) {
  togglePop('#pop-fx', btn);
  if ($('#pop-fx').hidden || !S.sel) return;
  const m = modelEl(S.sel.dataset.edId);
  $('#fx-preset').value = m?.getAttribute('data-fx') || '';
  $('#fx-delay').value = m?.getAttribute('data-fx-delay') || '';
  $('#fx-dur').value = m?.getAttribute('data-fx-dur') || '';
  $('#fx-stagger').value = m?.getAttribute('data-fx-stagger') || '';
  renderFxDoc();
}
function applyFx() {
  const node = S.sel;
  if (!node) return;
  const preset = $('#fx-preset').value;
  const block = preset ? fxBlock(node, preset) : (S.readOnly || structureBlock(provenanceOf(node)));
  if (block) { lockedHint(block, node); $('#fx-preset').value = modelEl(node.dataset.edId)?.getAttribute('data-fx') || ''; return; }
  const id = node.dataset.edId, m = modelEl(id);
  if (!m) return;
  const val = sel => { const v = $(sel).value.trim(); return preset && /^\d+$/.test(v) ? v : null; };
  const after = { 'data-fx': preset || null, 'data-fx-delay': val('#fx-delay'), 'data-fx-dur': val('#fx-dur'), 'data-fx-stagger': val('#fx-stagger') };
  const before = Object.fromEntries(FX_ATTRS.map(a => [a, m.getAttribute(a)]));
  if (FX_ATTRS.every(a => before[a] === after[a])) return;
  setAttrs(m, after);
  setAttrs(node, after);
  pushOp({ type: 'attrs', id, before, after, key: 'fx:' + id, label: 'Hiệu ứng' });
  renderFxDoc();
}
function previewFx() {
  const node = S.sel;
  if (!node || !$('#fx-preset').value) return;
  applyFx();
  if (!node.getAttribute('data-fx')) return;
  // The edit frame freezes animations (runtime/freeze.mjs); the preview's own are exempt.
  S.win.__edNoFreeze = true;
  try { fxApi()?.preview(node); } finally { S.win.__edNoFreeze = false; }
}
// Effects panel: the data-fx blocks and scene scopes on the current slide (or the page).
function fxScope() { return S.mode === 'deck' ? S.slides[S.cur] : S.doc?.body; }
// Scenes a document registers from its script (window.__htmldeckScenes: [name, fn, {selector}]);
// in the edit frame the FX runtime never runs, so the queue is still a plain array. Only the
// name and selector are read.
function registeredScenes() {
  let q;
  try { q = S.win?.__htmldeckScenes; } catch { return []; }
  if (!Array.isArray(q)) return [];
  return q.map(e => Array.isArray(e) ? { name: String(e[0] ?? ''), selector: typeof e[2]?.selector === 'string' ? e[2].selector : `[data-fx-scene="${String(e[0] ?? '').replace(/"/g, '')}"]` } : null).filter(Boolean);
}
function sceneNamesFor(n) {
  const names = new Set();
  if (n.getAttribute('data-fx-scene')) names.add(n.getAttribute('data-fx-scene'));
  for (const d of registeredScenes()) { try { if (n.matches(d.selector)) names.add(d.name); } catch { /* bad selector */ } }
  return [...names];
}
function renderFxList() {
  const list = $('#fx-list'), scope = fxScope();
  if (!list || !scope) return;
  list.innerHTML = '';
  const sel = ['[data-fx]', '[data-fx-scene]', ...registeredScenes().map(d => d.selector)];
  const hits = n => sel.some(q => { try { return n.matches(q); } catch { return false; } });
  const items = [scope, ...scope.querySelectorAll('*')].filter(n => isOriginal(n) && hits(n));
  if (!items.length) { list.innerHTML = `<div class="hint">${t('fx_list_empty')}</div>`; return; }
  if (items.some(n => sceneNamesFor(n).length)) list.insertAdjacentHTML('beforeend', `<div class="hint" style="margin:0 2px 8px">${t('fx_scene_hint')}</div>`);
  for (const n of items) {
    const b = document.createElement('div');
    b.className = 'fx-item';
    b.setAttribute('role', 'button');
    const fx = n.getAttribute('data-fx'), scene = sceneNamesFor(n).join(', ');
    const extra = [n.getAttribute('data-fx-delay') && `+${n.getAttribute('data-fx-delay')}ms`, n.getAttribute('data-fx-stagger') && `⇉${n.getAttribute('data-fx-stagger')}ms`].filter(Boolean).join(' ');
    b.innerHTML = `<span class="k"></span><span class="t"></span>${fx ? `<button class="x" title="${escapeHTML(t('fx_remove'))}">×</button>` : ''}`;
    b.querySelector('.k').textContent = fx || `${t('fx_scene')}: ${scene}`;
    const what = !fx && n === scope && S.mode === 'deck' ? slideTitle(n, S.cur) : (n.textContent || n.localName).replace(/\s+/g, ' ').trim().slice(0, 60);
    b.querySelector('.t').textContent = `${extra ? extra + ' · ' : ''}${what}`;
    b.addEventListener('click', e => {
      if (e.target.closest('.x')) { select(n, { edit: false }); $('#fx-preset').value = ''; applyFx(); renderFxList(); return; }
      if (n !== fxScope()) select(n, { edit: false });
    });
    list.appendChild(b);
  }
}
function previewSlideFx() {
  const scope = fxScope();
  if (!scope) return;
  deselect();
  S.win.__edNoFreeze = true;
  try { fxApi()?.previewAll(scope); } finally { S.win.__edNoFreeze = false; }
}
const effectsVisible = () => el.panel.classList.contains('open') && el.panel.dataset.view === 'effects';
// Whether the file carries the runtime, and the button that enables / updates / removes it.
function fxScriptEl() { return S.model?.querySelector('script[data-htmldeck-fx]') || null; }
function renderFxDoc() {
  const box = $('#fx-doc'), script = fxScriptEl(), used = !!S.model?.querySelector('[data-fx]');
  box.hidden = !script && !used;
  if (box.hidden) return;
  const old = script && script.getAttribute('data-htmldeck-fx') !== String(FX_VERSION);
  $('#fx-doc-state').textContent = t(!script ? 'fx_doc_off' : old ? 'fx_doc_old' : 'fx_doc_on');
  const b = $('#fx-doc-btn');
  b.textContent = t(!script ? 'fx_enable' : old ? 'fx_update' : 'fx_disable');
  b.dataset.act = !script ? 'enable' : old ? 'update' : 'disable';
}
function fxDocAction() {
  if (!S.model) return;
  if (S.readOnly) return lockedHint(S.readOnly);
  const act = $('#fx-doc-btn').dataset.act;
  if (act === 'disable') return removeFxScript();
  const src = fxScriptSource(), modal = $('#modal-fx');
  $('#fx-modal-h').textContent = t(act === 'update' ? 'fx_update_h' : 'fx_enable_h');
  $('#fx-modal-b').textContent = t('fx_enable_b');
  $('#fx-modal-ok').textContent = t(act === 'update' ? 'fx_update_ok' : 'fx_enable_ok');
  $('#fx-diff').textContent = `+ <script data-htmldeck-fx="${FX_VERSION}">  … ${fmtSize(src.length)} …  </script>\n  </body>`;
  modal.classList.add('show');
  modal.onclick = e => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a && e.target !== modal) return;
    modal.classList.remove('show');
    if (a === 'ok') act === 'update' ? updateFxScript(src) : insertFxScript(src);
  };
}
// The live copy is created inert: a script inserted into a document runs, and the edit frame
// must never run the document's code that the model gains.
function insertFxScript(src) {
  flushPending();
  const m = S.model.createElement('script');
  m.setAttribute('data-htmldeck-fx', String(FX_VERSION));
  m.setAttribute('data-ed-id', String(S.nextId++));
  m.textContent = src;
  const l = S.doc.importNode(m, true);
  l.setAttribute('type', 'text/x-htmldeck-inert');
  // After the last element, not after the trailing whitespace: text after </body> in the file
  // is parsed into the body, so an appended node could not be spliced in place.
  const mRef = S.model.body.lastElementChild?.nextSibling || null;
  const lLast = S.model.body.lastElementChild && $$(`[data-ed-id="${S.model.body.lastElementChild.getAttribute('data-ed-id')}"]`, S.doc)[0];
  S.model.body.insertBefore(m, mRef);
  S.doc.body.insertBefore(l, lLast ? lLast.nextSibling : null);
  markOriginals(l, m);
  pushOp({ type: 'insert', label: 'Bật FX', ...nodeRefs(m, l) });
  renderFxDoc();
  toast(t('fx_doc_on'));
}
function updateFxScript(src) {
  const m = fxScriptEl(), id = m?.getAttribute('data-ed-id'), l = id && liveEl(id) || $$(`[data-ed-id="${id}"]`, S.doc)[0];
  if (!m || !l) return;
  const html = { type: 'html', id, before: m.innerHTML, after: src };
  const attrs = { type: 'attrs', id, before: { 'data-htmldeck-fx': m.getAttribute('data-htmldeck-fx') }, after: { 'data-htmldeck-fx': String(FX_VERSION) } };
  m.textContent = src; l.textContent = src;
  setAttrs(m, attrs.after); setAttrs(l, attrs.after);
  pushOp({ type: 'batch', label: 'Cập nhật FX', ops: [html, attrs] });
  renderFxDoc();
}
function removeFxScript() {
  const m = fxScriptEl(), id = m?.getAttribute('data-ed-id'), l = id && $$(`[data-ed-id="${id}"]`, S.doc)[0];
  if (!m || !l) return;
  const op = { type: 'remove', label: 'Tắt FX', ...nodeRefs(m, l) };
  doRemove(op);
  pushOp(op);
  renderFxDoc();
}

// ================================================================ overlay tracking
function startTrack() {
  if (S.trackRaf) return;
  const loop = () => {
    if (!S.sel || S.presenting) { S.trackRaf = 0; hideOverlay(); refreshOffsets(); return; }
    positionOverlay();
    refreshOffsets();
    S.trackRaf = requestAnimationFrame(loop);
  };
  S.trackRaf = requestAnimationFrame(loop);
}
function stopTrack() { cancelAnimationFrame(S.trackRaf); S.trackRaf = 0; }
function hideOverlay() {
  el.box.classList.remove('show', 'editing', 'block');
  el.pill.classList.remove('show');
  el.menu.hidden = true;
  S.lastBox = '';
}
function positionOverlay(force) {
  const node = S.sel;
  if (!node || !node.isConnected) { if (node) deselect(); return; }
  const r = node.getBoundingClientRect();
  const fr = el.frame.getBoundingClientRect(), st = el.stage.getBoundingClientRect(), sc = el.scroller.getBoundingClientRect();
  const s = S.scale;
  const x = fr.left - st.left + r.left * s, y = fr.top - st.top + r.top * s, w = r.width * s, h = r.height * s;
  const key = [x, y, w, h].map(v => v.toFixed(1)).join(',');
  if (!force && key === S.lastBox) return;
  S.lastBox = key;
  const visTop = sc.top - st.top, visBottom = sc.bottom - st.top;
  const visible = y + h > visTop && y < visBottom && w > 0;
  el.box.classList.toggle('show', visible);
  el.pill.classList.toggle('show', visible && !S.crop);
  if (!visible) { el.menu.hidden = true; return; }
  el.box.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
  el.box.style.width = w + 4 + 'px';
  el.box.style.height = h + 4 + 'px';
  el.box.classList.toggle('small', h < 26);
  const pw = el.pill.offsetWidth || 170, ph = el.pill.offsetHeight || 40;
  let py = y - ph - 14;
  if (py < 64) py = y + h + 14;
  const px = clamp(x + w / 2 - pw / 2, 8, st.width - pw - 8);
  el.pill.style.transform = `translate(${px}px, ${clamp(py, 60, st.height - ph - 8)}px)`;
  if (!el.menu.hidden) placeMenu();
}
function placeMenu() {
  const p = el.pill.getBoundingClientRect(), st = el.stage.getBoundingClientRect();
  el.menu.style.left = clamp(p.right - st.left - 210, 8, st.width - 218) + 'px';
  el.menu.style.top = (p.bottom - st.top + 6) + 'px';
}

// ================================================================ snap guides
// Idea from GrapesJS ComponentDrag: static lines (edges + centre) of the neighbours are measured
// once at drag start; while dragging, the nearest line within a few screen pixels pulls the box.
const SNAP_PX = 6;
function snapTargets(node) {
  const rects = [], seen = new Set([node]);
  const add = (n, frame) => {
    if (!n || seen.has(n) || n.nodeType !== 1 || !isOriginal(n)) return;
    seen.add(n);
    const r = n.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    rects.push({ l: r.left, t: r.top, r: r.right, b: r.bottom, frame });
  };
  const parent = node.parentElement;
  if (parent && parent !== S.doc.documentElement) add(parent, true);
  const slide = node.closest('[data-ed-slide]');
  if (slide) add(slide, true);
  let k = 0;
  for (const c of parent ? parent.children : []) { if (k++ > 200) break; if (!node.contains(c) && !c.contains(node)) add(c, false); }
  // On a slide, everything the user can pick is a candidate too (Canva-style), not only siblings.
  if (slide) for (const n of $$('[data-ed-edit], img', slide)) { if (k++ > 400) break; if (!node.contains(n) && !n.contains(node)) add(n, false); }
  const lines = { x: [], y: [] };
  for (const r of rects) {
    for (const v of [r.l, (r.l + r.r) / 2, r.r]) lines.x.push({ v, r });
    for (const v of [r.t, (r.t + r.b) / 2, r.b]) lines.y.push({ v, r });
  }
  return lines;
}
// Correction that brings the nearest of `moving` onto a static line, or 0.
function snapDelta(lines, moving, th) {
  let best = null;
  for (const m of moving) for (const s of lines) { const d = s.v - m; if (Math.abs(d) <= th && (!best || Math.abs(d) < Math.abs(best))) best = d; }
  return best ?? 0;
}
function drawSnapGuides(lines, cand) {
  const box = $('#snap-guides');
  if (!lines) { box.innerHTML = ''; return; }
  const fr = el.frame.getBoundingClientRect(), st = el.stage.getBoundingClientRect(), s = S.scale;
  const ox = fr.left - st.left, oy = fr.top - st.top;
  let html = '';
  const done = new Set();
  const gapLabel = (x, y, gap) => { if (gap >= 1) html += `<span class="snap-gap" style="transform:translate(${ox + x * s}px,${oy + y * s}px) translate(-50%,-50%)">${Math.round(gap)}</span>`; };
  for (const axis of ['x', 'y']) {
    const mov = axis === 'x' ? [cand.l, (cand.l + cand.r) / 2, cand.r] : [cand.t, (cand.t + cand.b) / 2, cand.b];
    for (const { v, r } of lines[axis]) {
      if (!mov.some(m => Math.abs(m - v) < 0.75)) continue;
      const key = axis + Math.round(v);
      if (done.has(key)) continue;
      done.add(key);
      if (axis === 'x') {
        const a = Math.min(cand.t, r.t), b = Math.max(cand.b, r.b);
        html += `<i class="snap-line" style="width:1px;height:${(b - a) * s}px;transform:translate(${ox + v * s}px,${oy + a * s}px)"></i>`;
        if (!r.frame) gapLabel(v, r.b < cand.t ? (r.b + cand.t) / 2 : (cand.b + r.t) / 2, r.b < cand.t ? cand.t - r.b : r.t - cand.b);
      } else {
        const a = Math.min(cand.l, r.l), b = Math.max(cand.r, r.r);
        html += `<i class="snap-line" style="height:1px;width:${(b - a) * s}px;transform:translate(${ox + a * s}px,${oy + v * s}px)"></i>`;
        if (!r.frame) gapLabel(r.r < cand.l ? (r.r + cand.l) / 2 : (cand.r + r.l) / 2, v, r.r < cand.l ? cand.l - r.r : r.l - cand.r);
      }
    }
  }
  box.innerHTML = html;
}

// ================================================================ drag: move / resize
function startDrag(kind, e) {
  const node = S.sel;
  if (!node || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  closePopups();
  if (S.editing) setEditing(false);
  const m = modelEl(node.dataset.edId);
  if (!m) return;
  const cs = S.win.getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  const st = { x: e.clientX, y: e.clientY, tr: parseTranslate(cs.translate), w: rect.width, h: rect.height, fs: parseFloat(cs.fontSize), inline: cs.display === 'inline', img: node.localName === 'img', fit: cs.objectFit };
  const tip = $('#size-tip');
  el.shield.style.display = 'block';
  el.shield.style.cursor = kind === 'move' ? 'grabbing' : getComputedStyle(e.target).cursor;
  el.box.classList.add('dragging');
  const changed = {};
  const set = (k, v) => { node.style.setProperty(k, v); changed[k] = v; };
  // Snapping covers moves and the side (width) handles; corner handles scale text or keep an
  // image's ratio, where pulling one edge onto a line would fight the proportion.
  const snaps = kind === 'move' || kind === 'e' || kind === 'w' ? snapTargets(node) : null;
  const onMove = ev => {
    let dx = (ev.clientX - st.x) / S.scale, dy = (ev.clientY - st.y) / S.scale;
    if (snaps && !ev.altKey) {
      const th = SNAP_PX / S.scale;
      const L = rect.left, R = rect.right, T = rect.top, B = rect.bottom;
      if (kind === 'move') {
        dx += snapDelta(snaps.x, [L + dx, (L + R) / 2 + dx, R + dx], th);
        dy += snapDelta(snaps.y, [T + dy, (T + B) / 2 + dy, B + dy], th);
        drawSnapGuides(snaps, { l: L + dx, r: R + dx, t: T + dy, b: B + dy });
      } else {
        const edge = kind === 'e' ? R + dx : L + dx;
        dx += snapDelta(snaps.x, [edge], th);
        const cand = kind === 'e' ? { l: L, r: R + dx, t: T, b: B } : { l: L + dx, r: R, t: T, b: B };
        drawSnapGuides({ x: snaps.x.filter(g => Math.abs(g.v - (kind === 'e' ? cand.r : cand.l)) < 0.75), y: [] }, cand);
      }
    } else if (snaps) drawSnapGuides(null);
    if (kind === 'move') {
      if (st.inline) set('display', 'inline-block');
      set('translate', `${Math.round(st.tr[0] + dx)}px ${Math.round(st.tr[1] + dy)}px`);
      tip.textContent = `x ${Math.round(st.tr[0] + dx)} · y ${Math.round(st.tr[1] + dy)}`;
    } else if (st.img) {
      // Pictures: corners scale proportionally; sides change the width and crop to fill.
      const sx = kind.includes('e') ? 1 : -1, sy = kind.includes('s') ? 1 : -1;
      let w;
      if (kind.length === 2) {
        const rx = (st.w + sx * dx) / st.w, ry = (st.h + sy * dy) / st.h;
        w = Math.max(16, Math.round(st.w * (Math.abs(rx - 1) >= Math.abs(ry - 1) ? rx : ry)));
      } else w = Math.max(16, Math.round(st.w + sx * dx));
      const h = kind.length === 2 ? Math.max(16, Math.round(st.h * w / st.w)) : Math.round(st.h);
      set('width', w + 'px');
      set('height', h + 'px');
      set('max-width', 'none');
      if (kind.length === 1 && st.fit === 'fill' && !node.style.objectFit) set('object-fit', 'cover');
      if (kind.includes('w') || kind.includes('n')) set('translate', `${Math.round(st.tr[0] + (kind.includes('w') ? st.w - w : 0))}px ${Math.round(st.tr[1] + (kind.includes('n') ? st.h - h : 0))}px`);
      tip.textContent = `${w} × ${h} px`;
    } else if (kind === 'e' || kind === 'w') {
      const w = Math.max(24, Math.round(st.w + (kind === 'e' ? dx : -dx)));
      if (st.inline) set('display', 'inline-block');
      set('width', w + 'px');
      set('max-width', 'none');
      if (kind === 'w') set('translate', `${Math.round(st.tr[0] + st.w - w)}px ${Math.round(st.tr[1])}px`);
      tip.textContent = `${t('tip_width')} ${w}px`;
    } else {
      const sx = kind.includes('e') ? 1 : -1, sy = kind.includes('s') ? 1 : -1;
      const rx = (st.w + sx * dx) / st.w, ry = (st.h + sy * dy) / st.h;
      const ratio = Math.max(0.15, Math.abs(rx - 1) >= Math.abs(ry - 1) ? rx : ry);
      const fs = Math.round(st.fs * ratio * 10) / 10;
      set('font-size', fs + 'px');
      tip.textContent = `${t('tip_size')} ${fs}px`;
    }
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    el.shield.style.display = 'none';
    el.box.classList.remove('dragging');
    drawSnapGuides(null);
    if (Object.keys(changed).length) styleEdit(node, changed);
    refreshToolbar();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
function nudge(dx, dy) {
  if (!S.sel) return;
  const cs = S.win.getComputedStyle(S.sel);
  const [tx, ty] = parseTranslate(cs.translate);
  const props = { translate: `${tx + dx}px ${ty + dy}px` };
  if (cs.display === 'inline') props.display = 'inline-block';
  styleEdit(S.sel, props, 'nudge');
}

// ================================================================ slides / filmstrip / outline / notes
function showSlide(i, { keepSel = false } = {}) {
  stopFxPreview();
  if (S.mode !== 'deck' || !S.slides.length) return;
  i = clamp(i, 0, S.slides.length - 1);
  if (!keepSel) deselect();
  S.cur = i;
  S.slides.forEach((s, k) => {
    s.style.setProperty('display', k === i ? s.dataset.edDisplay : 'none', 'important');
    s.classList.toggle('ed-cur', k === i);
  });
  if (S.centerRO) { S.centerRO.disconnect(); S.centerRO.observe(S.slides[i]); centerSlide(S.slides[i]); }
  $$('.thumb', el.filmstrip).forEach((t, k) => t.classList.toggle('active', k === i));
  el.filmstrip.children[i]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  $$('.outline-item', $('#outline-list')).forEach((t, k) => t.classList.toggle('current', k === i));
  updateChrome();
  if (!el.notes.hidden) loadNotes();
  if (layersVisible()) buildLayers();
  if (effectsVisible()) renderFxList();
  if (el.panel.classList.contains('open') && el.panel.dataset.view === 'review') renderNoteList();
}
function slideTitle(s, i) {
  const t = s.getAttribute('data-title') || s.querySelector('h1, h2, h3')?.textContent || '';
  return t.replace(/\s+/g, ' ').trim().replace(/^\d+\s*[·.-]\s*/, '') || `Slide ${i + 1}`;
}
function buildFilmstrip() {
  const head = S.model.head.cloneNode(true);
  head.querySelectorAll('script').forEach(n => n.remove());
  S.thumbHead = head.innerHTML;
  const htmlEl = S.model.documentElement;
  const reveal = S.format?.format === 'reveal';
  S.thumbHtmlAttrs = [...htmlEl.attributes].filter(a => a.name !== 'data-ed-id' && a.name !== 'class').map(a => `${a.name}="${escapeHTML(a.value)}"`)
    .concat(`class="${escapeHTML(((htmlEl.getAttribute('class') || '') + ' ed-deck').trim())}"`).join(' ');
  S.thumbBodyClass = ((S.model.body.getAttribute('class') || '') + (reveal ? ' reveal-viewport' : '')).trim();
  S.thumbExtraCSS = reveal ? Reveal.editCSS() : '';
  el.filmstrip.innerHTML = '';
  stripItems().forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'thumb';
    b.title = `${i + 1}. ${slideTitle(s, i)}`;
    b.innerHTML = `<iframe tabindex="-1" aria-hidden="true" loading="lazy" sandbox></iframe><span class="num">${i + 1}</span>`;
    // Fit the document's slide size into the 132×76 card, centred.
    const f = b.querySelector('iframe'), sc = Math.min(132 / S.deckW, 76 / S.deckH);
    Object.assign(f.style, { width: S.deckW + 'px', height: S.deckH + 'px', transform: `translate(${(132 - S.deckW * sc) / 2}px, ${(76 - S.deckH * sc) / 2}px) scale(${sc})` });
    b.addEventListener('click', () => S.mode === 'deck' ? showSlide(i) : jumpSection(i));
    el.filmstrip.appendChild(b);
    renderThumb(i);
  });
}
function renderThumb(i) {
  const s = stripItems()[i], b = el.filmstrip.children[i];
  if (!s || !b) return;
  const c = s.cloneNode(true);
  c.setAttribute('data-ed-slide', '');
  c.removeAttribute('contenteditable');
  c.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
  c.style.setProperty('display', s.dataset.edDisplay || 'block', 'important');
  let html = c.outerHTML;
  for (let a = s.parentElement; a && a !== S.doc.body && a !== S.doc.documentElement; a = a.parentElement) {
    const attrs = [...a.attributes].filter(x => x.name !== 'data-ed-slide-anc').map(x => ` ${x.name}="${escapeHTML(x.value)}"`).join('');
    html = `<${a.localName}${attrs} data-ed-slide-anc>${html}</${a.localName}>`;
  }
  b.querySelector('iframe').srcdoc = `<!DOCTYPE html><html ${S.thumbHtmlAttrs}><head><base href="${escapeHTML(S.baseURL)}">${S.thumbHead}<style>${thumbCSS()}${S.thumbExtraCSS || ''}</style></head><body class="${escapeHTML(S.thumbBodyClass)}">${html}</body></html>`;
  b.title = `${i + 1}. ${slideTitle(s, i)}`;
}
// Filmstrip entries: the slides of a deck, or the sections of a report opened as a page.
const stripItems = () => S.mode === 'deck' ? S.slides : S.sections;
function jumpSection(i) {
  const s = S.sections[i];
  if (!s) return;
  // Land below the page's own fixed header, as the document's own navigation would.
  const head = [...S.doc.body.querySelectorAll('*')].find(n => !n.closest('.slide') && S.win.getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().top <= 0 && n.offsetHeight < 200 && n.offsetWidth > S.win.innerWidth / 2);
  const top = s.getBoundingClientRect().top + S.win.scrollY - (head ? head.offsetHeight : 0);
  S.win.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}
// Highlight the section at the top of the viewport while the page scrolls.
function trackSection() {
  const mark = () => {
    if (!S.sections.length || !S.win) return;
    const y = S.win.innerHeight * 0.3;
    let i = 0;
    S.sections.forEach((s, k) => { if (s.getBoundingClientRect().top <= y) i = k; });
    if (i === S.cur && el.filmstrip.querySelector('.thumb.active')) return;
    S.cur = i;
    $$('.thumb', el.filmstrip).forEach((t, k) => t.classList.toggle('active', k === i));
    el.filmstrip.children[i]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  };
  let raf = 0;
  S.win.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; mark(); }); }, { passive: true });
  mark();
}
function queueThumb(node) {
  if (!node || !stripItems().length) return;
  const i = stripItems().findIndex(s => s === node || s.contains(node));
  if (i < 0) return;
  clearTimeout(S.thumbTimers.get(i));
  S.thumbTimers.set(i, setTimeout(() => { renderThumb(i); S.thumbTimers.delete(i); }, 450));
}
function buildOutline() {
  const list = $('#outline-list');
  if (!S.doc) { list.innerHTML = `<div class="hint">${t('layer_empty')}</div>`; return; }
  list.innerHTML = '';
  if (S.mode === 'deck') {
    S.slides.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'outline-item' + (i === S.cur ? ' current' : '');
      b.innerHTML = `<span class="num">${i + 1}</span><span class="t"></span>`;
      b.querySelector('.t').textContent = slideTitle(s, i);
      b.addEventListener('click', () => showSlide(i));
      list.appendChild(b);
    });
    return;
  }
  const heads = $$('h1, h2, h3', S.doc.body).filter(h => isOriginal(h) && h.textContent.trim());
  if (!heads.length) { list.innerHTML = `<div class="hint">${t('outline_empty')}</div>`; return; }
  heads.slice(0, 400).forEach(h => {
    const b = document.createElement('button');
    b.className = 'outline-item l' + h.localName[1];
    b.innerHTML = '<span class="t"></span>';
    b.querySelector('.t').textContent = h.textContent.replace(/\s+/g, ' ').trim();
    b.addEventListener('click', () => {
      h.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const root = isRoot(h) ? h : h.querySelector('[data-ed-edit]');
      if (root) setTimeout(() => select(root, { edit: false }), 350);
    });
    list.appendChild(b);
  });
}
function notesEl() {
  const s = S.slides[S.cur];
  return s ? $$('.notes', s).find(isOriginal) || null : null;
}
// Reveal also keeps notes in the slide's data-notes attribute (used when there is no aside).
function notesAttrSlide() {
  const s = S.slides[S.cur];
  return S.format?.format === 'reveal' && s && !notesEl() && s.hasAttribute('data-notes') ? s : null;
}
function loadNotes() {
  const n = notesEl(), a = notesAttrSlide();
  el.notesText.disabled = (!n && !a) || !!S.readOnly || !!formatBlock('edit', formatFlags(n || a));
  el.notesText.value = n ? n.textContent.trim() : a ? a.getAttribute('data-notes') : '';
  $('#notes-title').textContent = `${t('speaker_notes')} · Slide ${S.cur + 1}`;
}
function saveNotes() {
  const n = notesEl(), a = notesAttrSlide();
  if (!n && a) {
    const id = a.dataset.edId, m = modelEl(id);
    if (!m || commandBlocked(a)) return;
    const before = m.getAttribute('data-notes'), after = el.notesText.value;
    if (before === after) return;
    m.setAttribute('data-notes', after);
    a.setAttribute('data-notes', after);
    pushOp({ type: 'attrs', id, before: { 'data-notes': before }, after: { 'data-notes': after }, key: 'notes:' + id, label: 'Ghi chú' });
    return;
  }
  if (!n || commandBlocked(n)) return;
  const id = n.dataset.edId, m = modelEl(id);
  if (!m) return;
  const before = m.innerHTML, after = escapeHTML(el.notesText.value);
  if (before === after) return;
  m.innerHTML = after;
  n.innerHTML = after;
  pushOp({ type: 'html', id, before, after, key: 'notes:' + id, label: 'Ghi chú' });
}
function buildDocColors() {
  const counts = new Map();
  let k = 0;
  for (const node of S.liveById.values()) {
    if (k++ > 3000) break;
    const hex = rgbToHex(S.win.getComputedStyle(node).color);
    if (hex) counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 13).map(e => e[0]);
  renderSwatches($('#doc-colors'), top, true);
}
function renderSwatches(box, colors, withCustom) {
  box.innerHTML = '';
  if (withCustom) {
    const c = document.createElement('label');
    c.className = 'swatch custom';
    c.title = t('color_custom');
    c.innerHTML = '<input type="color">';
    c.querySelector('input').addEventListener('input', e => applyColor(e.target.value));
    box.appendChild(c);
  }
  for (const hex of colors) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => applyColor(hex));
    box.appendChild(b);
  }
}

// ================================================================ review notes for agents
// Notes are anchored by a CSS path computed on the model (= the file's own structure), plus
// the source line and a text snippet, so an agent can find the spot without the editor.
// Anchors are computed on `S.pristine` — the structure of the file as it is on disk — so an
// unsaved insert cannot shift `nth-of-type` and the agent reads the same structure.
function cssPath(m) {
  const parts = [], doc = m.ownerDocument;
  for (let n = m; n && n.localName !== 'html' && n.localName !== 'body'; n = n.parentElement) {
    if (n.id && doc.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break; }
    const same = [...n.parentElement.children].filter(c => c.localName === n.localName);
    parts.unshift(same.length > 1 ? `${n.localName}:nth-of-type(${same.indexOf(n) + 1})` : n.localName);
  }
  return parts.join(' > ');
}
function sourceLine(id) {
  if (S.lineMapText !== S.sourceText) { S.lineMap = alignTokens(tokenize(S.sourceText), S.pristine); S.lineMapText = S.sourceText; }
  const tok = S.lineMap?.get(id);
  if (!tok) return null;
  let line = 1;
  for (let i = S.sourceText.indexOf('\n'); i >= 0 && i < tok.start; i = S.sourceText.indexOf('\n', i + 1)) line++;
  return line;
}
function snippetOf(node) { return (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160); }
function noteTargetId(note) {
  let p = null;
  try { p = note.selector ? S.pristine.querySelector(note.selector) : null; } catch { p = null; }
  const snip = (note.text || '').slice(0, 30);
  if (p && snip && !snippetOf(p).includes(snip)) p = null;
  if (!p && snip) {
    // Several elements may carry the snippet: pick the innermost one nearest the pinned line.
    const cands = [...S.pristine.body.querySelectorAll('*')].filter(n => snippetOf(n).includes(snip) && ![...n.children].some(c => snippetOf(c).includes(snip)));
    p = cands.sort((a, b) => Math.abs((sourceLine(a.getAttribute('data-ed-id')) || 0) - (note.line || 0)) - Math.abs((sourceLine(b.getAttribute('data-ed-id')) || 0) - (note.line || 0)))[0] || null;
  }
  return p ? p.getAttribute('data-ed-id') : null;
}
function noteTarget(note) {
  const id = noteTargetId(note);
  return id && modelEl(id) ? liveEl(id) : null;
}
async function loadAgentNotes() {
  flushRemoval();
  S.agentNotes = [];
  const token = S.loadToken, src = S.source;
  if (src?.kind === 'server') {
    try {
      const res = await api(`/api/notes?path=${encodeURIComponent(src.path)}`);
      if (token !== S.loadToken) return;
      S.agentNotes = res.notes || [];
    } catch (e) { if (token === S.loadToken) toast('Không đọc được feedback: ' + e.message, { err: true }); }
  }
  $('#agent-cmd').textContent = S.source?.kind === 'server' ? agentCmd() : t('note_workspace_only');
  renderNoteList();
  renderPins();
}
// Send operations, not the whole list: the server merges them into the sidecar as it is on
// disk, so an agent's `--done` made meanwhile is never overwritten by this stale copy.
async function noteOps(ops) {
  const src = S.source, token = S.loadToken;
  if (src?.kind !== 'server') return toast('Feedback chỉ lưu được cho file trong workspace', { err: true });
  try {
    const res = await postJSON('/api/notes', { path: src.path, ops });
    if (token !== S.loadToken) return;
    S.agentNotes = res.notes || [];
  } catch (e) { toast('Không lưu được feedback: ' + e.message, { err: true, ms: 5000 }); }
  renderNoteList();
  renderPins();
}
// After a save the file structure changed: re-anchor notes to the new structure.
function reanchorNotes(beforeIds) {
  const ops = [];
  (S.agentNotes || []).forEach((n, i) => {
    const id = beforeIds[i];
    const p = id && S.pristine.querySelector(`[data-ed-id="${id}"]`);
    if (!p) return;
    const selector = cssPath(p), line = sourceLine(id);
    if (selector !== n.selector || line !== n.line) ops.push({ op: 'update', id: n.id, patch: { selector, line } });
  });
  if (ops.length) noteOps(ops);
}
// Single-quoted for the shell: paths may hold spaces or glob characters like [PTGSEA].
const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;
const agentCmd = () => `htmldeck-notes --file ${shq(S.source.path)}`;   // run in the workspace
// target: the selected block, or a whole slide / report section pinned from the panel.
function openNotePop(target = S.sel) {
  if (!target) return toast('Chọn một khối trước khi viết feedback');
  if (S.source?.kind !== 'server') return toast(t('note_workspace_only'), { err: true });
  if (S.editing) setEditing(false);
  const pop = $('#pop-note');
  closePopups();
  S.noteTarget = target;
  const whole = target === S.slides[S.cur] || S.sections.includes(target);
  $('#note-target').textContent = whole ? `${stripLabel(target)} · ${t('fb_whole_slide')}` : `“${snippetOf(target).slice(0, 70)}”`;
  $('#note-input').value = '';
  // Beside the target when there is room, so the block being described stays visible.
  const r = target.getBoundingClientRect(), fr = el.frame.getBoundingClientRect(), st = el.stage.getBoundingClientRect();
  const L = fr.left - st.left + r.left * S.scale, R = fr.left - st.left + r.right * S.scale;
  const T = fr.top - st.top + r.top * S.scale, B = fr.top - st.top + r.bottom * S.scale;
  const W = Math.min(330, st.width - 16), H = 210;
  pop.style.width = W + 'px';
  let x, y;
  if (whole) { x = st.width - W - 16; y = 70; }
  else if (R + 12 + W <= st.width) { x = R + 12; y = T; }
  else if (L - 12 - W >= 0) { x = L - 12 - W; y = T; }
  else { x = L; y = B + 12 <= st.height - H ? B + 12 : T - H - 12; }
  pop.style.left = clamp(x, 8, Math.max(8, st.width - W - 8)) + 'px';
  pop.style.top = clamp(y, 60, Math.max(60, st.height - H)) + 'px';
  pop.hidden = false;
  setTimeout(() => $('#note-input').focus(), 20);
}
function stripLabel(node) {
  const i = stripItems().indexOf(node);
  return S.mode === 'deck' ? `Slide ${i + 1}` : `${t('fb_section')} ${i + 1}`;
}
function addNoteFromPop() {
  const text = $('#note-input').value.trim(), target = S.noteTarget;
  if (!text || !target || !target.isConnected) return;
  const id = target.dataset.edId, p = S.pristine.querySelector(`[data-ed-id="${id}"]`);
  if (!p) return toast('Khối này chưa có trong file — bấm Lưu trước rồi viết feedback', { err: true, ms: 4000 });
  const slide = S.slides.indexOf(target.closest('[data-ed-slide]'));
  $('#pop-note').hidden = true;
  noteOps([{ op: 'add', note: {
    id: Math.random().toString(36).slice(2, 10), note: text, status: 'open', created: new Date().toISOString(),
    selector: cssPath(p), tag: p.localName, text: snippetOf(p), line: sourceLine(id), slide: slide >= 0 ? slide : null,
  } }]);
  toast('Đã lưu feedback');
}
function renderPins() {
  const box = $('#pins');
  box.innerHTML = '';
  S.pinEls = [];
  const perStrip = new Map();
  (S.agentNotes || []).forEach((n, i) => {
    const target = S.doc && noteTarget(n);
    if (target && n.status === 'open' && !isRemoving(n)) {
      const k = stripItems().findIndex(s => s === target || s.contains(target));
      if (k >= 0) perStrip.set(k, (perStrip.get(k) || 0) + 1);
    }
    if (!target || n.status !== (S.noteFilter || 'open') || isRemoving(n)) return;
    const pin = document.createElement('button');
    pin.className = 'pin' + (n.status === 'done' ? ' done' : '');
    pin.textContent = i + 1;
    pin.title = n.note;
    pin.addEventListener('click', () => focusNote(i));
    pin.addEventListener('mouseenter', () => showHoverBox(target));
    pin.addEventListener('mouseleave', () => showHoverBox(null));
    box.appendChild(pin);
    S.pinEls.push({ pin, target });
  });
  // Filmstrip: how many open notes each slide / section still has.
  [...el.filmstrip.children].forEach((b, k) => {
    let dot = b.querySelector('.note-dot');
    const c = perStrip.get(k) || 0;
    if (!c) { dot?.remove(); return; }
    if (!dot) { dot = document.createElement('span'); dot.className = 'note-dot'; b.appendChild(dot); }
    dot.textContent = c;
  });
  $('#note-count').hidden = !liveNotes().some(n => n.status === 'open');
  $('#note-count').textContent = liveNotes().filter(n => n.status === 'open').length;
  positionPins();
}
function positionPins() {
  if (!S.pinEls?.length || !S.doc) return;
  const fr = el.frame.getBoundingClientRect(), st = el.stage.getBoundingClientRect(), sc = el.scroller.getBoundingClientRect();
  for (const { pin, target } of S.pinEls) {
    const r = target.isConnected ? target.getBoundingClientRect() : null;
    const onSlide = S.mode !== 'deck' || target.closest('[data-ed-slide]') === S.slides[S.cur];
    if (!r || !r.width || !onSlide) { pin.style.display = 'none'; continue; }
    // A whole-slide / section note sits just inside its top-right corner, not off the page.
    const whole = stripItems().includes(target);
    const x = fr.left - st.left + r.right * S.scale + (whole ? -34 : 8), y = fr.top - st.top + Math.max(r.top, 0) * S.scale + (whole ? 10 : -26);
    const visible = y > sc.top - st.top - 10 && y < sc.bottom - st.top;
    pin.style.display = visible ? '' : 'none';
    pin.style.transform = `translate(${x}px, ${y}px)`;
  }
}
function pinLoop() { positionPins(); requestAnimationFrame(pinLoop); }
function focusNote(i) {
  const n = S.agentNotes[i], target = n && noteTarget(n);
  if (!el.panel.classList.contains('open') || el.panel.dataset.view !== 'review') openPanel('review');
  $$('.note-card').forEach(c => c.classList.toggle('hot', +c.dataset.i === i));
  $(`.note-card[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  if (!target) return toast('Không còn tìm thấy phần tử của feedback này');
  const slideIdx = S.slides.indexOf(target.closest('[data-ed-slide]'));
  if (slideIdx >= 0 && slideIdx !== S.cur) showSlide(slideIdx);
  if (S.mode === 'page') target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => select(target, { edit: false }), S.mode === 'page' ? 300 : 0);
}
function renderNoteList() {
  const box = $('#note-list');
  const notes = liveNotes(), filter = S.noteFilter || 'open';
  const open = notes.filter(n => n.status === 'open').length;
  const fb = $('#fb-filter');
  fb.children[0].textContent = t('fb_open').replace('{n}', open);
  fb.children[1].textContent = t('fb_done').replace('{n}', notes.filter(n => n.status === 'done').length);
  [...fb.children].forEach(b => b.classList.toggle('on', b.dataset.f === filter));
  const server = S.source?.kind === 'server';
  $('#fb-copy').disabled = !server || !open;
  const whole = S.mode === 'deck' ? S.slides[S.cur] : S.sections[S.cur];
  $('#fb-slide').hidden = !server || !whole;
  $('#fb-slide-label').textContent = t(S.mode === 'deck' ? 'fb_slide' : 'fb_page');
  if (!notes.length) { box.innerHTML = `<div class="hint">${t('no_notes_yet')}</div>`; return; }
  const shown = (S.agentNotes || []).map((n, i) => [n, i]).filter(([n]) => n.status === filter && !isRemoving(n));
  if (!shown.length) { box.innerHTML = `<div class="hint">${t(filter === 'open' ? 'fb_none_open' : 'fb_none_done')}</div>`; return; }
  box.innerHTML = '';
  for (const [n, i] of shown) {
    const c = document.createElement('div');
    c.className = 'note-card' + (n.status === 'done' ? ' done' : '');
    c.dataset.i = i;
    // Remove sits apart in the corner (the one destructive action); done and edit act on the
    // content, in their own row. All stay visible: touch screens have no hover.
    const doneLabel = n.status === 'done' ? t('note_reopen') : t('note_resolve');
    c.innerHTML = `<div class="nc-head"><span class="nc-num">${i + 1}</span><span class="nc-where"></span>${n.status === 'done'
      ? `<button class="nc-reopen" data-a="toggle" title="${doneLabel}" aria-label="${doneLabel}"><svg class="icon sm"><use href="#i-undo"/></svg></button>`
      : `<button class="nc-check" data-a="toggle" title="${doneLabel}" aria-label="${doneLabel}"><span class="ring"><svg class="icon"><use href="#i-check"/></svg></span></button>`}<button class="nc-x" data-a="del" title="${t('note_del')}" aria-label="${t('note_del')}"><svg class="icon sm"><use href="#i-x"/></svg></button></div><div class="nc-snip nc-quote"></div><div class="nc-text" data-a="edit" title="${t('fb_edit_hint')}"></div>`;
    const target = S.doc && noteTarget(n);
    const where = target ? stripItems().findIndex(s => s === target || s.contains(target)) : -1;
    const whole = target && stripItems()[where] === target;
    c.querySelector('.nc-where').textContent = where >= 0 ? (S.mode === 'deck' ? `Slide ${where + 1}` : `${t('fb_section')} ${where + 1}`) + (whole ? ' · ' + t('fb_whole_slide') : '')
      : n.slide != null ? `Slide ${n.slide + 1}` : '';
    // Line and tag are for agents; keep them out of sight but available on hover.
    c.querySelector('.nc-where').title = [n.line ? `line ${n.line}` : '', n.tag ? `<${n.tag}>` : ''].filter(Boolean).join(' · ');
    c.querySelector('.nc-text').textContent = n.note;
    const q = c.querySelector('.nc-quote');
    if (n.text && !whole) q.textContent = n.text; else q.remove();
    if (!target && S.doc) c.insertAdjacentHTML('beforeend', `<div class="nc-lost">${t('fb_lost')}</div>`);
    c.addEventListener('mouseenter', () => showHoverBox(target && (S.mode !== 'deck' || target.closest('[data-ed-slide]') === S.slides[S.cur]) ? target : null));
    c.addEventListener('mouseleave', () => showHoverBox(null));
    c.addEventListener('click', e => {
      if (e.target.closest('.nc-edit')) return;
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'toggle') toggleNoteDone(c, n);
      else if (a === 'del') removeNote(n);
      else if (a === 'edit') editNoteCard(c, n);
      else focusNote(i);
    });
    box.appendChild(c);
  }
}
// Remove is applied 3 s later: until then the note is only hidden and Undo brings it back in
// place (same number). The request carries its own path, so switching documents meanwhile
// can never remove a note from the wrong file.
const REMOVE_DELAY = 3000;
const liveNotes = () => (S.agentNotes || []).filter(n => !isRemoving(n));
const isRemoving = n => S.removing?.id === n.id;
function removeNote(n) {
  flushRemoval();
  const pending = { id: n.id, path: S.source.path };
  pending.timer = setTimeout(() => flushRemoval(), REMOVE_DELAY);
  S.removing = pending;
  renderNoteList();
  renderPins();
  toast(t('fb_removed'), { ms: REMOVE_DELAY, action: { label: t('fb_undo'), fn: () => {
    if (S.removing !== pending) return;
    clearTimeout(pending.timer);
    S.removing = null;
    renderNoteList();
    renderPins();
  } } });
}
function flushRemoval() {
  const p = S.removing;
  if (!p) return;
  clearTimeout(p.timer);
  S.removing = null;
  // keepalive: the request still goes out when this runs from pagehide.
  api('/api/notes', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p.path, ops: [{ op: 'delete', id: p.id }] }) })
    .then(res => { if (S.source?.path === p.path) { S.agentNotes = res.notes || []; renderNoteList(); renderPins(); } })
    .catch(e => { renderNoteList(); renderPins(); toast('Không gỡ được feedback: ' + e.message, { err: true }); });
}
function editNoteCard(card, n) {
  const text = card.querySelector('.nc-text');
  if (!text || card.querySelector('.nc-edit')) return;
  const ed = document.createElement('div');
  ed.className = 'nc-edit';
  ed.innerHTML = '<textarea rows="1"></textarea>';
  const ta = ed.querySelector('textarea');
  ta.value = n.note;
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
  text.replaceWith(ed);
  fit();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  let closed = false;
  const done = save => {
    if (closed) return;
    closed = true;
    const v = ta.value.trim();
    if (save && v && v !== n.note) noteOps([{ op: 'update', id: n.id, patch: { note: v } }]);
    else renderNoteList();
  };
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });
  ta.addEventListener('blur', () => done(true));
}
// Check fills and pops, then the card slides out of the current tab before the list updates.
function toggleNoteDone(card, n) {
  if (card.classList.contains('leaving')) return;
  const toDone = n.status !== 'done';
  if (toDone) card.classList.add('completing');
  setTimeout(() => {
    card.style.maxHeight = card.offsetHeight + 'px';
    card.offsetHeight;   // commit the start height so the collapse animates
    card.classList.add('leaving');
    card.style.maxHeight = '0px';
    card.style.marginBottom = '0px';
    card.style.paddingTop = card.style.paddingBottom = '0px';
    card.style.borderWidth = '0px';
  }, toDone ? 380 : 60);
  setTimeout(() => noteOps([{ op: 'update', id: n.id, patch: { status: toDone ? 'done' : 'open' } }]), toDone ? 720 : 400);
}
// One message the user pastes into Claude / Codex: what to fix, where, and how to report back.
function copyFeedbackRequest() {
  const notes = (S.agentNotes || []).map((n, i) => [n, i]).filter(([n]) => n.status === 'open' && !isRemoving(n));
  if (!notes.length) return toast(t('fb_nothing'));
  const lines = [t('fb_prompt_head').replace('{n}', notes.length).replace('{path}', S.source.path), ''];
  for (const [n, i] of notes) {
    const target = noteTarget(n);
    const k = target ? stripItems().findIndex(s => s === target || s.contains(target)) : -1;
    const whole = k >= 0 && stripItems()[k] === target;
    const where = (k >= 0 ? (S.mode === 'deck' ? `Slide ${k + 1}` : `${t('fb_section')} ${k + 1}`) : n.slide != null ? `Slide ${n.slide + 1}` : '') + (whole ? ` · ${t('fb_whole_slide')}` : '');
    const quote = n.text && !whole ? '“' + n.text.slice(0, 80) + '” → ' : '';
    lines.push(`${i + 1}. ${where ? '[' + where + '] ' : ''}${quote}${n.note}`);
  }
  lines.push('', t('fb_prompt_read'), agentCmd(), '', t('fb_prompt_done'), agentCmd() + ' --done <id>');
  const text = lines.join('\n');
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
    .then(() => toast(t('fb_copied')), () => { S.lastRequest = text; toast(text.slice(0, 120) + '…', { ms: 6000 }); });
}

// ================================================================ layout / zoom / present
function layout() {
  if (!S.doc) return;
  const deck = S.mode === 'deck';
  const pad = { x: 40, t: 72, b: 28 };
  el.scroller.style.padding = `${pad.t}px ${pad.x}px ${pad.b}px`;
  const availW = el.scroller.clientWidth - pad.x * 2, availH = el.scroller.clientHeight - pad.t - pad.b;
  const w = deck ? S.deckW : S.pageW;
  if (S.fit) S.scale = deck ? Math.min(availW / S.deckW, availH / S.deckH) : Math.min(1, availW / w);
  S.scale = clamp(S.scale, 0.1, 3);
  const h = deck ? S.deckH : Math.max(200, Math.floor(availH / S.scale));
  el.frame.style.width = w + 'px';
  el.frame.style.height = h + 'px';
  el.sheet.style.transform = `scale(${S.scale})`;
  el.sizer.style.width = w * S.scale + 'px';
  el.sizer.style.height = h * S.scale + 'px';
  const pct = Math.round(S.scale * 100);
  $('#zoom').value = pct;
  $('#zoom-pct').textContent = pct + '%';
  if (S.sel) positionOverlay(true);
}
function setZoom(pct) { S.fit = false; S.scale = clamp(pct / 100, 0.1, 3); layout(); }
function zoomBy(f) { setZoom(S.scale * 100 * f); }
function fitZoom() { S.fit = true; layout(); }
// Present runs in its own iframe built from the model (js/present/): the edit iframe, its
// selection mapping and the undo history stay untouched underneath, and the deck gets its keys.
function togglePresent() { if (S.present) endPresent(); else startPresent(); }
function startPresent() {
  if (!S.doc || S.present) return;
  stopFxPreview();
  flushPending();
  deselect();
  const mode = S.mode === 'deck' && S.slides.length ? 'deck' : 'page';
  const slideIds = mode === 'deck' ? S.slides.map(s => s.dataset.edId) : [];
  const displays = mode === 'deck' ? S.slides.map(s => s.dataset.edDisplay) : [];
  const untrusted = S.source.kind !== 'server', reveal = S.format?.format === 'reveal';
  // Reveal decks present with the author's own runtime; without it (untrusted, or no Reveal
  // script) the legacy provider shows the leaves statically.
  const provider = mode !== 'deck' ? 'page' : reveal && !untrusted && S.format.present === 'reveal' ? 'reveal' : 'legacy';
  const p = { sessionId: newSessionId(), docRevision: topSeq(), mode, provider, count: slideIds.length, start: mode === 'deck' ? S.cur : 0, session: null, fullscreen: false };
  const staticReveal = reveal && provider === 'legacy';
  let html;
  try {
    html = renderPresentHTML(S.model, S.doctype, {
      untrusted, mode, provider, slideIds, displays, start: p.start, deckW: S.deckW, deckH: S.deckH,
      extraCSS: staticReveal ? Reveal.editCSS() + Reveal.backgroundCSS(Reveal.leaves(S.model), '[data-ed-cur]') : '',
      bodyClass: staticReveal ? 'reveal-viewport' : '',
      session: { ns: PRESENT_NS, v: PRESENT_V, sessionId: p.sessionId, docRevision: p.docRevision, origin: location.origin },
    });
  } catch (e) { toast('Không mở được chế độ trình chiếu: ' + e.message, { err: true }); return; }
  S.present = p;
  S.presenting = true;
  el.stage.classList.add('presenting');
  hideOverlay();
  // Requested inside the click, before any await: browsers only grant it to a user gesture.
  // Refused (or unsupported), the present layer still covers the window.
  // A request that completes after the session already ended must not leave the stage full screen.
  el.stage.requestFullscreen?.().then(() => { if (S.present !== p && document.fullscreenElement === el.stage) document.exitFullscreen().catch(() => {}); }, () => {});
  const fail = msg => { if (S.present !== p) return; endPresent(); toast('Không mở được chế độ trình chiếu' + (msg ? ': ' + msg : ''), { err: true }); };
  // One deadline from the click to the frame's ready, staging included.
  p.deadline = setTimeout(() => { if (p.session?.state !== 'active') fail('quá thời gian chờ'); }, 10000);
  postJSON('/api/preview', { path: S.source.kind === 'server' ? S.source.path : null, content: html, target: 'present' }).then(({ url }) => {
    if (S.present !== p) return;
    p.session = createPresentSession({
      host: $('#present-host'), url, title: S.source.name, sessionId: p.sessionId, docRevision: p.docRevision,
      count: p.count, start: p.start, origin: S.previewOrigin,
      on: {
        ready: m => { clearTimeout(p.deadline); layoutPresent(); p.session.frame.focus(); p.session.frame.contentWindow?.focus(); document.body.dataset.presentIndex = String(m.index); document.body.dataset.presentState = 'active'; if (m.split) toast(t('present_split'), { ms: 5000 }); },
        state: i => { document.body.dataset.presentIndex = String(i); },
        exit: () => endPresent(),
        save: () => save(),
        fail: reason => fail(reason),
      },
    });
    layoutPresent();
  }, e => fail(e.message));
  document.body.dataset.presentState = 'loading';
  document.body.dataset.presentIndex = String(p.start);
}
// restore: false when the document itself is going away (open / re-render).
function endPresent({ restore = true } = {}) {
  const p = S.present;
  if (!p) return;
  S.present = null;
  S.presenting = false;
  const index = p.session ? p.session.index : p.start;
  clearTimeout(p.deadline);
  p.session?.dispose();
  el.stage.classList.remove('presenting');
  delete document.body.dataset.presentState;
  delete document.body.dataset.presentIndex;
  if (document.fullscreenElement === el.stage) document.exitFullscreen().catch(() => {});
  if (!restore) return;
  if (S.mode === 'deck' && index !== S.cur) showSlide(index);
  // The window keeps its full-screen size for a moment after exit; lay out again once it settles.
  requestAnimationFrame(layout);
  setTimeout(layout, 120);
  setTimeout(layout, 400);
}
function layoutPresent() {
  const p = S.present, f = p?.session?.frame;
  if (!f) return;
  const host = $('#present-host'), W = host.clientWidth, H = host.clientHeight;
  if (p.provider === 'legacy') {
    const sc = Math.min(W / S.deckW, H / S.deckH);
    f.style.width = S.deckW + 'px';
    f.style.height = S.deckH + 'px';
    f.style.transform = `translate(${(W - S.deckW * sc) / 2}px, ${(H - S.deckH * sc) / 2}px) scale(${sc})`;
  } else {
    f.style.width = W + 'px';
    f.style.height = H + 'px';
    f.style.transform = '';
  }
}
document.addEventListener('fullscreenchange', () => {
  const p = S.present;
  // Only the session's own full screen ending closes it; a refused request never opened one.
  if (p && document.fullscreenElement === el.stage) p.fullscreen = true;
  else if (p && p.fullscreen) endPresent();
  requestAnimationFrame(layoutPresent);
  setTimeout(layoutPresent, 120);
});

// ================================================================ save / download
async function save({ force = false, rewriteOk = false } = {}) {
  if (!S.model || S.saving) return;
  flushPending();
  if (!isDirty() && !force) return toast('Không có thay đổi nào để lưu');
  const { content, minimal } = contentForSave();
  // Ask before rewriting a file whose edits could not be patched in place (an upload only
  // downloads a new copy, so there is nothing to protect).
  if (!minimal && !rewriteOk && S.source.kind !== 'upload') return askRewrite(content);
  if (content.length > 60 * 1048576) return toast(`File sau khi sửa nặng ${fmtSize(content.length)}, vượt giới hạn lưu 60 MB — bỏ bớt ảnh nhúng`, { err: true, ms: 7000 });
  const seqAtSave = topSeq();
  // Edits made while the request is in flight belong to the next save.
  const snapshot = S.model.cloneNode(true), touchedAtSave = S.touched;
  S.inFlightSeq = seqAtSave;
  const noteIds = (S.agentNotes || []).map(noteTargetId);
  S.touched = new Set();
  // Still differs from pristine until the request lands: a download meanwhile must patch it too.
  S.touchedInFlight = touchedAtSave;
  const src = S.source, token = S.loadToken;
  S.saving = true;
  $('#sb-mode').disabled = true;
  updateChrome();
  try {
    if (src.kind === 'server') {
      const res = await postJSON('/api/save', { path: src.path, content, mtime_ns: src.mtime, force });
      src.mtime = res.mtime_ns;
      if (token !== S.loadToken) return;
      toast(`Đã lưu ${res.file} · ${fmtSize(res.bytes_written)} · sao lưu: ${res.backup.split('/').pop()}`);
    } else if (src.kind === 'handle') {
      // No server mtime here: compare the file on disk with the text we opened or last saved.
      if (!force && textHash(await (await src.handle.getFile()).text()) !== S.diskHash) {
        const err = new Error('file changed on disk'); err.status = 409; throw err;
      }
      const w = await src.handle.createWritable();
      await w.write(content);
      await w.close();
      if (token !== S.loadToken) return;
      toast(`Đã lưu thẳng vào ${src.name}`);
    } else {
      download(content, src.name);
      toast('Trình duyệt không cho ghi trực tiếp file đã kéo vào — đã tải bản mới về máy', { ms: 4500 });
    }
    S.savedSeq = seqAtSave;
    S.saveError = '';
    S.sourceText = content;
    const oldKey = draftKey(src);
    S.diskHash = textHash(content);
    S.pristine = snapshot;
    // Edits made during the request are still unsaved: replace the draft now rather than
    // leaving the pre-save one as the recovery copy until the debounce fires.
    if (oldKey !== draftKey(src) || !isDirty()) clearDraft(oldKey);
    if (isDirty()) writeDraft().catch(() => {});
    if (src.kind === 'server') reanchorNotes(noteIds);
  } catch (e) {
    if (token !== S.loadToken) return;
    for (const id of touchedAtSave) S.touched.add(id);
    if (e.status === 409) { S.saving = false; updateChrome(); return showConflict(content); }
    S.saveError = e.message;
    toast('Lưu thất bại: ' + e.message, { err: true, ms: 6000 });
  } finally {
    S.inFlightSeq = null;
    if (token === S.loadToken) S.touchedInFlight = null;
    $('#sb-mode').disabled = false;
    if (token === S.loadToken) { S.saving = false; updateChrome(); }
  }
}
function askRewrite(content) {
  const m = $('#modal-reformat');
  m.classList.add('show');
  m.onclick = e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act && e.target !== m) return;
    m.classList.remove('show');
    if (act === 'save') save({ rewriteOk: true });
    else if (act === 'download') download(content, S.source.name);
  };
}
function download(content, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/html;charset=utf-8' }));
  a.download = name || 'document.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function showConflict(content) {
  const m = $('#modal-conflict');
  m.classList.add('show');
  m.onclick = e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act && e.target !== m) return;
    m.classList.remove('show');
    if (act === 'force') save({ force: true, rewriteOk: true });
    else if (act === 'download') download(content, S.source.name);
  };
}

// ================================================================ draft recovery
// Idea from GrapesJS StorageManager (autosave + recovery): unsaved work is copied to IndexedDB
// shortly after each change, so a crash or a closed tab does not lose it. IndexedDB, not
// localStorage: an embedded picture alone can be 4 MB, past localStorage's ~5 MB quota.
const DRAFT_DB = 'gs9_editor', DRAFT_STORE = 'drafts', DRAFT_DELAY = 1500;
function draftDB() {
  if (!S.draftDB) {
    S.draftDB = new Promise((resolve, reject) => {
      const req = indexedDB.open(DRAFT_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DRAFT_STORE, { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    S.draftDB.catch(() => { S.draftDB = null; });
  }
  return S.draftDB;
}
// Draft reads/writes run one at a time, in call order, so a late delete never lands on a newer put.
function draftTx(mode, fn) {
  const run = (S.draftQ || Promise.resolve()).then(() => draftTxNow(mode, fn));
  S.draftQ = run.catch(() => {});
  return run;
}
async function draftTxNow(mode, fn) {
  const db = await draftDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, mode), req = fn(tx.objectStore(DRAFT_STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
// A server path names one file. A local name does not (two index.html in different folders),
// so local drafts are also keyed by the hash of the text they were made from.
const draftKey = (src, hash = S.diskHash) => src ? (src.kind === 'server' ? 'server:' + src.path : 'local:' + src.name + ':' + hash) : null;
function scheduleDraft() {
  clearTimeout(S.draftTimer);
  if (!S.model || !S.source || !isDirty()) return;
  S.draftTimer = setTimeout(() => (window.requestIdleCallback || (f => f()))(() => writeDraft().catch(() => {}), { timeout: 2000 }), DRAFT_DELAY);
}
async function writeDraft() {
  clearTimeout(S.draftTimer);
  if (!S.model || !S.source || !isDirty()) return;
  commitText();
  const key = draftKey(S.source), token = S.loadToken;
  const { content } = contentForSave();
  if (content.length > 60 * 1048576) return;
  const rec = { key, base: S.diskHash, content, savedAt: Date.now(), name: S.source.name, rev: Math.random().toString(36).slice(2) };
  await draftTx('readwrite', st => st.put(rec));
  // A save or another document may have landed while the write was queued: drop this record,
  // but never a newer one written under the same key in the meantime.
  if (token !== S.loadToken || !isDirty()) {
    // Compare and delete in one transaction: a newer draft put in between must survive.
    await draftTx('readwrite', st => {
      const r = st.get(key);
      r.onsuccess = () => { if (r.result?.rev === rec.rev) st.delete(key); };
      return r;
    }).catch(() => {});
  }
}
async function clearDraft(key = draftKey(S.source)) {
  clearTimeout(S.draftTimer);
  if (key) await draftTx('readwrite', st => st.delete(key)).catch(() => {});
}
// Called once a document is open. Returns true when a draft replaced the loaded text.
async function offerDraft(html, source) {
  if (source.restored) return false;
  const token = S.loadToken;
  let rec;
  try { rec = await draftTx('readonly', st => st.get(draftKey(source, textHash(html)))); } catch { return false; }
  if (!rec || rec.content === html) { if (rec) clearDraft(rec.key); return false; }
  // Restoring reopens the document; never do that over edits made while IndexedDB was read.
  // The draft stays, and the next autosave of the new edits replaces it.
  if (token !== S.loadToken || S.undo.length || isDirty()) return false;
  const time = new Date(rec.savedAt).toLocaleString(S.lang === 'en' ? 'en-GB' : S.lang === 'zh' ? 'zh-CN' : 'vi-VN');
  let msg = t('draft_restore').replace('{name}', source.name).replace('{time}', time);
  if (rec.base && rec.base !== textHash(html)) msg += t('draft_changed');
  if (!confirm(msg)) { clearDraft(rec.key); return false; }
  // The draft becomes the working text; the file's mtime stays, so the server still refuses
  // to overwrite a file that changed on disk (409) without asking.
  await openDocument(rec.content, { ...source, restored: true, diskHash: textHash(html) });
  S.savedSeq = -1;
  updateChrome();
  toast(t('draft_restored'), { ms: 5000 });
  return true;
}

// ================================================================ find & replace
// Matches are found inside single text nodes of the editable roots and painted with the CSS
// Custom Highlight API, so searching never touches the document. Replacing goes through the
// same 'html' ops as typing: undoable (Replace all = one step) and saved as minimal patches.
function openFind(replace) {
  if (!S.doc) return;
  $('#findbar').hidden = false;
  const sel = S.win.getSelection?.()?.toString().trim();
  if (sel && sel.length < 200 && !sel.includes('\n')) $('#find-q').value = sel;
  const inp = replace && $('#find-q').value ? $('#find-r') : $('#find-q');
  inp.focus();
  inp.select();
  runFind();
  if (S.find?.hits.length) revealHit(S.find.hits[S.find.i]);
}
function closeFind() {
  $('#findbar').hidden = true;
  S.find = null;
  clearFindMarks();
}
function clearFindMarks() {
  try { S.win?.CSS?.highlights?.delete('ed-find'); S.win?.CSS?.highlights?.delete('ed-find-cur'); } catch {}
}
function findRoots() {
  if (!S.doc) return [];
  const scopes = S.mode === 'deck' ? S.slides : [S.doc.body];
  const out = [];
  for (const sc of scopes) for (const r of sc.querySelectorAll('[data-ed-edit]')) if (isOriginal(r) && !r.parentElement.closest('[data-ed-edit]')) out.push(r);
  return out;
}
function runFind(keep) {
  clearFindMarks();
  const q = $('#find-q').value, cs = $('#find-case').checked, hits = [];
  if (q && S.doc) {
    const needle = cs ? q : q.toLowerCase(), hidden = new Map();
    // Text the page hides (e.g. the other language of a bilingual report) is skipped. The
    // walk stops at the slide, which the editor itself hides when it is not the current one.
    const isHidden = e => {
      if (!e || e === S.doc.body || e.hasAttribute('data-ed-slide')) return false;
      if (!hidden.has(e)) { const c = S.win.getComputedStyle(e); hidden.set(e, c.display === 'none' || c.visibility === 'hidden' || isHidden(e.parentElement)); }
      return hidden.get(e);
    };
    for (const root of findRoots()) {
      const w = S.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (isHidden(n.parentElement)) continue;
        const hay = cs ? n.data : n.data.toLowerCase();
        if (hay.length !== n.data.length) continue;   // case folding changed offsets (rare letters)
        for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) hits.push({ n, s: i, e: i + needle.length, root });
      }
    }
  }
  let i = -1;
  if (hits.length) {
    if (keep && S.find) i = Math.min(S.find.i, hits.length - 1);
    else if (S.mode === 'deck') i = Math.max(0, hits.findIndex(h => S.slides[S.cur]?.contains(h.root)));
    else i = 0;
  }
  S.find = { q, hits, i };
  paintFind();
}
function hitRange(h) {
  const r = S.doc.createRange();
  r.setStart(h.n, h.s);
  r.setEnd(h.n, h.e);
  return r;
}
function paintFind() {
  const f = S.find, hl = S.win?.CSS?.highlights, H = S.win?.Highlight;
  $('#find-count').textContent = !f || !f.q ? '' : f.hits.length ? `${f.i + 1}/${f.hits.length}` : t('find_none');
  $('#find-rep').disabled = $('#find-all').disabled = !f || !f.hits.length;
  if (!f || !f.hits.length || !hl || !H) return;
  hl.set('ed-find', new H(...f.hits.map(hitRange)));
  hl.set('ed-find-cur', new H(hitRange(f.hits[f.i])));
}
function stepFind(d) {
  const f = S.find;
  if (!f || !f.hits.length) return;
  f.i = (f.i + d + f.hits.length) % f.hits.length;
  paintFind();
  revealHit(f.hits[f.i]);
}
function revealHit(h) {
  if (S.mode === 'deck') {
    const k = S.slides.findIndex(s => s.contains(h.root));
    if (k >= 0 && k !== S.cur) showSlide(k);
    return;
  }
  const b = hitRange(h).getBoundingClientRect();
  if (b.top < 90 || b.bottom > S.win.innerHeight - 40) S.win.scrollBy({ top: b.top - S.win.innerHeight / 2, behavior: 'smooth' });
}
function replaceHits(hits) {
  if (!hits.length) return 0;
  flushPending();
  if (S.editing) setEditing(false);
  const rep = $('#find-r').value, byRoot = new Map();
  for (const h of hits) { if (!byRoot.has(h.root)) byRoot.set(h.root, []); byRoot.get(h.root).push(h); }
  const ops = [];
  let locked = 0;
  for (const [root, list] of byRoot) {
    const m = modelEl(root.dataset.edId);
    if (!m) continue;
    // Replacing copies the live block back into the model, like typing: same rule applies.
    if (textEditBlock(provenanceOf(root))) { locked += list.length; continue; }
    const byNode = new Map();
    for (const h of list) { if (!byNode.has(h.n)) byNode.set(h.n, []); byNode.get(h.n).push(h); }
    // Right to left inside each text node, so the earlier offsets stay valid.
    for (const [n, hs] of byNode) for (const h of hs.sort((a, b) => b.s - a.s)) n.data = n.data.slice(0, h.s) + rep + n.data.slice(h.e);
    const before = m.innerHTML, after = cleanFragment(root.innerHTML);
    if (before === after) continue;
    m.innerHTML = after;
    ops.push({ type: 'html', id: root.dataset.edId, before, after, label: t('replace_one') });
    queueThumb(root);
  }
  if (locked) lockedHint('lock_find_skipped');
  if (!ops.length) return 0;
  pushOp(ops.length === 1 ? ops[0] : { type: 'batch', ops, label: t('replace_all') });
  return hits.length - locked;
}
function bindFind() {
  const q = $('#find-q');
  q.addEventListener('input', () => { runFind(); if (S.find.hits.length) revealHit(S.find.hits[S.find.i]); });
  $('#find-case').addEventListener('change', () => runFind());
  for (const inp of [q, $('#find-r')]) inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (inp === q) stepFind(e.shiftKey ? -1 : 1); else $('#find-rep').click(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('#find-prev').addEventListener('click', () => stepFind(-1));
  $('#find-next').addEventListener('click', () => stepFind(1));
  $('#find-close').addEventListener('click', closeFind);
  $('#sb-find').addEventListener('click', () => openFind(false));
  $('#find-rep').addEventListener('click', () => {
    const f = S.find;
    if (!f?.hits.length) return;
    replaceHits([f.hits[f.i]]);
    runFind(true);
    if (S.find.hits.length) revealHit(S.find.hits[S.find.i]);
  });
  $('#find-all').addEventListener('click', () => {
    const n = replaceHits(S.find?.hits || []);
    runFind();
    if (n) toast(t('replaced_n').replace('{n}', n));
  });
}

// ================================================================ overflow warnings
// Text cut off by its frame is easy to miss after an edit. An editable root is flagged when it
// sticks out of the slide or of an ancestor that clips (overflow hidden/clip) while still partly
// inside it (items parked fully outside on purpose, like carousel pages or captions waiting for
// an animation, are not flagged), or when its own clipped box is too small for its text.
function clipCulprit(r, cache) {
  const rr = r.getBoundingClientRect();
  if (!rr.width && !rr.height) return null;
  const own = S.win.getComputedStyle(r);
  if (own.textOverflow !== 'ellipsis' && /hidden|clip/.test(own.overflowX + own.overflowY) && (r.scrollHeight > r.clientHeight + 2 || r.scrollWidth > r.clientWidth + 2)) return r;
  for (let a = r.parentElement; a && a !== S.doc.body; a = a.parentElement) {
    const slide = a.hasAttribute('data-ed-slide');
    let clips = cache.get(a);
    if (clips === undefined) { const cs = S.win.getComputedStyle(a); clips = slide || /hidden|clip/.test(cs.overflowX + cs.overflowY); cache.set(a, clips); }
    if (clips) {
      const ar = a.getBoundingClientRect();
      const out = rr.bottom > ar.bottom + 2 || rr.right > ar.right + 2 || rr.top < ar.top - 2 || rr.left < ar.left - 2;
      const touches = rr.right > ar.left && rr.left < ar.right && rr.bottom > ar.top && rr.top < ar.bottom;
      if (out && touches) return a;
    }
    if (slide) break;
  }
  return null;
}
// all = every slide (on open); otherwise only the current slide, or the whole page.
function checkOverflow(all) {
  if (!S.doc || S.presenting) return;
  const cache = new Map();
  const test = root => { const bad = !!clipCulprit(root, cache); root.toggleAttribute('data-ed-overflow', bad); return bad; };
  const roots = sc => $$('[data-ed-edit]', sc).filter(isOriginal);
  if (S.mode === 'deck') {
    for (const s of all ? S.slides : [S.slides[S.cur]].filter(Boolean)) {
      const i = S.slides.indexOf(s), hidden = i !== S.cur;
      // Hidden slides are shown for the measurement only; nothing is painted in between.
      if (hidden) s.style.setProperty('display', s.dataset.edDisplay, 'important');
      const n = roots(s).filter(test).length;
      if (hidden) s.style.setProperty('display', 'none', 'important');
      el.filmstrip.children[i]?.classList.toggle('warn', n > 0);
    }
  } else roots(S.doc.body).forEach(test);
  S.overflows = $$('[data-ed-overflow]', S.doc).filter(isOriginal);
  const b = $('#sb-overflow');
  b.hidden = !S.overflows.length;
  b.textContent = '⚠ ' + t('overflow_n').replace('{n}', S.overflows.length);
}
function scheduleOverflowCheck(fromEdit) {
  clearTimeout(S.overflowTimer);
  S.overflowTimer = setTimeout(() => {
    const before = new Set(S.overflows || []);
    checkOverflow(false);
    if (fromEdit && S.overflows.some(n => !before.has(n))) toast(t('overflow_new'), { err: true, ms: 5000 });
  }, 500);
}
function nextOverflow() {
  const list = (S.overflows || []).filter(n => n.isConnected);
  if (!list.length) return;
  S.ovIdx = ((S.ovIdx ?? -1) + 1) % list.length;
  const node = list[S.ovIdx];
  if (S.mode === 'deck') {
    const k = S.slides.findIndex(s => s.contains(node));
    if (k >= 0 && k !== S.cur) showSlide(k);
  } else node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  select(node, { edit: false });
}

// ================================================================ chrome
// Page-mode frame width: 1600 by default; a width picked by hand is remembered.
const PAGE_W_KEY = 'gs9_editor_page_width';
function applyPageWidth(v, quiet) {
  S.pageW = +v;
  if (quiet) return;
  S.fit = true;
  layout();
}
function applyModeUI() {
  const deck = S.mode === 'deck';
  el.filmstrip.hidden = !deck && !S.sections.length;
  $('#sb-notes').hidden = !deck;
  $('#sb-width').hidden = deck;
  $('#page-count').hidden = !deck;
  $('#sb-prev').hidden = !deck;
  $('#sb-next').hidden = !deck;
  if (!deck) { el.notes.hidden = true; $('#sb-notes').classList.remove('on'); }
  $('#sb-notes').disabled = deck && !S.slides.some(s => $$('.notes', s).some(isOriginal));
  $('#text-hint').innerHTML = deck
    ? (S.lang === 'zh' ? '点击向当前幻灯片添加文本框。拖动悬浮栏上的<b>移动</b>手柄调整位置。' : (S.lang === 'en' ? 'Click to add text box to current slide. Drag <b>move</b> handle on floating toolbar to reposition.' : 'Nhấp để thêm hộp chữ vào slide hiện tại. Kéo nút <b>di chuyển</b> trên thanh nổi để đặt lại vị trí.'))
    : (S.lang === 'zh' ? '新文字插入在当前选定区块后（或屏幕中央的区块后）。' : (S.lang === 'en' ? 'New text is inserted after the selected block (or block in center of screen).' : 'Chữ mới được chèn ngay sau khối đang chọn (hoặc khối ở giữa màn hình).'));
}
function updateChrome() {
  const dirty = S.model ? isDirty() : false;
  const st = $('#save-state');
  let icon = '#i-cloud-ok', text = t('save_saved'), cls = '';
  if (!S.model) text = t('save_no_doc');
  else if (S.saving) { icon = '#i-cloud'; text = t('save_saving'); }
  else if (S.saveError) { icon = '#i-cloud'; text = t('save_error'); cls = 'error'; }
  else if (dirty) { icon = '#i-cloud'; text = t('save_dirty'); cls = 'dirty'; }
  st.className = 'save-state ' + cls;
  st.querySelector('use').setAttribute('href', icon);
  st.querySelector('span').textContent = text;
  $('#btn-save').classList.toggle('dirty', dirty);
  $('#btn-undo').disabled = !S.undo.length && !S.textDirty;
  $('#btn-redo').disabled = !S.redo.length;
  if (S.source) {
    const dn = $('#doc-name');
    dn.querySelector('.name').textContent = S.source.name;
    dn.title = S.source.kind === 'server' ? S.source.path : S.source.kind === 'handle' ? (S.source.name + ' (' + t('local_file') + ')') : (S.source.name + ' (' + t('download_only') + ')');
    const badge = $('#mode-badge');
    badge.hidden = false;
    badge.textContent = S.mode === 'deck' ? `${t('sb_deck')} · ${S.slides.length}` : t('sb_page');
    document.title = (dirty ? '• ' : '') + S.source.name + ' — HtmlDeck';
  }
  if (dirty && !S.saving) scheduleDraft();
  if (S.mode === 'deck' && S.slides.length) {
    $('#page-count').textContent = `${S.cur + 1} / ${S.slides.length}`;
    $('#sb-prev').disabled = S.cur === 0;
    $('#sb-next').disabled = S.cur === S.slides.length - 1;
  }
}

// ================================================================ side panel + files
function openPanel(name, keepOpen = false) {
  const panel = el.panel;
  const already = !keepOpen && panel.classList.contains('open') && panel.dataset.view === name;
  $$('.rail-item[data-panel]').forEach(b => b.classList.toggle('active', !already && b.dataset.panel === name));
  if (already) { panel.classList.remove('open'); setTimeout(layout, 220); return; }
  panel.dataset.view = name;
  $$('.panel-body', panel).forEach(b => { b.hidden = b.dataset.view !== name; });
  $('#panel-title').textContent = t('panel_' + name);
  if (name === 'layers') buildLayers();
  if (name === 'review') renderNoteList();
  panel.classList.add('open');
  if (name === 'box') { drawBoxPanel(); renderBoxPanel(); }
  if (name === 'files') { loadWorkspaceList(); setTimeout(() => $('#file-search').focus(), 60); }
  if (name === 'outline') buildOutline();
  if (name === 'effects') renderFxList();
  setTimeout(layout, 220);
}
function closePanel() {
  el.panel.classList.remove('open');
  $$('.rail-item').forEach(b => b.classList.remove('active'));
  setTimeout(layout, 220);
}
async function loadWorkspaceList() {
  try {
    const data = await api('/api/list_html');
    S.files = data.files || [];
  } catch (e) {
    $('#file-list').innerHTML = `<div class="hint">${t('error_list_files')}</div>`;
    return;
  }
  renderFileList();
}
function renderFileList() {
  const box = $('#file-list');
  const q = $('#file-search').value.trim().toLowerCase();
  const files = S.files.filter(f => !q || f.path.toLowerCase().includes(q));
  if (!files.length) { box.innerHTML = `<div class="hint">${S.files.length ? t('no_match_files') : t('empty_workspace')}</div>`; return; }
  const groups = new Map();
  for (const f of files) {
    const dir = f.path.split('/').slice(0, -1).join('/') || '.';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  box.innerHTML = '';
  for (const [dir, list] of groups) {
    const g = document.createElement('div');
    g.className = 'file-group';
    const name = document.createElement('div');
    name.className = 'file-group-name';
    name.textContent = dir;
    g.appendChild(name);
    for (const f of list) {
      const b = document.createElement('button');
      const current = S.source?.kind === 'server' && S.source.path === f.path;
      b.className = 'file-item' + (current ? ' current' : '');
      b.innerHTML = `<span class="fi-icon"><svg class="icon sm"><use href="#i-file"/></svg></span><span class="fi-text"><div class="fi-name"></div><div class="fi-meta"></div></span>`;
      b.querySelector('.fi-name').textContent = f.path.split('/').pop();
      const meta = b.querySelector('.fi-meta');
      const loc = S.lang === 'zh' ? 'zh-CN' : (S.lang === 'en' ? 'en-US' : 'vi-VN');
      meta.textContent = fmtSize(f.size) + ' · ' + new Date(f.mtime * 1000).toLocaleDateString(loc);
      if (f.size > 3 * 1048576) meta.insertAdjacentHTML('beforeend', ' · <span class="fi-heavy">' + t('file_heavy') + '</span>');
      b.title = f.path;
      b.addEventListener('click', () => openServerFile(f.path));
      g.appendChild(b);
    }
    box.appendChild(g);
  }
}

// ================================================================ keyboard
function onKey(e, fromFrame) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 's') { if (fromFrame) { e.preventDefault(); save(); } return; }   // editor side: see the capture listener in bindUI
  if (!S.doc) return;
  // The present frame has the keys; any that reach the editor meanwhile only end the session.
  if (S.present) { if (e.key === 'Escape') { e.preventDefault(); endPresent(); } return; }
  if (mod && (k === 'f' || k === 'h')) { e.preventDefault(); openFind(k === 'h'); return; }
  if (!fromFrame && isTypingTarget(e.target)) return;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (mod && e.altKey && k === 'c') { e.preventDefault(); copyStyle(); return; }
  if (mod && e.altKey && k === 'v') { e.preventDefault(); pasteStyle(); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomBy(1.15); return; }
  if (mod && k === '-') { e.preventDefault(); zoomBy(1 / 1.15); return; }
  if (mod && k === '0') { e.preventDefault(); fitZoom(); return; }
  if (mod && k === 'd' && S.sel) { e.preventDefault(); duplicateSel(); return; }
  if (mod && e.shiftKey && k === 'm') { e.preventDefault(); openNotePop(); return; }
  if (mod && !e.shiftKey && k === 'k' && S.sel) { e.preventDefault(); openLinkPop(); return; }
  if (e.key === 'Escape' && S.crop) { exitCrop(); return; }
  if (e.key === 'Escape') {
    if (!el.menu.hidden || !$('#pop-spacing').hidden || !$('#pop-opacity').hidden || !$('#pop-fx').hidden || !$('#pop-note').hidden || !$('#pop-link').hidden || !$('#pop-alt').hidden || !$('#pop-img').hidden) { closePopups(); return; }
    if (S.editing) setEditing(false); else deselect();
    return;
  }
  if (S.editing) return;
  if (S.sel) {
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); }
    else if (e.key === 'Enter' && isRoot(S.sel)) { e.preventDefault(); setEditing(true); placeCaretEnd(S.sel); }
    else if (e.altKey && (k === 'arrowup' || k === 'arrowdown')) { e.preventDefault(); nudgeOrder(k === 'arrowup' ? -1 : 1); }
    else if (k.startsWith('arrow')) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      nudge(k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0);
    }
    return;
  }
  if (S.mode === 'deck') {
    if (['arrowright', 'arrowdown', 'pagedown'].includes(k)) { e.preventDefault(); showSlide(S.cur + 1); }
    else if (['arrowleft', 'arrowup', 'pageup'].includes(k)) { e.preventDefault(); showSlide(S.cur - 1); }
  }
}
window.__edKey = onKey;
// Trusted beforeinput/input of the preview, from the frame guard's window capture listener: it
// was registered before any page script, so it runs before every page input handler. Records
// pending at beforeinput predate the edit (foreign); at input they are the browser's edit.
window.__edInput = e => {
  const ss = S.session;
  if (!ss || !S.editing || !ss.node.contains(e.target)) return;
  if (e.type === 'beforeinput') noteForeign(ss.mo.takeRecords());
  else claimOwn();
};
window.__edWheel = e => zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);

// ================================================================ UI wiring
function bindUI() {
  document.addEventListener('keydown', e => onKey(e, false));
  bindFind();
  $('#sb-overflow').addEventListener('click', nextOverflow);
  // Ctrl/Cmd+S must work from any field, including ones that stop key propagation; blur first
  // so a value typed but not yet committed (change event) is part of the save.
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (document.activeElement && document.activeElement !== document.body && document.activeElement !== el.frame) document.activeElement.blur();
      save();
    }
  }, true);
  window.addEventListener('resize', () => requestAnimationFrame(() => { layout(); layoutPresent(); }));
  window.addEventListener('pagehide', () => { writeDraft().catch(() => {}); flushRemoval(); });
  window.addEventListener('beforeunload', e => { flushPending(); if (S.model && isDirty()) { e.preventDefault(); e.returnValue = ''; } });
  el.scroller.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });
  el.scroller.addEventListener('scroll', () => { if (S.sel) positionOverlay(true); }, { passive: true });
  el.scroller.addEventListener('pointerdown', e => { if (e.target === el.scroller || e.target === el.sizer) deselect(); });

  // Keep the iframe's text selection alive while toolbar buttons are pressed.
  for (const zone of [el.ctx, el.pill, el.menu, $('#pop-spacing'), $('#pop-opacity'), $('#pop-fx'), $('#pop-note'), $('#pop-link'), $('#pop-alt'), $('#pop-img'), el.panel]) {
    zone.addEventListener('mousedown', e => { if (!e.target.closest('input, select, textarea')) e.preventDefault(); });
  }

  $$('[data-panel]').forEach(b => b.addEventListener('click', () => openPanel(b.dataset.panel)));
  $('#panel-close').addEventListener('click', closePanel);
  $('#empty-open').addEventListener('click', () => openPanel('files'));
  $('#btn-pick').addEventListener('click', pickLocalFile);
  $('#file-input').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f && confirmDiscard()) openUpload(f); });
  $('#file-search').addEventListener('input', renderFileList);
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-save').addEventListener('click', () => save());
  $('#btn-download').addEventListener('click', () => { if (!S.model) return; flushPending(); download(contentForSave().content, S.source.name); });
  $('#sb-full').addEventListener('click', togglePresent);
  $('#btn-lang').addEventListener('click', e => {
    e.stopPropagation();
    openLangMenu();
  });
  $$('#pop-lang .lang-opt').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      selectLanguage(btn.dataset.lang);
    });
  });
  window.addEventListener('click', e => {
    if (!e.target.closest('#pop-lang') && !e.target.closest('#btn-lang')) {
      const pop = $('#pop-lang');
      if (pop) pop.classList.remove('show');
    }
  });
  $('#btn-present').addEventListener('click', togglePresent);
  $('#rail-keys').addEventListener('click', () => $('#modal-keys').classList.add('show'));
  $('#sb-help').addEventListener('click', () => $('#modal-keys').classList.add('show'));
  $('#modal-keys').addEventListener('click', e => { if (e.target.id === 'modal-keys' || e.target.closest('[data-act]')) $('#modal-keys').classList.remove('show'); });

  $$('[data-preset]').forEach(b => b.addEventListener('click', () => insertText(b.dataset.preset)));
  $$('#color-target button').forEach(b => b.addEventListener('click', () => {
    S.colorTarget = b.dataset.target;
    $$('#color-target button').forEach(x => x.classList.toggle('on', x === b));
  }));
  renderSwatches($('#default-colors'), DEFAULT_COLORS, false);

  const fontSel = $('#tb-font');
  for (const [name, fb] of FONTS) {
    const o = new Option(name, name);
    o.style.fontFamily = `'${name}', ${fb}`;
    fontSel.appendChild(o);
  }
  fontSel.addEventListener('change', () => applyFont(fontSel.value));
  $('#tb-size-dn').addEventListener('click', () => setFontSize((parseFloat($('#tb-size').value) || 16) - 1));
  $('#tb-size-up').addEventListener('click', () => setFontSize((parseFloat($('#tb-size').value) || 16) + 1));
  $('#tb-size').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setFontSize(parseFloat(e.target.value)); } e.stopPropagation(); });
  $('#tb-size').addEventListener('change', e => setFontSize(parseFloat(e.target.value)));
  $('#tb-color').addEventListener('click', () => { S.colorTarget = 'text'; $$('#color-target button').forEach(x => x.classList.toggle('on', x.dataset.target === 'text')); if (!el.panel.classList.contains('open') || el.panel.dataset.view !== 'colors') openPanel('colors'); });
  $('#tb-bold').addEventListener('click', () => toggleStyle('bold'));
  $('#tb-italic').addEventListener('click', () => toggleStyle('italic'));
  $('#tb-underline').addEventListener('click', () => toggleStyle('underline'));
  $('#tb-strike').addEventListener('click', () => toggleStyle('strikeThrough'));
  $('#tb-case').addEventListener('click', toggleCase);
  $('#tb-align').addEventListener('click', cycleAlign);
  $('#tb-clear').addEventListener('click', clearStyle);
  $('#tb-spacing').addEventListener('click', e => togglePop('#pop-spacing', e.currentTarget));
  $('#tb-opacity').addEventListener('click', e => togglePop('#pop-opacity', e.currentTarget));
  $('#tb-fx').addEventListener('click', e => openFxPop(e.currentTarget));
  for (const id of ['#fx-preset', '#fx-delay', '#fx-dur', '#fx-stagger']) $(id).addEventListener('change', applyFx);
  for (const id of ['#fx-delay', '#fx-dur', '#fx-stagger']) $(id).addEventListener('keydown', e => e.stopPropagation());
  $('#fx-preview').addEventListener('click', previewFx);
  $('#fx-doc-btn').addEventListener('click', fxDocAction);
  $('#fx-play-slide').addEventListener('click', previewSlideFx);
  $('#sb-trust').addEventListener('click', () => {
    if (S.mountedTrust) setTrust(false);
    else if (confirm(t('trust_confirm'))) setTrust(true);
  });
  $('#ls-range').addEventListener('input', e => { $('#ls-out').textContent = e.target.value; if (S.sel) styleEdit(S.sel, { 'letter-spacing': (e.target.value / 1000) + 'em' }, 'ls'); });
  $('#lh-range').addEventListener('input', e => { $('#lh-out').textContent = e.target.value; if (S.sel) styleEdit(S.sel, { 'line-height': e.target.value }, 'lh'); });
  $('#op-range').addEventListener('input', e => { $('#op-out').textContent = e.target.value; if (S.sel) styleEdit(S.sel, { opacity: String(e.target.value / 100) }, 'op'); });

  $$('[data-h]', el.box).forEach(h => h.addEventListener('pointerdown', e => startDrag(h.dataset.h, e)));
  $('[data-h="move"]', el.pill).addEventListener('pointerdown', e => startDrag('move', e));
  $('#pill-dup').addEventListener('click', duplicateSel);
  $('#pill-del').addEventListener('click', deleteSel);
  $('#pill-more').addEventListener('click', () => {
    const open = el.menu.hidden;
    closePopups();
    if (!open) return;
    $$('.img-menu', el.menu).forEach(b => { b.hidden = !selectedImg(); });
    el.menu.hidden = false;
    placeMenu();
  });
  $('#m-up').addEventListener('click', () => { el.menu.hidden = true; nudgeOrder(-1); });
  $('#m-down').addEventListener('click', () => { el.menu.hidden = true; nudgeOrder(1); });
  $('#m-copy-style').addEventListener('click', () => { el.menu.hidden = true; copyStyle(); });
  $('#m-paste-style').addEventListener('click', () => { el.menu.hidden = true; pasteStyle(); });
  $('#m-clear').addEventListener('click', () => { el.menu.hidden = true; clearStyle(); });

  $('#zoom').addEventListener('input', e => setZoom(+e.target.value));
  $('#zoom-pct').addEventListener('click', fitZoom);
  $('#sb-fit').addEventListener('click', fitZoom);
  $('#sb-prev').addEventListener('click', () => showSlide(S.cur - 1));
  $('#sb-next').addEventListener('click', () => showSlide(S.cur + 1));
  $('#sb-mode').addEventListener('change', async e => {
    const prev = S.forceMode;
    S.forceMode = e.target.value === 'auto' ? null : e.target.value;
    if (!(await rerender())) { S.forceMode = prev; e.target.value = prev || 'auto'; }
    else storeMode(S.source, S.forceMode);
  });
  $('#pill-note').addEventListener('click', () => openNotePop());
  $('#tb-link').addEventListener('click', openLinkPop);
  $('#tb-img-replace').addEventListener('click', openImagePop);
  $('#tb-img-crop').addEventListener('click', enterCrop);
  $('#crop-cover').addEventListener('click', () => setFit('cover'));
  $('#crop-contain').addEventListener('click', () => setFit('contain'));
  $('#crop-done').addEventListener('click', exitCrop);
  el.box.addEventListener('pointerdown', e => { if (S.crop && !e.target.closest('.hd')) startCropDrag(e); });
  $('#tb-box').addEventListener('click', () => openPanel('box', true));
  bindBoxPanel();
  $('#alt-apply').addEventListener('click', applyAlt);
  $('#alt-cancel').addEventListener('click', () => { $('#pop-alt').hidden = true; });
  $('#alt-input').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); applyAlt(); } if (e.key === 'Escape') $('#pop-alt').hidden = true; });
  $('#img-upload').addEventListener('click', () => { $('#pop-img').hidden = true; $('#img-input').click(); });
  $('#img-input').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) replaceWithFile(selectedImg(), f); });
  $('#img-url-apply').addEventListener('click', () => {
    const v = normalizeImageURL($('#img-url').value);
    if (v === null) return toast('Link ảnh không hợp lệ', { err: true });
    if (v) { $('#pop-img').hidden = true; replaceImage(selectedImg(), v); }
  });
  $('#img-url').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') $('#img-url-apply').click(); });
  $('#pill-parent').addEventListener('click', selectParent);
  $('#m-alt').addEventListener('click', () => { el.menu.hidden = true; openAltPop(); });
  $('#m-flip').addEventListener('click', () => { el.menu.hidden = true; flipImage(); });
  $('#m-img-reset').addEventListener('click', () => { el.menu.hidden = true; resetImage(); });
  $('#link-apply').addEventListener('click', applyLink);
  $('#link-remove').addEventListener('click', removeLink);
  $('#link-cancel').addEventListener('click', () => { $('#pop-link').hidden = true; });
  $('#link-url').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); applyLink(); } if (e.key === 'Escape') $('#pop-link').hidden = true; });
  const tree = $('#layer-tree');
  bindLayerDrag();
  tree.addEventListener('click', e => {
    const row = e.target.closest('.layer-row');
    if (!row || Date.now() - (S.layerDragEnded || 0) < 250) return;
    const id = row.dataset.id;
    if (e.target.closest('.tg')) {
      S.layerOpen.has(id) ? S.layerOpen.delete(id) : S.layerOpen.add(id);
      buildLayers();
      return;
    }
    const node = layerNode(row);
    if (!node) return;
    if (S.mode === 'page') node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    select(node, { edit: false });
  });
  tree.addEventListener('mouseover', e => showHoverBox(layerNode(e.target.closest('.layer-row'))));
  tree.addEventListener('mouseleave', () => showHoverBox(null));
  $('#note-save').addEventListener('click', addNoteFromPop);
  $('#fb-copy').addEventListener('click', copyFeedbackRequest);
  $('#fb-slide').addEventListener('click', () => openNotePop(S.mode === 'deck' ? S.slides[S.cur] : S.sections[S.cur]));
  $('#fb-filter').addEventListener('click', e => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (!f || f === S.noteFilter) return;
    S.noteFilter = f;
    renderNoteList();
    renderPins();
  });
  $('#note-cancel').addEventListener('click', () => { $('#pop-note').hidden = true; });
  $('#note-input').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addNoteFromPop(); if (e.key === 'Escape') $('#pop-note').hidden = true; });
  $('#agent-cmd-copy').addEventListener('click', () => navigator.clipboard?.writeText($('#agent-cmd').textContent).then(() => toast('Đã sao chép lệnh')));
  $('#sb-width').addEventListener('change', e => {
    try { localStorage.setItem(PAGE_W_KEY, e.target.value); } catch {}
    applyPageWidth(e.target.value);
  });
  let savedW = '1600';
  try { savedW = localStorage.getItem(PAGE_W_KEY) || '1600'; } catch {}
  if (![...$('#sb-width').options].some(o => o.value === savedW)) savedW = '1600';
  $('#sb-width').value = savedW;
  applyPageWidth(savedW, true);
  $('#sb-notes').addEventListener('click', () => {
    el.notes.hidden = !el.notes.hidden;
    $('#sb-notes').classList.toggle('on', !el.notes.hidden);
    if (!el.notes.hidden) loadNotes();
    requestAnimationFrame(layout);
  });
  $('#notes-close').addEventListener('click', () => $('#sb-notes').click());
  el.notesText.addEventListener('input', () => { clearTimeout(S.notesTimer); S.notesTimer = setTimeout(() => { S.notesTimer = 0; saveNotes(); }, 400); });
  el.notesText.addEventListener('blur', flushPending);

  // Drag & drop a file anywhere to open it (keeps a writable handle where supported).
  let dragDepth = 0;
  const draggingImage = e => [...(e.dataTransfer?.items || [])].some(i => i.kind === 'file' && i.type.startsWith('image/'));
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files') && !draggingImage(e)) { dragDepth++; $('#drop-veil').classList.add('show'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-veil').classList.remove('show'); } });
  window.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async e => {
    dragDepth = 0;
    $('#drop-veil').classList.remove('show');
    const item = [...(e.dataTransfer?.items || [])].find(i => i.kind === 'file');
    if (!item) return;
    e.preventDefault();
    const handlePromise = item.getAsFileSystemHandle?.();
    const file = item.getAsFile();
    if (file && file.type.startsWith('image/')) return selectedImg() ? replaceWithFile(selectedImg(), file) : toast('Chọn một ảnh trên trang rồi thả ảnh mới vào');
    if (!file || !/\.html?$/i.test(file.name)) return toast('Chỉ mở được file .html / .htm', { err: true });
    if (!confirmDiscard()) return;
    const handle = handlePromise ? await handlePromise.catch(() => null) : null;
    if (handle && handle.kind === 'file') { setLoading(true); openFromHandle(handle).catch(err => { setLoading(false); toast(err.message, { err: true }); }); }
    else openUpload(file);
  });
}

async function boot() {
  bindUI();
  applyLanguage(S.lang);
  requestAnimationFrame(pinLoop);
  buildOutline();
  updateChrome();
  let cfg = {};
  try { cfg = await api('/api/config'); }
  catch (e) { if (e.status === 404) toast('Server đang chạy là bản cũ — tắt (Ctrl+C) rồi chạy lại htmldeck', { err: true, ms: 10000 }); }
  // Presenting runs on this second origin (no API there); the editor's own origin otherwise.
  S.previewOrigin = cfg.preview_origin || location.origin;
  loadWorkspaceList();
  // ?file= wins, then an explicit --file, then the last file opened here, then the server default.
  let last = null;
  try { last = localStorage.getItem(LAST_FILE_KEY); } catch {}
  // Test hook, only when the server runs with --test-hooks: the next batch undo/redo fails
  // after its first sub-op, to exercise recovery.
  const fault = cfg.test_hooks && new URLSearchParams(location.search).get('htmldeck-fault');
  if (fault === 'step' || fault === 'single') S.faultNextStep = fault;
  const path = new URLSearchParams(location.search).get('file') || (cfg.explicit ? cfg.default_path : last || cfg.default_path);
  if (!path) return openPanel('files');
  if (await openServerFile(path)) return;
  if (path === last) try { localStorage.removeItem(LAST_FILE_KEY); } catch {}
  if (path === last && cfg.default_path && cfg.default_path !== last && await openServerFile(cfg.default_path)) return;
  openPanel('files');
}
boot();
