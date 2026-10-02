// Files from outside the workspace are untrusted: they render without their scripts, since
// the preview shares the editor's origin (and with it /api/save). Works on a detached clone.
export function neuterScripts(root) {
  for (const n of root.querySelectorAll('script, object, embed, meta[http-equiv], set, animate')) n.remove();
  for (const n of root.querySelectorAll('iframe, frame')) { n.removeAttribute('srcdoc'); n.setAttribute('sandbox', ''); }
  for (const n of root.querySelectorAll('*')) {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
    }
  }
}
