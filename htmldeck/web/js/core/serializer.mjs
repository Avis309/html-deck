// Saving: splice only the changed ranges into the source text (minimal diff), proven by
// re-parsing; otherwise a full re-serialisation that the caller must confirm.
// Input is the document state `st` = { sourceText, pristine, model, touched, touchedInFlight,
// saving, prologue, epilogue }. No UI, no live DOM, no network.
import { modelEl } from './model.mjs';

// ---------------------------------------------------------------- minimal-diff save
// Re-serialising the whole DOM rewrites every `/>`, `&` and boolean attribute in the file.
// Instead, locate each changed element in the original text and splice only that range,
// then prove the result parses to exactly the edited model; otherwise fall back.
export const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param', 'keygen']);
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'template']);
const IMPLIED_TAGS = new Set(['html', 'head', 'body', 'tbody', 'colgroup']);
export function tokenize(src) {
  const out = [], stack = [], lower = src.toLowerCase(), n = src.length;
  const START = /<([a-zA-Z][^\s/>]*)/y, END = /<\/([a-zA-Z][^\s/>]*)[^>]*>/y;
  let i = 0, foreign = 0;
  while (i < n) {
    i = src.indexOf('<', i);
    if (i < 0) break;
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e < 0 ? n : e + 3; continue; }
    if (src[i + 1] === '!' || src[i + 1] === '?') { const e = src.indexOf('>', i); i = e < 0 ? n : e + 1; continue; }
    if (src[i + 1] === '/') {
      END.lastIndex = i;
      const m = END.exec(src);
      if (!m) { i++; continue; }
      const name = m[1].toLowerCase();
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== name) k--;
      if (k >= 0) {
        for (let q = stack.length - 1; q > k; q--) stack[q].closeStart = stack[q].end = i;
        stack[k].closeStart = i;
        stack[k].end = END.lastIndex;
        stack.length = k;
        foreign = stack.filter(t => t.name === 'svg' || t.name === 'math').length;
      }
      i = END.lastIndex;
      continue;
    }
    START.lastIndex = i;
    const m = START.exec(src);
    if (!m) { i++; continue; }
    let j = START.lastIndex, selfClose = false;
    while (j < n) {
      const c = src[j];
      if (c === '>') break;
      if (c === '/' && src[j + 1] === '>') { selfClose = true; j++; break; }
      if (c === '"' || c === "'") { const e = src.indexOf(c, j + 1); j = e < 0 ? n : e + 1; continue; }
      j++;
    }
    const tok = { name: m[1].toLowerCase(), start: i, openEnd: j + 1, closeStart: null, end: null };
    out.push(tok);
    i = tok.openEnd;
    if ((!foreign && VOID_TAGS.has(tok.name)) || (foreign && selfClose)) { tok.closeStart = tok.end = tok.openEnd; continue; }
    if (!foreign && RAW_TAGS.has(tok.name)) {
      const k = lower.indexOf('</' + tok.name, tok.openEnd);
      tok.closeStart = k < 0 ? n : k;
      const e = k < 0 ? -1 : src.indexOf('>', k);
      tok.end = e < 0 ? n : e + 1;
      i = tok.end;
      continue;
    }
    stack.push(tok);
    if (tok.name === 'svg' || tok.name === 'math') foreign++;
  }
  for (const t of stack) t.closeStart = t.end = n;
  return out;
}
// Elements the HTML parser creates without a start tag in the source: a stray `</p>` becomes an
// empty <p>, a `</br>` becomes a <br>. They have no source range (no token): a change that
// would have to patch inside one falls back to the enclosing range, and every result is still
// proven by re-parsing.
function impliedByStrayEndTag(node) {
  const name = node.localName;
  if (name !== 'p' && name !== 'br') return false;
  return !node.firstChild && [...node.attributes].every(a => a.name === 'data-ed-id');
}
export function alignTokens(tokens, pristine) {
  const map = new Map();
  let j = 0;
  for (const node of pristine.querySelectorAll('*')) {
    const name = node.localName.toLowerCase();
    const tok = tokens[j];
    // An empty implied <p> right before a real one: the real one's token has content.
    const implied = impliedByStrayEndTag(node) && !(tok && tok.name === name && tok.closeStart <= tok.openEnd);
    if (tok && tok.name === name && !implied) { map.set(node.getAttribute('data-ed-id'), tokens[j++]); continue; }
    if (IMPLIED_TAGS.has(name) || implied) continue;
    return null;
  }
  return j === tokens.length ? map : null;
}
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
export function escAttr(v) { return v.replace(/&/g, '&amp;').replace(/\u00a0/g, '&nbsp;').replace(/"/g, '&quot;'); }
export function startTag(node) {
  let out = '<' + (node.namespaceURI === XHTML_NS ? node.localName : node.tagName);
  for (const a of node.attributes) if (a.name !== 'data-ed-id') out += ` ${a.name}="${escAttr(a.value)}"`;
  return out + '>';
}
export function attrsKey(node) { return [...node.attributes].filter(a => a.name !== 'data-ed-id').map(a => a.name + '=' + a.value).join('\u0001'); }
export function stripIds(node) {
  const c = node.cloneNode(true);
  if (c.removeAttribute) c.removeAttribute('data-ed-id');
  if (c.querySelectorAll) for (const n of c.querySelectorAll('[data-ed-id]')) n.removeAttribute('data-ed-id');
  return c;
}
const nodeId = n => n.nodeType === 1 ? n.getAttribute('data-ed-id') : null;
// Every model mutation touches the element it changed, so any difference inside `node`
// is accounted for when node itself or one of its descendants is in the touched set.
function coversTouched(node, touched) {
  for (const id of touched) if (nodeId(node) === id || node.querySelector(`[data-ed-id="${id}"]`)) return true;
  return false;
}
// Express a parent's change as element insertions/removals between untouched siblings.
// Children that kept their relative order: the longest increasing subsequence of their old
// positions, read in the new order (O(n log n), so a body with thousands of children is fine).
function keptOrder(oldOrder, newOrder) {
  const pos = new Map(oldOrder.map((id, i) => [id, i]));
  const seq = newOrder.map(id => pos.get(id));
  const tails = [], tailIdx = [], prev = new Array(seq.length).fill(-1);
  seq.forEach((v, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v; tailIdx[lo] = i;
    prev[i] = lo ? tailIdx[lo - 1] : -1;
  });
  const keep = new Set();
  for (let i = tailIdx[tails.length - 1] ?? -1; i >= 0; i = prev[i]) keep.add(newOrder[i]);
  return keep;
}
function childSplices(st, p, m, map, ptok) {
  const pc = [...p.childNodes], mc = [...m.childNodes], patches = [];
  const pEl = pc.map(nodeId).filter(Boolean), mEl = mc.map(nodeId).filter(Boolean);
  const pSet = new Set(pEl), mSet = new Set(mEl);
  // Children present in both but out of order were moved: splice them out and back in.
  const common = pEl.filter(id => mSet.has(id)), keep = keptOrder(common, mEl.filter(id => pSet.has(id)));
  const moved = new Set(common.filter(id => !keep.has(id)));
  const pIds = new Set(pEl.filter(id => !moved.has(id)));
  const mIds = new Set(mEl.filter(id => !moved.has(id)));
  let i = 0, j = 0, pos = ptok.openEnd;
  const afterText = k => { for (let q = k + 1; q < pc.length; q++) if (pc[q].nodeType === 1) return map.get(nodeId(pc[q]))?.start ?? null; return ptok.closeStart; };
  while (i < pc.length || j < mc.length) {
    const a = pc[i], b = mc[j];
    if (a && b && a.nodeType === 1 && b.nodeType === 1 && nodeId(a) === nodeId(b) && !moved.has(nodeId(a))) {
      const t = map.get(nodeId(a));
      if (!t) return null;
      // A kept child must be unchanged, or contain the touched element that patches it.
      if (a.outerHTML !== b.outerHTML && !coversTouched(b, st.touched)) return null;
      pos = t.end; i++; j++;
    } else if (b && b.nodeType === 1 && !pIds.has(nodeId(b))) {
      // An original moved here unchanged keeps its exact bytes from the source file.
      const t = map.get(nodeId(b));
      const text = t && t.end > t.start && !coversTouched(b, st.touched) ? st.sourceText.slice(t.start, t.end) : stripIds(b).outerHTML;
      patches.push({ s: pos, e: pos, text, order: j });
      j++;
    } else if (a && a.nodeType === 1 && !mIds.has(nodeId(a))) {
      const t = map.get(nodeId(a));
      if (!t) return null;
      patches.push({ s: t.start, e: t.end, text: '' });
      pos = t.end; i++;
    } else if (a && b && a.nodeType !== 1 && a.nodeType === b.nodeType && a.nodeValue === b.nodeValue) {
      const next = afterText(i);
      if (next == null) return null;
      pos = next; i++; j++;
    } else return null;
  }
  return patches;
}
export function minimalSerialize(st) {
  if (st.sourceText == null || !st.pristine) return null;
  const map = alignTokens(tokenize(st.sourceText), st.pristine);
  if (!map) return null;
  let patches = [];
  for (const id of st.touched) {
    const p = st.pristine.querySelector(`[data-ed-id="${id}"]`), m = modelEl(st, id);
    if (!p || !m) continue;
    const tok = map.get(id);
    if (!tok) return null;
    if (attrsKey(p) !== attrsKey(m)) patches.push({ s: tok.start, e: tok.openEnd, text: startTag(m) });
    if (p.innerHTML !== m.innerHTML) {
      const splices = childSplices(st, p, m, map, tok);
      if (splices) patches.push(...splices);
      else if (tok.closeStart >= tok.openEnd) patches.push({ s: tok.openEnd, e: tok.closeStart, text: stripIds(m).innerHTML, inner: true });
      else return null;
    }
  }
  // Drop patches swallowed by a whole-range rewrite (inner replace or element removal).
  const covers = patches.filter(x => x.inner || (x.e > x.s && x.text === ''));
  patches = patches.filter(x => !covers.some(c => c !== x && x.s >= c.s && x.e <= c.e && (x.s > c.s || x.e < c.e || x.e === x.s)));
  patches.sort((a, b) => b.s - a.s || (b.e - b.s) - (a.e - a.s) || (b.order ?? 0) - (a.order ?? 0));
  for (let k = 1; k < patches.length; k++) if (patches[k].e > patches[k - 1].s) return null;
  let out = st.sourceText;
  for (const x of patches) out = out.slice(0, x.s) + x.text + out.slice(x.e);
  const check = new DOMParser().parseFromString(out, 'text/html');
  return check.documentElement.outerHTML === stripIds(st.model.documentElement).outerHTML ? out : null;
}
export function contentForSave(st) {
  // During a save, the ids handed to the request (touchedInFlight) still differ from pristine.
  if (st.touchedInFlight?.size) st = { ...st, touched: new Set([...st.touchedInFlight, ...st.touched]) };
  // Nothing touched since the text was loaded or saved: that text is the document, byte for byte
  // (even when it could not be patched in place and an edit would need a full rewrite).
  if (!st.touched.size && !st.saving && st.sourceText != null) return { content: st.sourceText, minimal: true };
  const minimal = minimalSerialize(st);
  if (minimal != null) return { content: minimal, minimal: true };
  // Touched but back to the loaded state (edit then undo): the source text is still exact.
  // Compared only here, after patching failed, so the usual path pays nothing for it.
  if (!st.saving && st.sourceText != null && st.pristine && st.model.documentElement.outerHTML === st.pristine.documentElement.outerHTML) {
    return { content: st.sourceText, minimal: true };
  }
  return { content: serialize(st), minimal: false };
}
export function serialize(st) {
  const root = st.model.documentElement.cloneNode(true);
  root.removeAttribute('data-ed-id');
  for (const n of root.querySelectorAll('[data-ed-id]')) n.removeAttribute('data-ed-id');
  return (st.prologue ? st.prologue + '\n' : '') + root.outerHTML + (st.epilogue ? '\n' + st.epilogue : '');
}
