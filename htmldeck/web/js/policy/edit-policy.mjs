// What the user may do to a node, decided from its provenance snapshot (plain data).
// Text edits copy the live subtree back into the model, so they need a subtree that is exactly
// the authored one. Style and structure edits are applied to the model directly and only need
// an unambiguous authored node.

// Returns null when allowed, otherwise the i18n key of the reason.
export function textEditBlock(p) {
  if (p.mapping === 'ambiguous') return 'lock_ambiguous';
  if (p.mapping !== 'authored') return 'lock_generated';
  if (p.foreignChild) return 'lock_generated_child';
  if (p.changed) return 'lock_runtime_changed';
  return null;
}

export function structureBlock(p) {
  if (p.mapping === 'ambiguous') return 'lock_ambiguous';
  if (p.mapping !== 'authored') return 'lock_generated';
  return null;
}

// Format rules on top of provenance, from plain flags (formats/reveal.mjs nodeFlags).
// kind: 'text' | 'edit' (style, attributes, delete) | 'duplicate' | 'move'.
// 'drop' = the parent a block is moved into.
export function formatBlock(kind, f) {
  if (!f) return null;
  if (kind === 'drop') return f.inMarkdown ? 'lock_markdown' : f.inRStack ? 'lock_r_stack' : null;
  if (kind === 'fx') return f.markdown ? 'lock_markdown' : f.fragment ? 'lock_fx_fragment' : f.autoAnimateId ? 'lock_auto_animate' : null;
  if (f.markdown) return 'lock_markdown';
  if (kind === 'duplicate' && f.autoAnimateId) return 'lock_auto_animate';
  if ((kind === 'duplicate' || kind === 'move') && f.rStack) return 'lock_r_stack';
  return null;
}
