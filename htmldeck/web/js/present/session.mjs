// Present session: a second iframe built from the model, separate from the edit iframe, so
// presenting never touches the edited DOM or its undo history. The two sides talk only through
// postMessage with a session id and the document revision (no live node references), which is
// the protocol phase 3c keeps when the preview moves to its own origin.

export const NS = 'htmldeck';
export const VERSION = 1;
const FROM_PRESENT = new Set(['ready', 'state', 'exit', 'save', 'error']);

export function newSessionId() {
  return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// A message from the present frame, validated; null when it is not ours or out of range.
// count = slides in the session (0 for a page: index must then be 0).
export function acceptMessage(e, { frameWin, origin, sessionId, docRevision, count }) {
  if (!frameWin || e.source !== frameWin || e.origin !== origin) return null;
  const m = e.data;
  if (!m || typeof m !== 'object' || m.ns !== NS || m.v !== VERSION) return null;
  if (m.sessionId !== sessionId || m.docRevision !== docRevision || !FROM_PRESENT.has(m.type)) return null;
  if (m.type === 'ready' || m.type === 'state') {
    if (!Number.isInteger(m.index) || m.index < 0 || m.index >= Math.max(count, 1)) return null;
    if (m.type === 'ready' && m.count !== count) return null;
  }
  return m;
}

// on: { ready(msg), state(index), exit(), save(), fail(reason) } — never called after dispose().
// The readiness deadline belongs to the caller: it has to cover staging, which starts earlier.
export function createPresentSession({ host, url, title, sessionId, docRevision, count, start, origin, on }) {
  let state = 'loading', index = start, disposed = false, requestId = 0;
  const frame = document.createElement('iframe');
  frame.className = 'present-frame';
  frame.title = title || '';
  const onMessage = e => {
    if (disposed) return;
    const m = acceptMessage(e, { frameWin: frame.contentWindow, origin, sessionId, docRevision, count });
    if (!m) return;
    if (m.type === 'error') { on.fail?.(m.reason || 'error'); return; }
    if (m.type === 'ready') {
      if (state !== 'loading') return;
      state = 'active';
      index = m.index;
      on.ready?.(m);
      return;
    }
    if (state !== 'active') return;
    if (m.type === 'state') { index = m.index; on.state?.(index); }
    else if (m.type === 'exit') on.exit?.();
    else if (m.type === 'save') on.save?.();
  };
  window.addEventListener('message', onMessage);
  host.appendChild(frame);
  frame.src = url;
  return {
    frame,
    get state() { return state; },
    get index() { return index; },
    navigate(i) {
      if (state !== 'active' || !frame.contentWindow) return;
      frame.contentWindow.postMessage({ ns: NS, v: VERSION, type: 'navigate', sessionId, docRevision, index: i, requestId: ++requestId }, origin);
    },
    // Idempotent. Removing the iframe ends every timer and animation the document started.
    dispose() {
      if (disposed) return;
      disposed = true;
      state = 'disposed';
      window.removeEventListener('message', onMessage);
      frame.remove();
    },
  };
}
