// Document operations, applied to the model and to the rendered iframe together.
// `live` adapts the iframe: { el(id), sync(liveNode, modelNode), adopt(l, m), refresh(l) }.
// Ops: html | style | attrs | move | insert | remove | batch, each with before/after.
import { modelEl, touchOp } from './model.mjs';

export function setStyleAttr(node, v) {
  if (!node) return;
  if (v == null || v === '') node.removeAttribute('style'); else node.setAttribute('style', v);
}
export function setAttrs(n, map) {
  if (!n) return;
  for (const [name, v] of Object.entries(map)) { if (v == null) n.removeAttribute(name); else n.setAttribute(name, v); }
}
export function placeAt(n, parent, ref) { parent.insertBefore(n, ref && ref.parentNode === parent ? ref : null); }
export function nodeRefs(m, l) {
  return { m, mParent: m.parentNode, mNext: m.nextSibling, l, lParent: l.parentNode, lNext: l.nextSibling };
}
export function doInsert(op, live) {
  op.mParent.insertBefore(op.m, op.mNext && op.mNext.parentNode === op.mParent ? op.mNext : null);
  op.lParent.insertBefore(op.l, op.lNext && op.lNext.parentNode === op.lParent ? op.lNext : null);
  live.adopt(op.l, op.m);
}
export function doRemove(op) { op.m.remove(); op.l.remove(); }
export function applyMove(op, redo, live) {
  const t = redo ? op.to : op.from;
  placeAt(op.m, t.mP, t.mN);
  placeAt(op.l, t.lP, t.lN);
  live.refresh(op.l);
  return op.l;
}
export function applyOp(st, op, redo, live) {
  touchOp(st, op);
  switch (op.type) {
    case 'html': {
      const v = redo ? op.after : op.before, m = modelEl(st, op.id), l = live.el(op.id);
      if (m) m.innerHTML = v;
      if (l) { l.innerHTML = v; live.sync(l, m); }
      return l;
    }
    case 'style': {
      const v = redo ? op.after : op.before, l = live.el(op.id);
      setStyleAttr(modelEl(st, op.id), v);
      setStyleAttr(l, v);
      return l;
    }
    case 'attrs': {
      const l = live.el(op.id);
      setAttrs(modelEl(st, op.id), redo ? op.after : op.before);
      setAttrs(l, redo ? op.after : op.before);
      return l;
    }
    case 'move': return applyMove(op, redo, live);
    case 'batch': {
      let target = null;
      for (const sub of redo ? op.ops : [...op.ops].reverse()) target = applyOp(st, sub, redo, live) || target;
      return target;
    }
    case 'insert': if (redo) { doInsert(op, live); return op.l; } doRemove(op); return null;
    case 'remove': if (redo) { doRemove(op); return null; } doInsert(op, live); return op.l;
  }
  return null;
}
