// The document "Download → PDF" prints: a clone of the model where each slide is one page of the
// deck's own size, in order, with motion off so every slide shows its final state. Scripts are
// removed: the authored markup is what gets printed (a deck's static HTML is its end state), and
// the clone is staged on the editor's origin. A page (not a deck) prints as the browser lays it out.
import { neuterScripts } from '../core/sanitize.mjs';

function printCSS(mode, w, h, displays, slideIds) {
  const common = `
html { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
*, *::before, *::after { animation: none !important; transition: none !important; }`;
  if (mode !== 'deck') return common;
  return common + `
@page { size: ${w}px ${h}px; margin: 0; }
html, body { margin: 0 !important; padding: 0 !important; width: ${w}px !important; min-width: 0 !important; height: auto !important; min-height: 0 !important; overflow: visible !important; background: #fff !important; }
body *:not([data-ed-slide]):not([data-ed-slide-anc]):not([data-ed-slide] *) { display: none !important; }
[data-ed-slide-anc] { display: block !important; position: static !important; inset: auto !important; width: auto !important; height: auto !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important;
  overflow: visible !important; transform: none !important; translate: none !important; scale: none !important; rotate: none !important; filter: none !important; contain: none !important; }
[data-ed-slide] { position: relative !important; inset: auto !important; width: ${w}px !important; height: ${h}px !important; min-height: 0 !important; max-height: none !important; margin: 0 !important;
  transform: none !important; translate: none !important; scale: none !important; overflow: hidden !important; visibility: visible !important; opacity: 1 !important;
  box-shadow: none !important; border-radius: 0 !important; break-after: page; page-break-after: always; break-inside: avoid; }
[data-ed-slide][data-ed-last] { break-after: auto; page-break-after: auto; }` + slideIds.map((id, i) =>
    `\n[data-ed-slide][data-ed-id="${id}"] { display: ${/^[a-z-]+$/.test(displays[i] || '') && displays[i] !== 'none' ? displays[i] : 'block'} !important; }`).join('');
}

// opts: { mode: 'deck'|'page', slideIds, displays, deckW, deckH, extraCSS, bodyClass, title }
export function renderPrintHTML(model, doctype, opts) {
  const { mode, slideIds = [], displays = [], deckW, deckH, extraCSS = '', bodyClass = '', title = '' } = opts;
  const root = model.documentElement.cloneNode(true);
  neuterScripts(root);
  if (mode === 'deck') {
    slideIds.forEach((id, i) => {
      const s = root.querySelector(`[data-ed-id="${id}"]`);
      if (!s) throw new Error(`slide ${id} is not in the model`);
      s.setAttribute('data-ed-slide', '');
      if (i === slideIds.length - 1) s.setAttribute('data-ed-last', '');
      for (let n = s.parentElement; n && n !== root; n = n.parentElement) n.setAttribute('data-ed-slide-anc', '');
    });
  }
  const style = model.createElement('style');
  style.textContent = extraCSS + printCSS(mode, deckW, deckH, displays, slideIds);
  root.querySelector('head').appendChild(style);
  // The PDF's default file name is the page title.
  if (title) {
    let t = root.querySelector('head > title');
    if (!t) { t = model.createElement('title'); root.querySelector('head').prepend(t); }
    t.textContent = title;
  }
  if (bodyClass) root.querySelector('body').classList.add(...bodyClass.split(/\s+/).filter(Boolean));
  return (doctype || '<!DOCTYPE html>') + '\n' + root.outerHTML;
}
