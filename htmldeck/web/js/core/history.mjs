// Undo/redo stacks and the dirty flag. Pure bookkeeping on the store `st`
// (undo, redo, seq, savedSeq, inFlightSeq, textDirty, saveError, touched): applying an
// operation to the DOM and refreshing the UI are the caller's job.
import { touchOp } from './model.mjs';

export const HISTORY_LIMIT = 300;
export const MERGE_MS = 1200;

export const topSeq = st => st.undo.length ? st.undo[st.undo.length - 1].seq : 0;
export const isDirty = st => st.textDirty || topSeq(st) !== st.savedSeq;

// Record an op that has already been applied. Consecutive ops with the same key (a slider
// drag, typing in one field) merge into one step, unless that step is the saved state or the
// one being saved right now.
export function recordOp(st, op, now = Date.now()) {
  const top = st.undo[st.undo.length - 1];
  if (op.key && top && top.key === op.key && now - top.t < MERGE_MS && top.seq !== st.savedSeq && top.seq !== st.inFlightSeq && top.type === op.type) {
    top.after = op.after;
    top.t = now;
    top.seq = ++st.seq;
  } else {
    op.seq = ++st.seq;
    op.t = now;
    st.undo.push(op);
    if (st.undo.length > HISTORY_LIMIT) {
      // The empty-stack state is no longer the loaded state once history is trimmed.
      const dropped = st.undo.shift();
      if (st.savedSeq === dropped.seq) st.savedSeq = 0;
      else if (st.savedSeq === 0) st.savedSeq = -1;
    }
  }
  st.redo = [];
  st.saveError = '';
  touchOp(st, op);
}
// Undo/redo is take → apply → finish, so a failed apply never leaves the op on both stacks.
export const takeStep = (st, forward) => forward ? st.redo.pop() : st.undo.pop();
export const finishStep = (st, op, forward) => { (forward ? st.undo : st.redo).push(op); };
