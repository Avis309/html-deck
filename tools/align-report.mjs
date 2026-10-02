/**
 * How many HTML documents of a workspace HtmlDeck can patch in place (minimal diff).
 * For each file: the source tokenizer is aligned with the parsed DOM; a file that does not
 * align still saves correctly, but only by rewriting the whole file (the editor asks first).
 *
 *   npm run align -- ~/my-workspace            (needs `npm install`; Chromium via Playwright)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ws = path.resolve(process.argv[2] || '.');
const SKIP = new Set(['node_modules', 'tmp', 'venv', '__pycache__', 'site-packages']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.html?$/i.test(e.name) && !e.name.startsWith('__edpreview-')) files.push(p);
  }
})(ws);

const PY = process.env.PYTHON || (fs.existsSync(path.join(ROOT, '.venv/bin/python')) ? path.join(ROOT, '.venv/bin/python') : 'python3');
const proc = spawn(PY, ['-u', '-m', 'htmldeck', '--root', ws, '--no-browser', '--port', '0'], { cwd: ROOT, env: { ...process.env, PYTHONPATH: ROOT } });
const url = await new Promise((resolve, reject) => {
  proc.stdout.on('data', d => { const m = String(d).match(/Editor URL\s*:\s*(http:\/\/\S+)/); if (m) resolve(m[1]); });
  proc.on('exit', code => reject(new Error(`server exited ${code}`)));
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(url + '/__htmldeck/index.html');
  let bad = 0, elements = 0;
  for (const f of files) {
    const r = await page.evaluate(async src => {
      const S = await import('/__htmldeck/js/core/serializer.mjs');
      const M = await import('/__htmldeck/js/core/model.mjs');
      const st = { nextId: 1, touched: new Set() };
      M.buildModel(st, src);
      return { ok: !!S.alignTokens(S.tokenize(st.sourceText ?? src), st.pristine), n: st.pristine.querySelectorAll('*').length };
    }, fs.readFileSync(f, 'utf8'));
    elements += r.n;
    if (!r.ok) { bad++; console.log(`  ✖ ${path.relative(ws, f)}`); }
  }
  const pct = files.length ? (100 * (files.length - bad) / files.length).toFixed(1) : '100';
  console.log(`${files.length} files · ${elements} elements · patchable in place ${files.length - bad} (${pct}%)`);
} finally {
  await browser.close();
  proc.kill();
}
