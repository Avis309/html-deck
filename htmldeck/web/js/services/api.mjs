// JSON calls to the local HtmlDeck server (htmldeck/server.py).

// fetch() itself throws only when no server answers (stopped, or the machine slept): say that in
// words an end user can act on, instead of the browser's "Failed to fetch".
export const SERVER_DOWN = 'HTML Deck is not running — start it again, then reload this page';
export async function api(url, opts) {
  let res;
  try { res = await fetch(url, opts); } catch { const e = new Error(SERVER_DOWN); e.offline = true; throw e; }
  let data;
  try { data = await res.json(); } catch { data = { error: `HTTP ${res.status}` }; }
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}
export const postJSON = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
