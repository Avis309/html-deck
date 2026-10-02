// Reveal.js (authored HTML) adapter: structure, edit-preview bootstrap and CSS, and the
// per-node flags the edit policy needs. Pure functions over a document or model; no editor state.

export const REVEAL_DEFAULT = { width: 960, height: 700, center: true };

export function slidesRoot(root) {
  return root.querySelector('.reveal > .slides') || root.querySelector('.reveal .slides');
}

const sectionKids = n => [...n.children].filter(c => c.localName === 'section');
const isHidden = n => (n.getAttribute('data-visibility') || '') === 'hidden';

// Leaf slides in authored order. A top-level section with child sections is a vertical stack
// (not a slide itself); its children are the leaves. h/v are authored positions only: Reveal
// drops hidden slides at runtime, so runtime indices are looked up in the present frame.
export function leaves(root) {
  const slides = slidesRoot(root);
  if (!slides) return [];
  const out = [];
  let h = 0;
  for (const s of sectionKids(slides)) {
    const kids = sectionKids(s);
    if (kids.length) kids.forEach((c, v) => out.push({ el: c, h, v, stack: s, hidden: isHidden(s) || isHidden(c) }));
    else out.push({ el: s, h, v: 0, stack: null, hidden: isHidden(s) });
    h++;
  }
  return out;
}

export function isReveal(root) {
  const slides = slidesRoot(root);
  return !!slides && sectionKids(slides).length > 0;
}

// Scripts that would start Reveal: a classic bundle can be intercepted, a module cannot.
export function runtimeEvidence(model) {
  let classic = false, module = false;
  for (const s of model.querySelectorAll('script')) {
    const src = s.getAttribute('src') || '', text = s.textContent || '';
    const mentions = /reveal(\.min)?(\.esm)?\.js/i.test(src) || /\bReveal\b/.test(text) || /reveal(\.esm)?\.js/i.test(text);
    if (!mentions) continue;
    if ((s.getAttribute('type') || '').trim().toLowerCase() === 'module') module = true; else classic = true;
  }
  return { classic, module };
}

// Runs in the edit preview before any document script. The UMD bundle assigns window.Reveal:
// the setter swaps initialize/configure for recorders, so the deck never initialises (and never
// rewrites the DOM) while being edited. initialize returns a promise that never settles, so code
// chained on it (Reveal.slide…) does not run against an uninitialised Reveal either.
export const EDIT_BOOTSTRAP = `(function(){
var st=window.__htmldeckReveal={intercepted:false,initCalls:0,config:null};var real;
function pick(c){var o={};if(c)['width','height','center','margin'].forEach(function(k){if(k in c)o[k]=c[k];});return o;}
function wrap(R){if(!R||typeof R.initialize!=='function'||R.__htmldeckWrapped)return R;
try{R.initialize=function(c){st.initCalls++;var p=pick(c);st.config=st.config||{};for(var k in p)st.config[k]=p[k];return new Promise(function(){});};
R.configure=function(c){var p=pick(c);st.config=st.config||{};for(var k in p)st.config[k]=p[k];};
R.__htmldeckWrapped=true;st.intercepted=true;}catch(e){}return R;}
try{Object.defineProperty(window,'Reveal',{configurable:true,enumerable:true,get:function(){return real;},set:function(v){real=wrap(v);}});}catch(e){}
})();`;

// Slide size from the recorded config; percentages (or anything not a positive number) are
// not supported for editing: the caller warns and falls back to the Reveal default.
export function slideSize(config) {
  const w = config && config.width, h = config && config.height;
  const num = v => typeof v === 'number' ? v : (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? parseFloat(v) : NaN);
  const W = num(w), H = num(h);
  const given = w != null || h != null;
  const ok = (w == null || W > 0) && (h == null || H > 0);
  return {
    width: W > 0 ? W : REVEAL_DEFAULT.width,
    height: H > 0 ? H : REVEAL_DEFAULT.height,
    center: config && 'center' in config ? !!config.center : REVEAL_DEFAULT.center,
    unsupported: given && !ok,
  };
}

// Edit/thumbnail CSS on top of the shared deck CSS: Reveal hides sections and fragments until
// its runtime shows them; here every fragment of the current slide is visible, the stack that
// holds it is displayed, and slides sit at the top offset --ed-top (vertical centring is
// measured by the editor, since the content height decides it).
export function editCSS() {
  return `
html.ed-deck .reveal .slides section[data-ed-slide-anc] { display: block !important; }
html.ed-deck .reveal .slides section[data-ed-slide] { height: auto !important; min-height: 0 !important; top: var(--ed-top, 0px) !important; padding-top: 0; pointer-events: auto !important; }
html.ed-deck .reveal .slides section .fragment { opacity: 1 !important; visibility: inherit !important; transform: none !important; }`;
}

const cssStr = v => '"' + String(v).replace(/[\\"\n\r]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ') + '"';
const SAFE_VALUE = /^[#\w\s.,%()-]+$/;

// data-background-* shown (never written) in the edit preview: one rule per slide, applied to
// the .reveal box while that slide is the current one (`cur`: .ed-cur in edit, [data-ed-cur]
// in a static present).
export function backgroundCSS(list, cur = '.ed-cur') {
  let css = '';
  for (const { el } of list) {
    const id = el.getAttribute('data-ed-id');
    if (!id) continue;
    const decl = [];
    const color = el.getAttribute('data-background-color') || (/^#|^rgb|^hsl|^[a-z]+$/i.test(el.getAttribute('data-background') || '') ? el.getAttribute('data-background') : '');
    if (color && SAFE_VALUE.test(color)) decl.push(`background-color: ${color} !important`);
    const img = el.getAttribute('data-background-image');
    if (img) {
      decl.push(`background-image: url(${cssStr(img)}) !important`);
      const size = el.getAttribute('data-background-size') || 'cover', pos = el.getAttribute('data-background-position') || 'center';
      if (SAFE_VALUE.test(size)) decl.push(`background-size: ${size} !important`);
      if (SAFE_VALUE.test(pos)) decl.push(`background-position: ${pos} !important`);
      decl.push('background-repeat: no-repeat !important');
    }
    if (decl.length) css += `\nhtml:has([data-ed-id="${id}"]${cur}) .reveal { ${decl.join('; ')}; }`;
  }
  return css;
}

// Signs that Reveal's runtime has run on this DOM (not intercepted): classes it adds on init.
export function runtimeRan(root) {
  const reveal = root.querySelector('.reveal');
  if (!reveal) return false;
  if (reveal.classList.contains('ready')) return true;
  const slides = slidesRoot(root);
  return !!slides && !!slides.querySelector(':scope > section.present, :scope > section.past, :scope > section.future, :scope > section > section.present');
}

// Facts about a live node for the edit policy (plain data).
export function nodeFlags(node) {
  if (!node || !node.closest) return {};
  const autoSlide = node.closest('section[data-auto-animate]');
  return {
    markdown: !!node.closest('section[data-markdown]') || !!node.querySelector?.('section[data-markdown]'),
    autoAnimateId: !!autoSlide && (node.hasAttribute('data-id') || !!node.querySelector('[data-id]')),
    rStack: !!node.closest('.r-stack') || !!node.querySelector('.r-stack'),
    // As a drop target only the node's own position counts (a slide holding a stack elsewhere is fine).
    inRStack: !!node.closest('.r-stack'),
    inMarkdown: !!node.closest('section[data-markdown]'),
    // Reveal owns opacity/visibility of fragments (and of whatever holds one).
    fragment: !!node.closest('.fragment') || !!node.querySelector('.fragment'),
    section: node.localName === 'section' && !!node.closest('.reveal .slides'),
  };
}
