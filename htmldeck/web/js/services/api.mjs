// JSON calls to the local HtmlDeck server (htmldeck/server.py).

export async function api(url, opts) {
  const res = await fetch(url, opts);
  let data;
  try { data = await res.json(); } catch { data = { error: `HTTP ${res.status}` }; }
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}
export const postJSON = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
