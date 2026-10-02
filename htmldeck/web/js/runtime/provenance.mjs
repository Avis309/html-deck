// Where a node in the rendered preview comes from, compared with the source model.
// Three axes, computed on demand and returned as plain data (no DOM references), so the same
// answers can later come from a preview running on another origin:
//   mapping   authored  — the one live node standing for a model element
//             generated — no model counterpart (created or cloned by the page's scripts)
//             ambiguous — several live siblings claim the same model element
//   changed   the live subtree differs from the model (text, child attributes or structure)
//   owner     who changed it inside an edit session is tracked by the edit session itself.
//
// `env` = { isOriginal(node), isAmbiguous(node), modelOf(node) }.

// Attributes the editor itself puts on live nodes; they never count as a difference.
export const EDITOR_ATTRS = new Set(['contenteditable', 'spellcheck', 'data-ed-edit', 'data-ed-overflow', 'data-ed-slide', 'data-ed-slide-anc', 'data-ed-display']);

// A comparable form of a node's children. Both trees come out of the same HTML parser, so
// entities, NBSP and whitespace already agree; nothing is normalised (it would hide edits).
export function canonicalChildren(node) {
  let out = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) out += 't:' + c.nodeValue + '\u0000';
    else if (c.nodeType === 1) {
      const attrs = [...c.attributes].filter(a => !EDITOR_ATTRS.has(a.name)).map(a => a.name + '=' + a.value).sort();
      out += '<' + c.localName + ' ' + attrs.join('\u0001') + '>' + canonicalChildren(c) + '</>';
    }
  }
  return out;
}

export function mappingOf(node, env) {
  if (!node || node.nodeType !== 1) return 'generated';
  if (env.isAmbiguous(node)) return 'ambiguous';
  return env.isOriginal(node) ? 'authored' : 'generated';
}

// First element inside `root` that is not authored, or null.
export function foreignDescendant(root, env) {
  for (const n of root.querySelectorAll('*')) if (mappingOf(n, env) !== 'authored') return n;
  return null;
}

// Snapshot used by the edit policy.
export function provenance(node, env) {
  const mapping = mappingOf(node, env);
  if (mapping !== 'authored') return { mapping, foreignChild: false, changed: false };
  const model = env.modelOf(node);
  if (!model) return { mapping: 'generated', foreignChild: false, changed: false };
  const foreignChild = !!foreignDescendant(node, env);
  return { mapping, foreignChild, changed: !foreignChild && canonicalChildren(node) !== canonicalChildren(model) };
}
