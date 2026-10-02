// Stateless helpers shared by every HtmlDeck module.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function escapeHTML(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
export function rgbToHex(rgb) {
  const m = String(rgb).match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[, /]+([\d.]+))?/);
  if (!m || (m[4] !== undefined && +m[4] === 0)) return null;
  return '#' + [m[1], m[2], m[3]].map(v => Math.round(+v).toString(16).padStart(2, '0')).join('');
}
export function parseTranslate(v) {
  const m = String(v || '').match(/(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?/);
  return m ? [parseFloat(m[1]), parseFloat(m[2] || 0)] : [0, 0];
}
export function isTypingTarget(t) { return t && (t.closest?.('input, textarea, select') || t.isContentEditable); }
// Cheap 53-bit string hash (cyrb53): only tells "same file text" from "different".
export function textHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
