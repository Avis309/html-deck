// The source document model: a DOMParser copy of the file (scripts never run in it), every
// element tagged with data-ed-id. `st` is the editor store; only its model fields are used:
// model, pristine, sourceText, touched, nextId, prologue, epilogue, doctype.

export function buildModel(st, html) {
  const pro = html.match(/^\uFEFF?((?:\s|<!-{2}[\s\S]*?-{2}>|<!doctype[^>]*>)*)/i)[1];
  st.prologue = /<!doctype/i.test(pro) || /<!--/.test(pro) ? pro.replace(/\s+$/, '') : '';
  st.doctype = (pro.match(/<!doctype[^>]*>/i) || [''])[0];
  const epi = (html.match(/<\/html\s*>((?:\s|<!-{2}[\s\S]*?-{2}>)*)$/i) || [])[1] || '';
  st.epilogue = /<!--/.test(epi) ? epi.replace(/^\s+/, '') : '';
  st.model = new DOMParser().parseFromString(html, 'text/html');
  st.nextId = 1;
  for (const node of st.model.querySelectorAll('*')) node.setAttribute('data-ed-id', String(st.nextId++));
  resetPristine(st, html);
}
// Snapshot of the model that matches `st.sourceText` exactly; saves are computed against it.
export function resetPristine(st, text) {
  st.sourceText = text;
  st.pristine = st.model.cloneNode(true);
  st.touched = new Set();
}
export function touchOp(st, op) {
  if (op.type === 'batch') { op.ops.forEach(o => touchOp(st, o)); return; }
  if (op.type === 'move') {
    for (const n of [op.from.mP, op.to.mP]) { const id = n?.getAttribute?.('data-ed-id'); if (id) st.touched.add(id); }
    return;
  }
  if (op.id) st.touched.add(op.id);
  const pid = op.mParent?.getAttribute?.('data-ed-id');
  if (pid) st.touched.add(pid);
}
export function reId(st, root) {
  if (root.nodeType !== 1) return;
  root.setAttribute('data-ed-id', String(st.nextId++));
  for (const node of root.querySelectorAll('[data-ed-id]')) node.setAttribute('data-ed-id', String(st.nextId++));
}
export function modelEl(st, id) { return id ? st.model.querySelector(`[data-ed-id="${id}"]`) : null; }
// Editor-only attributes never reach the model.
export function cleanFragment(st, html) {
  const t = st.model.createElement('template');
  t.innerHTML = html;
  for (const n of t.content.querySelectorAll('[contenteditable],[data-ed-edit],[spellcheck],[data-ed-overflow]')) {
    n.removeAttribute('contenteditable'); n.removeAttribute('data-ed-edit'); n.removeAttribute('spellcheck'); n.removeAttribute('data-ed-overflow');
  }
  return t.innerHTML;
}
