/**
 * HtmlDeck — khoá hành vi hiện tại trước khi tách module (pha 0 của plan HtmlDeck 2.0).
 *
 * Hộp đen: chỉ thao tác qua nút/phím thật và đọc kết quả qua thứ người dùng thấy được —
 * nút "Tải bản đang sửa", file trên đĩa, DOM của editor và iframe. Không gọi hàm/biến global
 * của editor, nên spec vẫn đúng khi code được tách sang ES modules.
 * Tín hiệu duy nhất editor cung cấp cho test: <body data-doc-state data-doc-path data-doc-seq>.
 *
 * Chạy: `npm run spec` hoặc `node tests/spec/characterization.spec.mjs [--fixtures-only | --real-only]`.
 * Fixture được chép vào một workspace tạm (thư mục tạm của hệ thống) và server chạy với
 * `--root` trỏ vào đó. Phần "file thật" chỉ chạy khi chỉ định một workspace và các file trong đó:
 *   HTMLDECK_REAL_ROOT=~/vng_work HTMLDECK_REAL_FILES="output/a.html,docs/b.html" npm run spec
 * Python: biến PYTHON, mặc định .venv/bin/python của repo nếu có, không thì python3.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'tests/fixtures');
const PY = process.env.PYTHON || (fs.existsSync(path.join(ROOT, '.venv/bin/python')) ? path.join(ROOT, '.venv/bin/python') : 'python3');
// Real documents: another workspace's files, only when given.
const REAL_ROOT = process.env.HTMLDECK_REAL_ROOT ? path.resolve(process.env.HTMLDECK_REAL_ROOT.replace(/^~(?=\/)/, os.homedir())) : '';
const REAL_FILES = (process.env.HTMLDECK_REAL_FILES || '').split(',').map(x => x.trim()).filter(Boolean);
const args = new Set(process.argv.slice(2));
if (args.has('--real-only') && args.has('--fixtures-only')) { console.error('Chọn một trong --real-only / --fixtures-only'); process.exit(2); }

// The fixtures' workspace: a temp folder the server is started on (--root).
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'htmldeck-spec-'));
const wpath = f => f;   // document paths are relative to the workspace
const disk = f => fs.readFileSync(path.join(WORK, f), 'utf8');

const failures = [], known = [];
let passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✔ ${name}`); return true; }
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
  console.log(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  return false;
}
// Known defects scheduled for a later phase: reported, never fail the run. When one starts
// passing the message says so, so the entry can be turned into a normal check.
function knownBug(name, stillBroken, detail = '') {
  known.push(name);
  console.log(`  ⚠ KNOWN ${stillBroken ? '(vẫn lỗi)' : '(ĐÃ HẾT LỖI — chuyển thành check thường)'}: ${name}${detail ? ' — ' + detail : ''}`);
}
function firstDiff(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return `type ${typeof a} vs ${typeof b}`;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `@${i}: ${JSON.stringify(a.slice(Math.max(0, i - 10), i + 50))} vs ${JSON.stringify(b.slice(Math.max(0, i - 10), i + 50))}`;
  return a.length === b.length ? '' : `length ${a.length} vs ${b.length}`;
}
const section = t => console.log(`\n┌─ ${t}`);

// ---------------------------------------------------------------- server
function startServer(extra = [], root = WORK) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PY, ['-u', '-m', 'htmldeck', '--root', root, '--no-browser', '--port', '0', ...extra], { cwd: ROOT, env: { ...process.env, PYTHONPATH: ROOT } });
    let out = '';
    const fail = err => { clearTimeout(timer); proc.kill(); reject(err); };
    const timer = setTimeout(() => fail(new Error('server không khởi động: ' + out)), 15000);
    proc.on('error', fail);
    proc.stdout.on('data', d => {
      out += d;
      const m = out.match(/Editor URL\s*:\s*(http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve({ proc, url: m[1] }); }
    });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`server thoát (${code}): ${out}`)); });
  });
}
async function stopServer(s) {
  if (!s || s.proc.exitCode !== null) return;
  const gone = new Promise(r => s.proc.once('exit', r));
  s.proc.kill();
  await gone;
}

// ---------------------------------------------------------------- editor session (black box)
class Session {
  constructor(browser, url) { this.browser = browser; this.url = url; this.expected = []; this.errors = []; this.downloads = 0; this.assets = new Set(); }
  async start() {
    this.ctx = await this.browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
    this.page = await this.ctx.newPage();
    this.page.on('pageerror', e => { this.errors.push(e.message); console.log(`  ! lỗi JS: ${e.message}`); });
    if (process.env.HTMLDECK_SPEC_DEBUG) this.page.on('console', m => console.log(`  · console.${m.type()}: ${m.text().slice(0, 160)}`));
    this.page.on('dialog', d => this.onDialog(d));
    // Editor's own assets: a 404 or a wrong MIME on a module leaves a blank editor, silently.
    this.page.on('response', r => {
      const u = new URL(r.url());
      if (!u.pathname.startsWith('/__htmldeck/') || r.status() === 304) return;  // 304: cached copy, no type
      const type = r.headers()['content-type'] || '';
      const want = /\.m?js$/.test(u.pathname) ? /javascript/ : /\.css$/.test(u.pathname) ? /text\/css/ : null;
      if (r.status() >= 400 || (want && !want.test(type))) this.errors.push(`asset ${u.pathname}: ${r.status()} ${type}`);
      else if (want) this.assets.add(u.pathname);
    });
    return this;
  }
  // Every native dialog must be announced with expectDialog(); anything else fails the run.
  // optional: may legitimately not appear (Chromium only asks beforeunload after a user gesture).
  expectDialog(type, re, accept, { optional = false } = {}) { this.expected.push({ type, re, accept, optional }); }
  async onDialog(d) {
    if (process.env.HTMLDECK_SPEC_DEBUG) console.log(`  · dialog ${d.type()}: ${d.message().slice(0, 100)}`);
    const i = this.expected.findIndex(x => x.type === d.type());
    const e = i >= 0 ? this.expected.splice(i, 1)[0] : null;
    if (!e || (e.re && !e.re.test(d.message()))) {
      failures.push(`dialog ngoài dự kiến: ${d.type()} "${d.message().slice(0, 80)}"`);
      console.log(`  ✖ dialog ngoài dự kiến: ${d.type()} "${d.message().slice(0, 80)}"`);
      return d.dismiss();
    }
    return e.accept ? d.accept() : d.dismiss();
  }
  get frame() { return this.page.frameLocator('#frame'); }
  async waitReady(p, prevSeq = 0) {
    await this.page.waitForFunction(([p, seq]) => {
      const b = document.body;
      return b.dataset.docState === 'ready' && b.dataset.docPath === p && +(b.dataset.docSeq || 0) > seq;
    }, [p, prevSeq], { timeout: 60000 });
  }
  seq() { return this.page.evaluate(() => +(document.body.dataset.docSeq || 0)); }
  async open(p) {
    await this.page.goto(`${this.url}/?file=${encodeURIComponent(p)}`);
    await this.waitReady(p);
    return this;
  }
  // What the editor would save, read through the user-facing "download" button.
  // Chromium silently drops a burst of automatic downloads (the 11th in a row), so a missing
  // download is retried once; a second miss is a real failure.
  // Chromium drops one download in a long burst from the same page (seen: the 11th). Long
  // scenarios pass { retry: true }; every retry is logged, and the first download of each
  // fresh session (detection, real files) never retries, so a dead button still fails.
  async content({ retry = this.downloads > 0 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const got = this.page.waitForEvent('download', { timeout: retry && !attempt ? 5000 : 30000 }).catch(e => { if (!retry || attempt) throw e; return null; });
      await this.page.click('#btn-download');
      const dl = await got;
      if (dl) { this.downloads++; return fs.readFileSync(await dl.path(), 'utf8'); }
      console.log('  · download bị Chromium bỏ, bấm lại 1 lần');
    }
  }
  dirty() { return this.page.evaluate(() => document.querySelector('#btn-save').classList.contains('dirty')); }
  canUndo() { return this.page.isEnabled('#btn-undo'); }
  canRedo() { return this.page.isEnabled('#btn-redo'); }
  async typeAtEnd(selector, text) {
    await this.frame.locator(selector).first().click();
    await this.page.keyboard.press('End');
    await this.page.keyboard.type(text);
  }
  async select(selector) { await this.frame.locator(selector).first().click(); }
  // The present iframe runs on the preview origin: read it as its own frame, never through the parent.
  async presentFrame() { return (await this.page.waitForSelector('.present-frame')).contentFrame(); }
  async undo() { await this.page.click('#btn-undo'); }
  async redo() { await this.page.click('#btn-redo'); }
  async saveKey() { await this.page.keyboard.press('Control+s'); }
  async waitSaved() {
    await this.page.waitForFunction(() => {
      const st = document.querySelector('#save-state');
      return !document.querySelector('#btn-save').classList.contains('dirty') && !/dirty|error/.test(st.className);
    }, null, { timeout: 15000 });
  }
  async close() {
    this.expected = this.expected.filter(e => !e.optional);
    if (this.expected.length) failures.push(`dialog dự kiến nhưng không xuất hiện: ${this.expected.map(e => e.type).join(', ')}`);
    if (this.errors.length) failures.push(`lỗi JS: ${this.errors.slice(0, 3).join(' | ')}`);
    await this.ctx.close();
  }
}

// ---------------------------------------------------------------- scenarios
async function detection(browser, url) {
  section('nhận dạng + no-op roundtrip (fixtures)');
  // [badge text, thumbnails]
  const expect = {
    'deck.html': [/· 3$/, 3], 'report.html': [/trang web/i, 3], 'carousel.html': [/trang web/i, 0],
    'crlf.html': [/trang web/i, 0], 'struct.html': [/trang web/i, 0], 'mutating.html': [/trang web/i, 0],
    'rewrite.html': [/trang web/i, 0],
  };
  for (const [f, [badge, thumbs]] of Object.entries(expect)) {
    const s = await new Session(browser, url).start();
    await s.open(wpath(f));
    if (f === 'deck.html') check('editor tải CSS + ES modules (200, đúng MIME)', ['/__htmldeck/css/editor.css', '/__htmldeck/js/app.mjs', '/__htmldeck/js/i18n.mjs'].every(a => s.assets.has(a)), [...s.assets].join(', '));
    const got = await s.page.evaluate(() => [document.querySelector('#mode-badge').textContent, document.querySelectorAll('#filmstrip .thumb').length]);
    check(`${f}: badge "${got[0]}", ${got[1]} thumb`, badge.test(got[0]) && got[1] === thumbs, `muốn ${badge} / ${thumbs}`);
    const c = await s.content();
    check(`${f}: no-op roundtrip byte-identical, không dirty`, c === disk(f) && !(await s.dirty()), firstDiff(c, disk(f)));
    await s.close();
  }
}

async function textColourHistory(browser, url) {
  section('deck: sửa chữ, chuyển slide, đổi màu, undo/redo từng bước, Ctrl+S');
  const original = disk('deck.html');
  const s = await new Session(browser, url).start();
  await s.open(wpath('deck.html'));
  check('ban đầu: không dirty, undo/redo tắt', !(await s.dirty()) && !(await s.canUndo()) && !(await s.canRedo()));
  const frameBox = await s.page.locator('#frame').boundingBox();
  check('CSS editor đã áp: iframe có kích thước thật', frameBox && frameBox.width > 400 && frameBox.height > 200, JSON.stringify(frameBox));
  await s.select('#t1');
  // The overlay is positioned on the next animation frame(s): poll instead of sampling once.
  const near = (a, b) => a && b && Math.abs(a.x - b.x) <= 6 && Math.abs(a.y - b.y) <= 6 && Math.abs(a.width - b.width) <= 8;
  let selBox, elBox;
  for (let i = 0; i < 20; i++) {
    [selBox, elBox] = [await s.page.locator('#sel-box').boundingBox(), await s.frame.locator('#t1').boundingBox()];
    if (near(selBox, elBox)) break;
    await s.page.waitForTimeout(50);
  }
  check('khung chọn bám đúng phần tử (lệch ≤ 6px)', near(selBox, elBox), `${JSON.stringify(selBox)} vs ${JSON.stringify(elBox)}`);
  await s.frame.locator('#t1').press('Escape');

  await s.typeAtEnd('#t1', ' XY');
  const v1 = original.replace('>Alpha title<', '>Alpha title XY<');
  let c = await s.content();
  check('sửa chữ: chỉ đoạn chữ đổi', c === v1, firstDiff(c, v1));
  check('sửa chữ: dirty, undo bật', (await s.dirty()) && (await s.canUndo()));

  await s.page.click('#sb-next');
  check('nút slide sau: 2 / 3, slide 2 hiện, slide 1 ẩn',
    (await s.page.textContent('#page-count')).trim() === '2 / 3' && (await s.frame.locator('text=Beta heading').isVisible()) && !(await s.frame.locator('#t1').isVisible()));

  await s.select('p.accent');
  await s.page.click('#tb-color');
  await s.page.click('#default-colors .swatch[title="#da1e28"]');
  const v2 = v1.replace('<p class="accent">', '<p class="accent" style="color: rgb(218, 30, 40);">');
  c = await s.content();
  check('đổi màu qua swatch: đúng giá trị, giữ class, chỉ start tag đổi', c === v2, firstDiff(c, v2));
  const colour = () => s.frame.locator('p.accent').evaluate(e => getComputedStyle(e).color);
  check('đổi màu: preview đổi theo', (await colour()) === 'rgb(218, 30, 40)', await colour());

  await s.undo();
  c = await s.content();
  check('undo 1: bỏ màu, còn chữ; preview hết đỏ; còn dirty', c === v1 && (await colour()) !== 'rgb(218, 30, 40)' && (await s.dirty()), firstDiff(c, v1));
  await s.undo();
  c = await s.content();
  check('undo 2: về file gốc, hết dirty, undo tắt, redo bật', c === original && !(await s.dirty()) && !(await s.canUndo()) && (await s.canRedo()), firstDiff(c, original));
  check('undo 2: preview về chữ gốc', (await s.frame.locator('#t1').textContent()) === 'Alpha title');
  await s.redo();
  c = await s.content();
  check('redo 1: có lại chữ', c === v1, firstDiff(c, v1));
  await s.redo();
  c = await s.content();
  check('redo 2: có lại màu, redo tắt', c === v2 && !(await s.canRedo()) && (await colour()) === 'rgb(218, 30, 40)', firstDiff(c, v2));

  await s.undo();
  await s.page.click('#sb-prev');
  await s.typeAtEnd('#t1', 'Z');
  const v3 = original.replace('>Alpha title<', '>Alpha title XYZ<');
  c = await s.content();
  check('undo rồi sửa mới: redo bị xoá (sau khi chữ được commit)', !(await s.canRedo()));
  check('sửa mới: nội dung đúng', c === v3, firstDiff(c, v3));

  await s.frame.locator('#t1').click();
  check('focus đang ở trong iframe trước khi bấm phím tắt', await s.page.evaluate(() => document.activeElement === document.querySelector('#frame')));
  await s.saveKey();
  await s.waitSaved();
  check('Ctrl+S (focus trong iframe): đĩa == nội dung editor', disk('deck.html') === v3, firstDiff(disk('deck.html'), v3));
  const bakDir = path.join(WORK, '.htmldeck_bak');
  const baks = fs.existsSync(bakDir) ? fs.readdirSync(bakDir).filter(n => n.startsWith('deck.html.')) : [];
  check('lưu: backup đúng bản gốc', baks.length === 1 && fs.readFileSync(path.join(bakDir, baks[0]), 'utf8') === original);

  await s.typeAtEnd('#t1', '!');
  check('sau lưu, sửa tiếp: dirty', await s.dirty());
  await s.frame.locator('#t1').press('Escape');
  await s.page.keyboard.press('Control+z');
  await s.page.waitForFunction(() => !document.querySelector('#btn-save').classList.contains('dirty'), null, { timeout: 5000 }).catch(() => {});
  c = await s.content();
  check('Ctrl+Z (focus trong iframe) về mốc vừa lưu: hết dirty', c === v3 && !(await s.dirty()), firstDiff(c, v3));
  await s.close();
}

async function modeSwitch(browser, url) {
  section('đổi chế độ hiển thị có sửa chưa lưu');
  const original = disk('report.html');
  const s = await new Session(browser, url).start();
  await s.open(wpath('report.html'));
  await s.typeAtEnd('h2 >> text=Section one', '+');
  const edited = original.replace('Section one<', 'Section one+<');

  s.expectDialog('confirm', /hoàn tác/, false);
  await s.page.selectOption('#sb-mode', 'deck');
  await s.page.waitForFunction(() => document.querySelector('#sb-mode').value === 'auto');
  check('huỷ confirm: giữ chế độ trang, còn undo', /trang web/i.test(await s.page.textContent('#mode-badge')) && (await s.canUndo()));

  const seq = await s.seq();
  s.expectDialog('confirm', /hoàn tác/, true);
  await s.page.selectOption('#sb-mode', 'deck');
  await s.waitReady(wpath('report.html'), seq);
  const c = await s.content();
  check('đồng ý: chuyển sang slide, giữ nội dung sửa, còn dirty, mất lịch sử undo',
    /· 3$/.test(await s.page.textContent('#mode-badge')) && c === edited && (await s.dirty()) && !(await s.canUndo()), firstDiff(c, edited));
  await s.close();
}

async function structural(browser, url) {
  section('khối: nhân bản / xoá / di chuyển, link, ảnh, tìm & thay, ghi chú agent');
  const original = disk('struct.html');
  const card = n => original.match(new RegExp(`<div class="card" id="c${n}">.*?</div>`))[0];
  const before2 = original.slice(0, original.indexOf(card(2)));
  const after2 = original.slice(original.indexOf(card(2)) + card(2).length);
  const s = await new Session(browser, url).start();
  await s.open(wpath('struct.html'));

  const pickCard = async n => { await s.select(`#c${n} h3`); await s.page.click('#pill-parent'); };
  const backToOriginal = async label => {
    await s.undo();
    const c = await s.content();
    check(`${label}: undo về file gốc`, c === original && !(await s.dirty()), firstDiff(c, original));
  };

  await pickCard(2);
  await s.page.click('#pill-dup');
  let c = await s.content();
  check('nhân bản card 2: có 2 bản, phần trước/sau giữ nguyên',
    c.split('Card two').length === 3 && c.startsWith(before2) && c.endsWith(after2), c.slice(before2.length - 5, c.length - after2.length + 5));
  check('nhân bản: preview có 2 card two', (await s.frame.locator('h3', { hasText: 'Card two' }).count()) === 2);
  await backToOriginal('nhân bản');

  await pickCard(2);
  await s.page.click('#pill-del');
  c = await s.content();
  check('xoá card 2: biến mất, card 1/3 nguyên vẹn', !c.includes('Card two') && c.includes(card(1)) && c.includes(card(3)));
  check('xoá: preview mất card two', (await s.frame.locator('h3', { hasText: 'Card two' }).count()) === 0);
  await backToOriginal('xoá');

  await pickCard(2);
  await s.page.click('#pill-more');
  await s.page.click('#m-up');
  c = await s.content();
  check('đưa card 2 lên: thứ tự c2, c1, c3, nội dung card nguyên vẹn',
    c.indexOf('id="c2"') < c.indexOf('id="c1"') && c.indexOf('id="c1"') < c.indexOf('id="c3"') && c.includes(card(2)) && c.includes(card(1)) && c.includes(card(3)));
  await backToOriginal('di chuyển');

  await s.frame.locator('#lnk').dblclick({ position: { x: 70, y: 8 } });
  const word = await s.frame.locator('body').evaluate(() => getSelection().toString().trim());
  await s.page.click('#tb-link');
  await s.page.fill('#link-url', 'https://example.com/g');
  await s.page.click('#link-apply');
  c = await s.content();
  check(`link trên chữ "${word}": bọc đúng <a href>, phần còn lại giữ nguyên`,
    !!word && c.includes(`<a href="https://example.com/g">${word}</a>`) && c.replace(/<a href="https:\/\/example\.com\/g">([^<]*)<\/a>/, '$1') === original,
    c.slice(c.indexOf('id="lnk"') - 5, c.indexOf('id="lnk"') + 120));
  await backToOriginal('link');

  await s.select('#pic');
  await s.page.click('#tb-img-replace');
  await s.page.fill('#img-url', 'pic2.svg');
  await s.page.click('#img-url-apply');
  await s.page.waitForFunction(() => document.querySelector('#btn-save').classList.contains('dirty'));
  c = await s.content();
  const imgTag = c.match(/<img[^>]*id="pic"[^>]*>/)?.[0] || '';
  const origImg = original.match(/<img[^>]*id="pic"[^>]*>/)[0];
  check('thay ảnh: src mới, giữ alt/width/height, ngoài thẻ img giữ nguyên',
    /src="pic2\.svg"/.test(imgTag) && /alt="pic"/.test(imgTag) && /width="80"/.test(imgTag) && c.replace(imgTag, '') === original.replace(origImg, ''), imgTag);
  await backToOriginal('thay ảnh');

  await s.page.click('#sb-find');
  await s.page.fill('#find-q', 'keyword');
  await s.page.waitForFunction(() => /2/.test(document.querySelector('#find-count').textContent));
  check('tìm: đếm 2 kết quả', true);
  await s.page.fill('#find-r', 'term');
  await s.page.click('#find-all');
  c = await s.content();
  check('thay tất cả: đúng 2 chỗ, phần còn lại giữ nguyên', c === original.replaceAll('keyword', 'term'), firstDiff(c, original.replaceAll('keyword', 'term')));
  await backToOriginal('thay tất cả (1 bước undo)');
  await s.page.click('#find-close');

  await s.frame.locator('#lnk').dblclick({ position: { x: 70, y: 8 } });
  await s.page.click('#tb-bold');
  await s.select('#c1 h3');
  await s.select('#lnk');
  c = await s.content();
  check('bôi đậm 1 chữ rồi rời khối, quay lại: vẫn sửa được (node mới được cấp id)',
    (await s.frame.locator('#lnk').evaluate(e => e.isContentEditable)) && /<p id="lnk">Read the <b>guide<\/b> today<\/p>/.test(c), c.match(/<p id="lnk">.*?<\/p>/)?.[0]);
  await s.undo();
  check('bôi đậm: undo về file gốc', (await s.content()) === original);

  await s.typeAtEnd('#c1 p', '');
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('Second line');
  await s.select('#c2 h3');
  await s.frame.locator('#c1 p', { hasText: 'Second line' }).click();
  check('Enter xuống dòng rồi rời khối, quay lại: vẫn sửa được', await s.frame.locator('#c1 p').evaluate(e => e.isContentEditable));
  await s.page.keyboard.type(' ok');
  c = await s.content();
  check('Enter: nội dung có cả dòng mới và chữ gõ thêm', c.includes('Second line') && /(&nbsp;| )ok/.test(c) && c.includes('First body text'), c.match(/<div class="card" id="c1">.*?<\/div>/s)?.[0]);
  while (await s.canUndo()) await s.undo();
  check('Enter: undo hết về file gốc', (await s.content()) === original);

  // Range from the text before a span to the middle of it: wrapping extracts a clone of the span
  // that lands before the original part. The original must keep its identity.
  await s.select('#kids');
  await s.frame.locator('#kids').evaluate(p => {
    const r = document.createRange();
    r.setStart(p.firstChild, 2);
    r.setEnd(p.querySelector('span').firstChild, 2);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await s.page.click('#tb-color');
  await s.page.click('#default-colors .swatch[title="#da1e28"]');
  await s.select('#c3 h3');
  await s.select('#kids');
  c = await s.content();
  check('tô màu vùng chọn cắt ngang span: quay lại vẫn sửa được, span gốc còn nguyên phần sau',
    (await s.frame.locator('#kids').evaluate(e => e.isContentEditable)) && /ue<\/span> tail<\/p>/.test(c) && /rgb\(218, 30, 40\)/.test(c), c.match(/<p id="kids".*?<\/p>/)?.[0]);
  while (await s.canUndo()) await s.undo();
  check('cắt ngang span: undo hết về file gốc', (await s.content()) === original);

  await s.select('#kids');
  await s.page.click('#tb-color');
  await s.page.click('#default-colors .swatch[title="#da1e28"]');
  await s.page.waitForSelector('#toast .t-act');
  await s.page.click('#toast .t-act');
  await s.typeAtEnd('#kids', ' more');
  c = await s.content();
  check('đổi màu cả chữ con (offerChildColor) rồi gõ tiếp: không bị coi là xung đột',
    c.includes('tail more') && (c.match(/color: rgb\(218, 30, 40\)/g) || []).length === 2, c.match(/<p id="kids".*?<\/p>/)?.[0]);
  while (await s.canUndo()) await s.undo();
  check('màu con: undo hết về file gốc', (await s.content()) === original);

  await s.select('#c3 h3');  // move the selection pill away from #lnk before clicking it
  await s.select('#lnk');
  await s.page.click('#pill-note');
  await s.page.fill('#note-input', 'Ghi chú kiểm thử');
  await s.page.click('#note-save');
  const side = path.join(WORK, '.htmldeck_notes', 'struct.html.json');
  for (let i = 0; i < 50 && !fs.existsSync(side); i++) await s.page.waitForTimeout(100);
  const notes = fs.existsSync(side) ? JSON.parse(fs.readFileSync(side, 'utf8')).notes : [];
  check('ghi chú cho agent: vào sidecar, có selector, HTML không đổi, không dirty',
    notes.length === 1 && notes[0].note === 'Ghi chú kiểm thử' && /lnk/.test(notes[0].selector) && (await s.content()) === original && !(await s.dirty()),
    JSON.stringify(notes));
  await s.close();
}

async function conflict(browser, url) {
  section('lưu khi file đã đổi trên đĩa (409)');
  const f = 'crlf.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  await s.typeAtEnd('td >> text=Cell zeta', '!');
  const mine = original.replace('Cell zeta<', 'Cell zeta!<');
  check('CRLF: sửa ô, giữ \\r\\n, không chèn tbody', (await s.content()) === mine);
  const theirs = original.replace('Para eta', 'Para eta (changed outside)');
  fs.writeFileSync(path.join(WORK, f), theirs);

  await s.saveKey();
  await s.page.waitForSelector('#modal-conflict.show');
  check('409: hiện modal xung đột, đĩa giữ bản bên ngoài, vẫn dirty', disk(f) === theirs && (await s.dirty()));
  await s.page.click('#modal-conflict [data-act="cancel"]');
  check('huỷ: modal đóng, đĩa không đổi, vẫn dirty', !(await s.page.isVisible('#modal-conflict.show')) && disk(f) === theirs && (await s.dirty()));

  await s.saveKey();
  await s.page.waitForSelector('#modal-conflict.show');
  await s.page.click('#modal-conflict [data-act="force"]');
  await s.waitSaved();
  check('ghi đè: đĩa == bản của editor', disk(f) === mine, firstDiff(disk(f), mine));
  await s.close();
}

async function rewriteFallback(browser, url) {
  section('không vá được tại chỗ → hỏi trước khi ghi lại cả file');
  const f = 'rewrite.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  await s.typeAtEnd('#b', '?');
  await s.content();
  await s.undo();
  let c = await s.content();
  check('sửa rồi undo về sạch: tải xuống vẫn đúng file gốc (không viết lại)', c === original && !(await s.dirty()), firstDiff(c, original));
  await s.typeAtEnd('#b', '!');
  const full = await s.content();
  check('bản lưu là serialize toàn bộ: có chữ sửa, đã chuẩn hoá cả chỗ không sửa', full.includes('Para beta!') && full !== original && !full.includes('class=box'), full.slice(0, 120));
  await s.saveKey();
  await s.page.waitForSelector('#modal-reformat.show');
  check('modal ghi-lại-cả-file hiện, đĩa chưa đổi, vẫn dirty', disk(f) === original && (await s.dirty()));
  await s.page.click('#modal-reformat [data-act="cancel"]');
  check('huỷ: không gọi lưu, đĩa nguyên, vẫn dirty', !(await s.page.isVisible('#modal-reformat.show')) && disk(f) === original && (await s.dirty()));
  await s.saveKey();
  await s.page.waitForSelector('#modal-reformat.show');
  await s.page.click('#modal-reformat [data-act="save"]');
  await s.waitSaved();
  check('"Vẫn lưu": đĩa == bản serialize toàn bộ', disk(f) === full, firstDiff(disk(f), full));
  await s.close();
}

async function saveInFlight(browser, url) {
  section('sửa tiếp trong lúc đang lưu');
  const f = 'struct.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  await s.typeAtEnd('#c1 p', ' A');
  let release, held = new Promise(r => { release = r; });
  let seen = 0;
  await s.page.route('**/api/save', async route => { seen++; await held; await route.continue(); });
  await s.saveKey();
  await s.page.waitForFunction(() => /saving|đang lưu/i.test(document.querySelector('#save-state').textContent), null, { timeout: 5000 }).catch(() => {});
  check('request lưu đang bị giữ', seen === 1);
  await s.undo();
  check('đang lưu: undo bị chặn, có báo', /đợi lưu xong/.test(await s.page.textContent('#toast')) && (await s.content()) === original.replace('First body text<', 'First body text A<'), await s.page.textContent('#toast'));
  await s.typeAtEnd('#c3 p', ' B');
  await s.content();  // commits the typed text while the save is still in flight
  release();
  await s.page.waitForFunction(() => !/saving|đang lưu/i.test(document.querySelector('#save-state').textContent), null, { timeout: 10000 });
  const first = original.replace('First body text<', 'First body text A<');
  const both = first.replace('Third body keyword<', 'Third body keyword B<');
  check('đĩa có bản lúc bấm lưu (chỉ A)', disk(f) === first, firstDiff(disk(f), first));
  check('sửa trong lúc lưu vẫn dirty, nội dung có cả A và B', (await s.dirty()) && (await s.content()) === both);
  await s.page.unroute('**/api/save');
  await s.saveKey();
  await s.waitSaved();
  check('lưu lần 2: đĩa có cả A và B, minimal-diff', disk(f) === both, firstDiff(disk(f), both));
  await s.close();
}

async function failedStep(browser, url) {
  section('undo lỗi giữa chừng → khôi phục, model và preview không lệch');
  const f = 'struct.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.page.goto(`${url}/?htmldeck-fault=step&file=${encodeURIComponent(wpath(f))}`);
  await s.waitReady(wpath(f));
  await s.page.click('#sb-find');
  await s.page.fill('#find-q', 'keyword');
  await s.page.waitForFunction(() => /2/.test(document.querySelector('#find-count').textContent));
  await s.page.fill('#find-r', 'term');
  await s.page.click('#find-all');
  await s.page.click('#find-close');
  const replaced = original.replaceAll('keyword', 'term');
  const seq = await s.seq();
  await s.undo();
  await s.waitReady(wpath(f), seq);
  const c = await s.content();
  check('sau lỗi: tài liệu về đúng trạng thái trước bước undo', c === replaced, firstDiff(c, replaced));
  check('sau lỗi: preview khớp model (thấy "term", không thấy "keyword")', (await s.frame.locator('text=Second body term').count()) === 1 && (await s.frame.locator('text=keyword').count()) === 0);
  check('sau lỗi: vẫn dirty, lịch sử đã làm mới, có báo', (await s.dirty()) && !(await s.canUndo()) && !(await s.canRedo()) && /lỗi giữa chừng/.test(await s.page.textContent('#toast')), await s.page.textContent('#toast'));
  await s.saveKey();
  await s.waitSaved();
  check('sau lỗi: lưu ra đúng nội dung đó', disk(f) === replaced, firstDiff(disk(f), replaced));
  await s.close();
}

async function failedSingleStep(browser, url) {
  section('undo op đơn lỗi sau khi đã ghi model → model được trả lại');
  const f = 'carousel.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.page.goto(`${url}/?htmldeck-fault=single&file=${encodeURIComponent(wpath(f))}`);
  await s.waitReady(wpath(f));
  await s.typeAtEnd('p >> text=Card one', ' E');
  const edited = original.replace('Card one<', 'Card one E<');
  check('op đơn: đã sửa', (await s.content()) === edited);
  const seq = await s.seq();
  await s.undo();
  await s.waitReady(wpath(f), seq);
  const c = await s.content();
  check('op đơn lỗi: model về đúng trước bước undo (không kẹt nửa chừng)', c === edited, firstDiff(c, edited));
  check('op đơn lỗi: preview khớp model, vẫn dirty, có báo', (await s.frame.locator('text=Card one E').count()) === 1 && (await s.dirty()) && /lỗi giữa chừng/.test(await s.page.textContent('#toast')));
  await s.close();
}

async function draftRestore(browser, url) {
  section('khôi phục bản nháp sau khi tải lại trang');
  const f = 'carousel.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  await s.typeAtEnd('p >> text=Card two', ' draft');
  const edited = original.replace('Card two<', 'Card two draft<');
  // Autosave runs shortly after the last change; wait until the stored draft holds the edit.
  // Polled from Node: waitForFunction would treat the IndexedDB promise itself as truthy.
  const draftHasEdit = () => s.page.evaluate(() => new Promise(res => {
    const r = indexedDB.open('gs9_editor');
    r.onsuccess = () => { try { const q = r.result.transaction('drafts').objectStore('drafts').getAll(); q.onsuccess = () => res(q.result.some(d => d.content?.includes('Card two draft'))); q.onerror = () => res(false); } catch { res(false); } };
    r.onerror = () => res(false);
  }));
  let stored = false;
  for (let i = 0; i < 40 && !(stored = await draftHasEdit()); i++) await s.page.waitForTimeout(250);
  check('bản nháp được ghi vào IndexedDB', stored);

  s.expectDialog('beforeunload', null, true, { optional: true });
  s.expectDialog('confirm', /carousel\.html/, true);
  await s.page.reload();
  await s.page.waitForFunction(() => document.querySelector('#btn-save').classList.contains('dirty') && document.body.dataset.docState === 'ready', null, { timeout: 20000 });
  const c = await s.content();
  check('khôi phục: nội dung nháp, dirty, đĩa chưa đổi', c === edited && disk(f) === original, firstDiff(c, edited));
  await s.close();
}

async function language(browser, url) {
  section('ngôn ngữ VI / EN / ZH');
  const s = await new Session(browser, url).start();
  await s.open(wpath('deck.html'));
  const label = () => s.page.evaluate(() => document.querySelector('#btn-save').textContent.trim());
  check('mặc định VI: nút "Lưu"', (await label()) === 'Lưu', await label());
  const attrs = () => s.page.evaluate(() => ({ title: document.querySelector('#btn-save').title, ph: document.querySelector('#find-q').placeholder, badge: document.querySelector('#mode-badge').textContent }));
  const vi = await attrs();
  check('VI: title/placeholder/badge tiếng Việt', /Lưu/.test(vi.title) && /Tìm/.test(vi.ph) && /Dạng slide/.test(vi.badge), JSON.stringify(vi));
  for (const [lang, want, ph] of [['en', 'Save', /find|search/i], ['zh', '保存', /[\u4e00-\u9fff]/]]) {
    await s.page.click('#btn-lang');
    await s.page.click(`#pop-lang .lang-opt[data-lang="${lang}"]`);
    const a = await attrs();
    check(`${lang}: nút "${want}", title/placeholder/badge đổi theo`, (await label()) === want && a.title !== vi.title && ph.test(a.ph) && !/Dạng/.test(a.badge), `${await label()} ${JSON.stringify(a)}`);
  }
  await s.page.reload();
  await s.waitReady(wpath('deck.html'));
  check('reload giữ ngôn ngữ đã chọn (ZH)', (await label()) === '保存', await label());
  await s.close();
}

async function mutating(browser, url) {
  section('trang có script tự sửa DOM lúc chạy');
  const f = 'mutating.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  check('script của trang có chạy trong preview', (await s.frame.locator('#counter').textContent()) === '0' && (await s.frame.locator('.gen').count()) === 1);
  let c = await s.content();
  check('no-op: không lưu thay đổi runtime (style, node sinh, text)', c === original, firstDiff(c, original));

  await s.typeAtEnd('#static', '!');
  c = await s.content();
  const want = original.replace('>Static heading<', '>Static heading!<');
  check('sửa node có style runtime: chỉ chữ đổi, không lọt opacity', c === want, firstDiff(c, want));
  await s.undo();

  const toastText = () => s.page.textContent('#toast');
  const editable = sel => s.frame.locator(sel).first().evaluate(e => e.isContentEditable);

  await s.frame.locator('.gen').click();
  await s.page.keyboard.type('X');
  check('node do script sinh: không sửa được, không dirty, có báo lý do', !(await s.dirty()) && (await s.content()) === original && /script/i.test(await toastText()), await toastText());

  await s.frame.locator('#counter').click();
  check('node bị script đổi chữ (count-up 42→0): không vào chế độ sửa, báo lý do', !(await editable('#counter')) && /đổi nội dung/.test(await toastText()), await toastText());
  await s.page.keyboard.type('7');
  c = await s.content();
  check('count-up: gõ không lọt vào file (hết lỗi lưu "07")', c === original && !(await s.dirty()), firstDiff(c, original));

  await s.frame.locator('#host').click({ position: { x: 5, y: 5 } });
  check('khối có con do script chèn vào: khoá sửa chữ', !(await editable('#host')) && /chèn/.test(await toastText()), await toastText());

  await s.frame.locator('#list li', { hasText: 'Duplicated item' }).nth(1).click();
  check('clone trùng id chèn trước bản gốc: cả hai bị khoá (mơ hồ)', !(await s.frame.locator('#list li').nth(0).evaluate(e => e.isContentEditable)) && !(await s.frame.locator('#list li').nth(1).evaluate(e => e.isContentEditable)) && /nhân bản/.test(await toastText()), await toastText());

  await s.typeAtEnd('#ws', '!');
  c = await s.content();
  const wsWant = original.replace('C</p>\n<p id="later">', 'C!</p>\n<p id="later">');
  check('NBSP / entity / 2 khoảng trắng: không bị khoá nhầm, chỉ chữ đổi', c === wsWant, firstDiff(c, wsWant));
  await s.undo();

  await s.typeAtEnd('#later', ' typed');
  await s.frame.locator('body').evaluate(() => window.mutateLater());
  await s.page.keyboard.type('!');
  c = await s.content();
  check('script đổi chữ trong lúc đang gõ: không lưu gì, trả về nội dung file', c === original && !(await s.dirty()), firstDiff(c, original));
  check('… và báo, có nút sao chép chữ đã gõ', /trong lúc bạn gõ/.test(await toastText()) && (await s.page.locator('#toast .t-act').count()) === 1, await toastText());
  await s.page.click('#toast .t-act');
  const clip = await s.page.evaluate(() => navigator.clipboard.readText());
  check('nút sao chép cho đúng chữ user đã gõ (không phải chữ của script)', clip.includes('Later text typed') && !clip.includes('Changed by script'), JSON.stringify(clip));

  await s.typeAtEnd('#later2', ' u');
  await s.frame.locator('body').evaluate(() => window.synthInput());
  await s.page.keyboard.type('!');
  c = await s.content();
  check('script phát input giả: không được coi là user, không lưu "hacked"', c === original && c.includes('<p id="later2">Second later</p>'), firstDiff(c, original));

  await s.typeAtEnd('#echo', 'X');
  c = await s.content();
  check('handler của trang chèn node ngay khi user gõ: phát hiện, không lưu', c === original && c.includes('<p id="echo">Echo text</p>'), firstDiff(c, original));

  await s.typeAtEnd('#echo2', 'Y');
  c = await s.content();
  check('listener capture trên window của trang chèn node khi user gõ: phát hiện, không lưu', c === original && c.includes('<p id="echo2">Window echo</p>'), firstDiff(c, original));
  await s.close();
}

async function bootOrder(browser) {
  section('thứ tự mở file khi khởi động: ?file > --file > file lần trước > mặc định');
  const explicit = await startServer(['--file', path.join(WORK, 'deck.html')]);
  try {
    const s = await new Session(browser, explicit.url).start();
    await s.page.goto(explicit.url + '/');
    await s.waitReady(wpath('deck.html'));
    check('--file: mở đúng file truyền vào', true);
    await s.open(wpath('struct.html'));
    await s.page.goto(explicit.url + '/');
    await s.waitReady(wpath('deck.html'));
    check('--file thắng file lần trước', true);
    await s.page.goto(`${explicit.url}/?file=${encodeURIComponent(wpath('report.html'))}`);
    await s.waitReady(wpath('report.html'));
    check('?file thắng --file', true);
    await s.close();
  } finally { await stopServer(explicit); }

  const plain = await startServer();
  try {
    const s = await new Session(browser, plain.url).start();
    await s.open(wpath('carousel.html'));
    await s.page.goto(plain.url + '/');
    await s.waitReady(wpath('carousel.html'));
    check('không --file: mở lại file lần trước', true);
    await s.page.evaluate(p => localStorage.setItem('gs9_editor_last_file', p), wpath('missing.html'));
    await s.page.goto(plain.url + '/');
    // No --file and the last file is gone: nothing to fall back to, the file list opens.
    await s.page.waitForFunction(() => { const p = document.querySelector('#panel'); return p.classList.contains('open') && p.dataset.view === 'files'; }, null, { timeout: 15000 });
    const cfg = await s.page.evaluate(() => fetch('/api/config').then(r => r.json()));
    check('file lần trước không còn, không --file: mở danh sách file', cfg.default_path === null);
    await s.close();
  } finally { await stopServer(plain); }
}

// Present runs in its own iframe built from the model; the edit iframe (and undo) stays put.
async function present(browser, url) {
  section('present: iframe riêng, phím cho deck, giữ undo, không rò vào save');
  // Own copy: earlier scenarios save into deck.html.
  const f = 'present-deck.html';
  fs.copyFileSync(path.join(FIX, 'deck.html'), path.join(WORK, f));
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  const pf = () => s.page.frameLocator('.present-frame');
  const pEval = async (fn, arg) => (await s.presentFrame()).evaluate(fn, arg);
  const waitActive = () => s.page.waitForFunction(() => document.body.dataset.presentState === 'active', null, { timeout: 15000 });
  const waitGone = () => s.page.waitForFunction(() => !document.querySelector('.present-frame') && !document.body.dataset.presentState, null, { timeout: 10000 });
  const pIndex = () => s.page.evaluate(() => document.body.dataset.presentIndex);

  await s.frame.locator('#t1').evaluate(n => { n.__mark = 1; });
  await s.typeAtEnd('#t1', ' P');
  // Still typing (not committed) when present starts: the edit must be in the present copy.
  await s.page.click('#btn-present');
  await waitActive();
  check('present: iframe thứ hai, iframe edit vẫn còn', (await s.page.locator('.present-frame').count()) === 1 && (await s.page.locator('#frame').count()) === 1);
  // Presenting runs on the preview origin: no way to the editor's DOM or API from there.
  const iso = await pEval(async ([editor, file]) => {
    let parentBlocked = false;
    try { void parent.document.body; } catch { parentBlocked = true; }
    const st = await fetch(editor + '/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file, content: '<p>pwn</p>', force: true }) }).then(r => r.status, () => 'blocked');
    return { origin: location.origin, parentBlocked, st };
  }, [url, wpath(f)]);
  check('present: chạy trên origin riêng, không chạm được DOM/API editor, file không đổi', iso.origin !== url && iso.parentBlocked && iso.st !== 200 && disk(f) === original, JSON.stringify(iso));
  check('present: chữ đang gõ dở có trong bản trình chiếu', (await pf().locator('#t1').textContent()) === 'Alpha title P');
  check('present: <html> bản trình chiếu có ed-presenting, iframe edit thì không',
    await pEval(() => document.documentElement.classList.contains('ed-presenting')) &&
    !(await s.frame.locator('html').evaluate(h => h.classList.contains('ed-presenting'))));

  await s.page.keyboard.press('ArrowRight');
  await s.page.waitForFunction(() => document.body.dataset.presentIndex === '1', null, { timeout: 5000 }).catch(() => {});
  check('present: → sang slide 2 (phím tới iframe trình chiếu)', (await pIndex()) === '1' && (await pf().locator('text=Beta heading').isVisible()) && !(await pf().locator('#t1').isVisible()));
  await pf().locator('text=Beta heading').click();
  await s.page.waitForFunction(() => document.body.dataset.presentIndex === '2', null, { timeout: 5000 }).catch(() => {});
  check('present: click nền → slide 3', (await pIndex()) === '2' && (await pf().locator('text=Delta heading').isVisible()));
  check('present: editor không đổi slide khi đang trình chiếu', (await s.page.textContent('#page-count')).trim() === '1 / 3');

  await s.page.keyboard.press('Escape');
  await waitGone();
  check('thoát present: editor ở đúng slide đang chiếu (3 / 3)', (await s.page.textContent('#page-count')).trim() === '3 / 3');
  check('thoát present: node trong iframe edit vẫn là node cũ', await s.frame.locator('#t1').evaluate(n => n.__mark === 1));
  const v = original.replace('>Alpha title<', '>Alpha title P<');
  let c = await s.content();
  check('sau present: save chỉ có chữ đã sửa, không rò class/attr present', c === v, firstDiff(c, v));
  await s.undo();
  c = await s.content();
  check('sau present: undo vẫn hoàn tác sửa trước present', c === original && !(await s.dirty()), firstDiff(c, original));
  await s.redo();
  c = await s.content();
  check('sau present: redo vẫn còn', c === v, firstDiff(c, v));

  // Ctrl+S from inside the present frame saves the model and keeps presenting.
  await s.page.click('#btn-present');
  await waitActive();
  await s.page.keyboard.press('Control+s');
  await s.waitSaved();
  check('Ctrl+S trong present: lưu model, vẫn đang trình chiếu', disk(f) === v && (await s.page.locator('.present-frame').count()) === 1, firstDiff(disk(f), v));
  await s.page.keyboard.press('Escape');
  await waitGone();
  // Toggled twice in a row: the second click lands while the first session is still staging.
  await s.page.evaluate(() => { const b = document.querySelector('#btn-present'); b.click(); b.click(); });
  await s.page.waitForTimeout(600);
  check('bấm present 2 lần liên tiếp: không còn session treo', (await s.page.locator('.present-frame').count()) === 0 && !(await s.page.evaluate(() => document.body.dataset.presentState)));
  await s.close();

  const k = 'present-keys.html';
  const s2 = await new Session(browser, url).start();
  await s2.open(wpath(k));
  const pf2 = () => s2.page.frameLocator('.present-frame');
  const p2 = async fn => (await s2.presentFrame()).evaluate(fn);
  check('iframe edit: script deck chạy không có ed-presenting', !/ed-presenting/.test(await s2.frame.locator('html').evaluate(() => window.__classAtRun)));
  await s2.page.click('#btn-present');
  await s2.page.waitForFunction(() => document.body.dataset.presentState === 'active', null, { timeout: 15000 });
  check('present: script deck thấy ed-presenting ngay từ đầu', /ed-presenting/.test(await p2(() => window.__classAtRun)));
  await s2.page.keyboard.press('x');
  await s2.page.keyboard.press('ArrowRight');
  await s2.page.waitForFunction(() => document.body.dataset.presentIndex === '1', null, { timeout: 5000 }).catch(() => {});
  const keys = await p2(() => window.__keys.join(','));
  check('present: deck nhận phím của nó (x, ArrowRight) và vẫn chuyển slide', keys === 'x,ArrowRight' && (await s2.page.evaluate(() => document.body.dataset.presentIndex)) === '1', keys);
  check('present: slide tác giả để display:none vẫn hiện khi tới lượt', await pf2().locator('#p2').isVisible());
  await s2.page.keyboard.press('ArrowLeft');
  await s2.page.waitForFunction(() => document.body.dataset.presentIndex === '0', null, { timeout: 5000 }).catch(() => {});
  await pf2().locator('#act').click();
  await s2.page.waitForTimeout(200);
  check('present: click nút của deck không chuyển slide', (await p2(() => window.__acts)) === 1 && (await s2.page.evaluate(() => document.body.dataset.presentIndex)) === '0');
  await s2.page.keyboard.press('Escape');
  await s2.page.waitForFunction(() => !document.querySelector('.present-frame'), null, { timeout: 10000 });
  c = await s2.content();
  check('present-keys: no-op sau present byte-identical', c === disk(k), firstDiff(c, disk(k)));
  await s2.close();

  // Untrusted (a file dropped in from outside the workspace): present runs without its scripts.
  const s3 = await new Session(browser, url).start();
  await s3.page.goto(`${url}/?file=${encodeURIComponent(wpath(f))}`);
  await s3.waitReady(wpath(f));
  const seq = await s3.seq();
  await s3.page.setInputFiles('#file-input', path.join(WORK, k));
  await s3.page.waitForFunction(([sq]) => document.body.dataset.docState === 'ready' && +document.body.dataset.docSeq > sq, [seq], { timeout: 30000 });
  await s3.page.click('#btn-present');
  await s3.page.waitForFunction(() => document.body.dataset.presentState === 'active', null, { timeout: 15000 });
  const ran = await (await s3.presentFrame()).evaluate(() => window.__ran === true);
  await s3.page.keyboard.press('ArrowRight');
  await s3.page.waitForFunction(() => document.body.dataset.presentIndex === '1', null, { timeout: 5000 }).catch(() => {});
  check('file ngoài workspace: present không chạy script tài liệu, điều hướng vẫn chạy', !ran && (await s3.page.evaluate(() => document.body.dataset.presentIndex)) === '1');
  await s3.page.keyboard.press('Escape');
  await s3.page.waitForFunction(() => !document.querySelector('.present-frame'), null, { timeout: 10000 });
  // Staging that never answers still ends inside the session's deadline, with a message.
  await s3.page.route('**/api/preview', () => {});
  await s3.page.click('#btn-present');
  await s3.page.waitForFunction(() => !document.body.dataset.presentState, null, { timeout: 15000 }).catch(() => {});
  check('/api/preview treo: present tự huỷ sau hạn chờ, có báo lỗi',
    !(await s3.page.evaluate(() => document.body.dataset.presentState)) && /trình chiếu/.test(await s3.page.textContent('#toast')), await s3.page.textContent('#toast'));
  await s3.page.unroute('**/api/preview');
  await s3.close();
}

// Reveal.js deck: the edit preview intercepts Reveal's runtime; present runs it.
async function reveal(browser, url) {
  section('Reveal: chặn runtime khi sửa, leaf dọc, notes, khoá ngoài subset, present bằng Reveal thật');
  const f = 'reveal.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  const count = async () => (await s.page.textContent('#page-count')).trim();
  check('mở: dạng slide, 6 leaf (stack dọc tách thành 2)', /slide/i.test(await s.page.textContent('#mode-badge')) && (await count()) === '1 / 6', await count());
  let c = await s.content();
  check('no-op: byte-identical', c === original, firstDiff(c, original));
  const rt = await s.frame.locator('html').evaluate(() => ({ st: window.__htmldeckReveal, ready: document.querySelector('.reveal').classList.contains('ready'), present: !!document.querySelector('.slides section.present') }));
  check('khung sửa: Reveal.initialize bị chặn (không ready, không class present)', rt.st?.intercepted && rt.st?.initCalls === 1 && !rt.ready && !rt.present, JSON.stringify(rt));
  const merged = await s.frame.locator('html').evaluate(() => { Reveal.configure({ width: 1200, center: false }); Reveal.initialize({ controls: false }); return window.__htmldeckReveal.config; });
  check('stub: configure() trước initialize() được gộp, không bị ghi đè', merged.width === 1200 && merged.center === false, JSON.stringify(merged));
  await s.select('#frag');
  await s.frame.locator('#frag').press('Escape');
  await s.page.click('#tb-fx');
  await s.page.selectOption('#fx-preset', 'fade-in');
  check('FX lên fragment Reveal: bị từ chối, có lý do', /fragment/.test(await s.page.textContent('#toast')) && (await s.content()) === original, await s.page.textContent('#toast'));
  await s.page.keyboard.press('Escape');
  check('khung sửa: fragment hiện để sửa', (await s.frame.locator('#frag').evaluate(e => getComputedStyle(e).opacity)) === '1');
  const top = await s.frame.locator('#s1').evaluate(e => parseFloat(getComputedStyle(e).top));
  check('khung sửa: slide được căn giữa dọc như Reveal (top > 0)', top > 50, String(top));
  const bg = await s.frame.locator('.reveal').evaluate(e => getComputedStyle(e).backgroundColor);
  check('khung sửa: data-background-color hiển thị', bg === 'rgb(18, 52, 86)', bg);
  const thumbBg = await s.page.frameLocator('#filmstrip .thumb >> nth=1 >> iframe').locator('body').evaluate(b => getComputedStyle(b).backgroundColor).catch(e => e.message);
  check('thumbnail: có style theme Reveal (nền tối)', /^rgb\((\d+), \1, \1\)$/.test(thumbBg) && parseInt(thumbBg.slice(4)) < 60, thumbBg);

  await s.typeAtEnd('#r1', ' X');
  await s.frame.locator('#r1').press('Escape');
  let want = original.replace('>Reveal one<', '>Reveal one X<');
  c = await s.content();
  check('sửa chữ slide 1: chỉ chữ đổi', c === want, firstDiff(c, want));
  await s.page.click('#sb-next');
  check('slide 2 = leaf dọc đầu tiên', (await count()) === '2 / 6' && (await s.frame.locator('#r2a').isVisible()));
  await s.typeAtEnd('#r2a', '!');
  await s.frame.locator('#r2a').press('Escape');
  want = want.replace('>Down A<', '>Down A!<');
  c = await s.content();
  check('sửa chữ trong leaf dọc: chỉ chữ đổi', c === want, firstDiff(c, want));

  await s.page.click('#sb-next');
  await s.page.click('#sb-notes');
  check('notes data-notes: đọc từ thuộc tính', (await s.page.inputValue('#notes-text')) === 'Attr note');
  await s.page.fill('#notes-text', 'Attr note 2');
  await s.page.locator('#notes-text').blur();
  want = want.replace('data-notes="Attr note"', 'data-notes="Attr note 2"');
  c = await s.content();
  check('notes data-notes: chỉ thuộc tính đổi', c === want, firstDiff(c, want));
  await s.page.click('#sb-prev'); await s.page.click('#sb-prev');
  check('notes aside: đọc từ aside.notes', (await s.page.inputValue('#notes-text')) === 'Note one');
  await s.page.click('#sb-notes');

  // Slide 5 (auto-animate): duplicating the data-id box is refused.
  for (let i = 0; i < 4; i++) await s.page.click('#sb-next');
  await s.frame.locator('#s4 .box').click({ modifiers: ['Alt'], position: { x: 6, y: 6 } });
  await s.page.keyboard.press('Control+d');
  c = await s.content();
  check('auto-animate: nhân bản khối có data-id bị từ chối, có lý do', c === want && /auto-animate/.test(await s.page.textContent('#toast')), await s.page.textContent('#toast'));
  await s.page.keyboard.press('Escape');
  await s.page.click('#sb-next');
  await s.frame.locator('#s5 textarea').click({ modifiers: ['Alt'] });
  await s.page.keyboard.press('Delete');
  c = await s.content();
  check('markdown: không xoá được, báo lý do', c === want && /Markdown/.test(await s.page.textContent('#toast')), await s.page.textContent('#toast'));
  await s.page.keyboard.press('Escape');
  await s.page.click('#sb-notes');
  check('markdown: notes trong slide markdown không sửa được', await s.page.isDisabled('#notes-text'));
  await s.page.click('#sb-notes');

  // Present with the deck's own Reveal: starts on the current leaf, Reveal navigates.
  const pf = () => s.page.locator('.present-frame');
  const idx = () => s.page.evaluate(() => document.body.dataset.presentIndex);
  const waitIdx = v => s.page.waitForFunction(v => document.body.dataset.presentIndex === v, v, { timeout: 5000 }).catch(() => {});
  await s.page.click('#filmstrip .thumb >> nth=1');
  await s.page.click('#btn-present');
  await s.page.waitForFunction(() => document.body.dataset.presentState === 'active', null, { timeout: 15000 });
  const live = await (await s.presentFrame()).evaluate(() => ({ ready: document.querySelector('.reveal').classList.contains('ready'), i: window.Reveal.getIndices() }));
  check('present: báo slide Markdown bị tách nhiều trang', /tách/.test(await s.page.textContent('#toast')), await s.page.textContent('#toast'));
  check('present: Reveal thật đã init, bắt đầu ở leaf dọc (h1 v0)', live.ready && live.i.h === 1 && live.i.v === 0 && (await idx()) === '1', JSON.stringify(live));
  check('present: chữ đã sửa có trong bản trình chiếu', (await s.page.frameLocator('.present-frame').locator('#r2a').textContent()) === 'Down A!');
  await s.page.keyboard.press('ArrowDown');
  await waitIdx('2');
  check('present: ↓ (Reveal) sang leaf dọc 2', (await idx()) === '2');
  await s.page.keyboard.press('ArrowRight');
  await waitIdx('4');
  check('present: → bỏ qua slide hidden, tới auto-animate (leaf 5)', (await idx()) === '4', await idx());
  await s.page.keyboard.press('Escape');
  await s.page.waitForFunction(() => !document.querySelector('.present-frame'), null, { timeout: 10000 });
  check('thoát present: editor ở leaf 5', (await count()) === '5 / 6');
  c = await s.content();
  check('sau present: save đúng các sửa, không rò runtime Reveal', c === want, firstDiff(c, want));

  await s.page.click('#filmstrip .thumb >> nth=3');
  await s.page.click('#btn-present');
  await s.page.waitForFunction(() => document.body.dataset.presentState === 'active', null, { timeout: 15000 });
  check('present từ slide hidden: bắt đầu ở leaf kế tiếp Reveal có', (await idx()) === '4', await idx());
  await s.page.keyboard.press('Escape');
  await s.page.waitForFunction(() => !document.querySelector('.present-frame'), null, { timeout: 10000 });
  await s.close();

  // ES module Reveal: not interceptable → the edit view is read-only, present still works.
  const m = 'reveal-esm.html';
  const s2 = await new Session(browser, url).start();
  await s2.open(wpath(m));
  await s2.page.waitForTimeout(300);
  check('Reveal ESM: báo chỉ xem', /chỉ xem/.test(await s2.page.textContent('#toast')), await s2.page.textContent('#toast'));
  await s2.frame.locator('#m1').click({ force: true });
  await s2.page.keyboard.type('Z');
  c = await s2.content();
  check('Reveal ESM: gõ không sửa được, file nguyên vẹn', c === disk(m) && !(await s2.dirty()), firstDiff(c, disk(m)));
  await s2.page.click('#btn-present');
  await s2.page.waitForFunction(() => document.body.dataset.presentState === 'active', null, { timeout: 15000 }).catch(() => {});
  check('Reveal ESM: present vẫn chạy (không đồng bộ chỉ số)', (await s2.page.evaluate(() => document.body.dataset.presentState)) === 'active');
  await s2.page.keyboard.press('Escape');
  await s2.close();
}

// Effects: data-fx attributes from the editor, an opt-in runtime block, present playback.
async function effects(browser, url) {
  section('FX: gán hiệu ứng, xem thử, bật FX có chủ đích, chạy khi trình chiếu, dispose sạch');
  const f = 'fx.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  const frameAnims = () => s.frame.locator('html').evaluate(() => document.getAnimations().length);
  const setFx = async (sel, preset, extra = {}, position) => {
    await s.frame.locator(sel).click({ modifiers: ['Alt'], position });
    if (await s.page.isHidden('#pop-fx')) await s.page.click('#tb-fx');
    await s.page.selectOption('#fx-preset', preset);
    for (const [k, v] of Object.entries(extra)) { await s.page.fill(k, v); await s.page.locator(k).dispatchEvent('change'); }
  };
  await s.page.click('#sb-next');
  await setFx('#f2', 'fade-up', { '#fx-delay': '200' });
  let want = original.replace('<p id="f2" class="moved">', '<p id="f2" class="moved" data-fx="fade-up" data-fx-delay="200">');
  let c = await s.content();
  check('gán fade-up + trễ: chỉ thêm data-fx*', c === want, firstDiff(c, want));
  await s.page.click('#fx-preview');
  check('xem thử: có animation trên node trong khung sửa', (await frameAnims()) > 0);
  await s.page.keyboard.press('Escape');
  await s.page.click('#sizer', { position: { x: 5, y: 5 } }).catch(() => {});
  await s.page.waitForTimeout(100);
  check('bỏ chọn: xem thử bị huỷ, khung sửa không còn animation', (await frameAnims()) === 0);
  await s.undo();
  c = await s.content();
  check('undo: gỡ cả preset và trễ (một bước)', c === original, firstDiff(c, original));
  await s.redo();

  await s.page.click('#filmstrip .thumb >> nth=2');
  await setFx('#f3', 'count-up');
  check('count-up trên chữ không có số: bị từ chối, có lý do', /Count up/.test(await s.page.textContent('#toast')) && !(await s.content()).includes('id="f3" data-fx'));
  await s.page.keyboard.press('Escape');
  await s.page.click('#filmstrip .thumb >> nth=1');
  await setFx('#num', 'count-up');
  await s.page.click('#fx-preview');
  check('xem thử count-up: không ghi text (xem dạng fade)', (await s.frame.locator('#num').textContent()) === '1.250,5 ₫' && (await frameAnims()) > 0);
  await setFx('#list', 'fade-in', { '#fx-stagger': '120' }, { x: 8, y: 6 });   // the list's padding, not an item
  want = want.replace('<p id="num">', '<p id="num" data-fx="count-up">').replace('<ul id="list">', '<ul id="list" data-fx="fade-in" data-fx-stagger="120">');
  c = await s.content();
  check('count-up + stagger: đúng thuộc tính', c === want, firstDiff(c, want));

  await s.page.click('.rail-item[data-panel="effects"]');
  const items = await s.page.locator('#fx-list .fx-item').count();
  check('panel hiệu ứng: liệt kê 3 hiệu ứng của slide', items === 3, String(items));
  await s.page.click('.rail-item[data-panel="effects"]');

  // Enable FX in the file: one script block, inert in the edit frame.
  await s.page.click('#fx-doc-btn');
  await s.page.click('#fx-modal-ok');
  const withFx = await s.content();
  const block = withFx.match(/<script data-htmldeck-fx="\d+">[\s\S]*?<\/script>/);
  check('bật FX: thêm đúng một khối script, phần còn lại không đổi', !!block && withFx.split('data-htmldeck-fx=').length === 2 && withFx.replace(block[0], '') === want, block ? firstDiff(withFx.replace(block[0], ''), want) : 'không có khối');
  const inert = await s.frame.locator('html').evaluate(() => ({ type: document.querySelector('script[data-htmldeck-fx]')?.type, fx: !!window.__htmldeckFx, anims: document.getAnimations().length }));
  check('khung sửa: script FX inert, runtime không chạy', inert.type === 'text/x-htmldeck-inert' && !inert.fx && inert.anims === 0, JSON.stringify(inert));
  await s.saveKey();
  await s.waitSaved();

  // Present: effects run on the current slide only; dispose leaves nothing behind.
  await s.page.click('#btn-present');
  await s.page.waitForFunction(() => document.body.dataset.presentState === 'active', null, { timeout: 15000 });
  const pf = s.page.locator('.present-frame');
  const pe = async fn => (await s.presentFrame()).evaluate(fn);
  const early = await pe(() => ({ n: document.getAnimations().length, endOpacity: document.getAnimations().map(a => a.effect.getKeyframes().at(-1).opacity).filter(Boolean), num: document.querySelector('#num').textContent, runtimes: document.querySelectorAll('script[data-htmldeck-fx]').length }));
  check('present: slide 2 chạy hiệu ứng, count-up đang đếm', early.n > 0 && early.num !== '1.250,5 ₫', JSON.stringify(early));
  check('present: fade kết thúc ở opacity của tác giả (không 0 → 0)', early.endOpacity.length > 0 && early.endOpacity.every(o => o === '1'), JSON.stringify(early.endOpacity));
  await s.page.waitForTimeout(1600);
  const late = await pe(() => ({ n: document.getAnimations().length, num: document.querySelector('#num').textContent, wait: document.querySelectorAll('[data-ed-cur] .fx-wait').length }));
  check('present: hết hiệu ứng → không còn animation, text gốc, không còn phần tử bị ẩn', late.n === 0 && late.num === '1.250,5 ₫' && late.wait === 0, JSON.stringify(late));
  for (const k of ['End', 'Home', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowRight']) await s.page.keyboard.press(k);
  await s.page.waitForTimeout(100);
  const fast = await pe(() => document.getAnimations().filter(a => !a.effect.target.closest('[data-ed-cur]')).length);
  check('nhảy nhanh: slide không hiện không còn animation', fast === 0, String(fast));
  const gone = await pe(() => { window.__htmldeckFx.dispose(); return { n: document.getAnimations().length, wait: document.querySelectorAll('.fx-wait').length, on: document.documentElement.classList.contains('fx-on'), num: document.querySelector('#num').textContent }; });
  check('dispose: không animation, không class FX, text gốc', gone.n === 0 && gone.wait === 0 && !gone.on && gone.num === '1.250,5 ₫', JSON.stringify(gone));
  await s.page.keyboard.press('Escape');
  await s.page.waitForFunction(() => !document.querySelector('.present-frame'), null, { timeout: 10000 });

  // The saved file runs its effects on its own; reduced motion shows everything at once.
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion });
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', e => errs.push(e.message));
    await pg.goto(`${url}/${wpath(f)}`);
    await pg.locator('#f2').scrollIntoViewIfNeeded();
    await pg.waitForTimeout(150);
    const st = await pg.evaluate(() => ({ fx: !!window.__htmldeckFx, on: document.documentElement.classList.contains('fx-on'), n: document.getAnimations().length }));
    check(`file độc lập (${reducedMotion}): ${reducedMotion === 'reduce' ? 'không animate, không ẩn' : 'runtime chạy khi cuộn tới'}`,
      st.fx && !errs.length && (reducedMotion === 'reduce' ? !st.on && st.n === 0 : st.on && st.n > 0), JSON.stringify(st) + errs.join(' | '));
    await ctx.close();
  }

  // Disable FX: back to the file without the block.
  await s.page.click('#filmstrip .thumb >> nth=1');
  await s.select('#f2');
  await s.frame.locator('#f2').press('Escape');
  await s.page.click('#tb-fx');
  await s.page.click('#fx-doc-btn');
  c = await s.content();
  check('tắt FX: gỡ đúng khối đã thêm', c === want, firstDiff(c, want));
  await s.close();
}

// Edit mode shows motion in its end state; presenting plays it.
async function motion(browser, url) {
  section('khung sửa đóng băng chuyển động (CSS, transition, WAAPI); trình chiếu vẫn chạy');
  const f = 'motion.html';
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  await s.page.waitForTimeout(800);
  const st = await s.frame.locator('html').evaluate(() => {
    const anim = id => document.getElementById(id).getAnimations()[0];
    return {
      mode: window.__mode,
      fade: getComputedStyle(document.getElementById('fadein')).opacity,
      spin: anim('spinner')?.playState,
      waapi: anim('waapi')?.playState,
      trans: getComputedStyle(document.getElementById('trans')).color,
      waapiOpacity: getComputedStyle(document.getElementById('waapi')).opacity,
      loops: window.__loops(), late: window.__late.playState, lateOpacity: getComputedStyle(document.getElementById('late')).opacity,
    };
  });
  check('khung sửa: tài liệu thấy __HTMLDECK__.mode = edit', st.mode === 'edit', JSON.stringify(st));
  check('khung sửa: animation fill-forwards hiện trạng thái cuối (không bị ẩn)', st.fade === '1', st.fade);
  check('khung sửa: animation vô hạn tạm dừng', st.spin === 'paused', st.spin);
  check('khung sửa: transition và WAAPI của script dừng ở trạng thái cuối', st.trans === 'rgb(255, 0, 0)' && st.waapi === 'paused' && st.waapiOpacity === '1', JSON.stringify(st));
  check('khung sửa: vòng lặp await animation.finished không quay (không treo)', st.loops <= 2, String(st.loops));
  check('khung sửa: animation bị play() lại cũng bị dừng ở cuối', st.late === 'paused' && st.lateOpacity === '1', JSON.stringify(st));
  const c = await s.content();
  check('khung sửa: đóng băng không ghi gì vào file (no-op byte-identical)', c === disk(f), firstDiff(c, disk(f)));
  await s.page.click('#btn-present');
  await s.page.waitForFunction(() => document.body.dataset.presentState === 'active', null, { timeout: 15000 });
  const p = await (await s.presentFrame()).evaluate(() => ({ mode: window.__mode, fade: document.getElementById('fadein').getAnimations()[0]?.playState, spin: document.getElementById('spinner').getAnimations()[0]?.playState }));
  check('trình chiếu: chuyển động chạy bình thường', p.mode === 'none' && p.fade === 'running' && p.spin === 'running', JSON.stringify(p));
  await s.page.keyboard.press('Escape');
  await s.close();
}

// Scenes: author code whose lifecycle the FX runtime owns (start on show, stop + restore on leave).
async function scenesSpec(browser, url) {
  section('FX scene: không chạy khi sửa; trình chiếu chạy, rời slide dừng + trả markup; panel hiệu ứng');
  const f = 'scenes.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  await s.page.click('#sb-next');
  await s.page.waitForTimeout(300);
  check('khung sửa: scene không chạy', (await s.frame.locator('html').evaluate(() => window.__ticks)) === 0 && (await s.frame.locator('#tick').textContent()) === '0');
  await s.page.click('.rail-item[data-panel="effects"]');
  check('panel hiệu ứng: liệt kê scene của slide', /scene: ticker/.test(await s.page.textContent('#fx-list')), await s.page.textContent('#fx-list'));
  await s.page.click('.rail-item[data-panel="effects"]');

  await s.page.click('#btn-present');
  await s.page.waitForFunction(() => document.body.dataset.presentState === 'active', null, { timeout: 15000 });
  const pf = s.page.locator('.present-frame');
  const pe = async fn => (await s.presentFrame()).evaluate(fn);
  await s.page.waitForTimeout(400);
  const run = await pe(() => ({ ticks: window.__ticks, text: document.querySelector('#tick').textContent }));
  check('trình chiếu: scene chạy trên slide hiện tại', run.ticks > 2 && run.text !== '0', JSON.stringify(run));
  await s.page.keyboard.press('ArrowRight');
  await s.page.waitForTimeout(150);
  const left = await pe(() => ({ ticks: window.__ticks, text: document.querySelector('#tick').textContent, bodyAnims: document.body.getAnimations().length }));
  await s.page.waitForTimeout(300);
  const later = await pe(() => window.__ticks);
  check('rời slide: scene dừng (không còn tick), markup về bản tác giả', later === left.ticks && left.text === '0', JSON.stringify({ left, later }));
  check('rời slide: animation scene tạo qua ctx (kể cả ngoài slide) bị huỷ', left.bodyAnims === 0, String(left.bodyAnims));
  await s.page.keyboard.press('ArrowLeft');
  await s.page.waitForTimeout(300);
  const back = await pe(() => window.__ticks);
  check('quay lại slide: scene chạy lại', back > later, `${later} → ${back}`);
  await s.page.keyboard.press('Escape');
  await s.page.waitForFunction(() => !document.querySelector('.present-frame'), null, { timeout: 10000 });
  const c = await s.content();
  check('sau trình chiếu: file không đổi', c === original, firstDiff(c, original));
  await s.close();
}

// Remote scripts: blocked in the edit frame by the server's CSP unless the file is trusted.
async function remoteScriptsSpec(browser, url) {
  section('script nguồn ngoài: tắt trong khung sửa (CSP, cả tải động), tin file → bật; file HTML gốc bị sandbox');
  const f = 'cdn.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  await s.page.waitForTimeout(500);
  const st = () => s.frame.locator('html').evaluate(() => ({ inline: !!window.__inline, anime: !!window.anime, dyn: window.__dyn, fetch: window.__fetch }));
  let r = await st();
  check('khung sửa: script nội tuyến chạy, script ngoài (tĩnh + động + fetch) bị chặn', r.inline && !r.anime && r.dyn === 'blocked' && r.fetch === 'blocked', JSON.stringify(r));
  check('khung sửa: chip "Script ngoài: tắt" + toast có nút tin', !(await s.page.isHidden('#sb-trust')) && /tắt/.test(await s.page.textContent('#sb-trust')) && /Tin file này/.test(await s.page.textContent('#toast')));
  s.expectDialog('confirm', /Tin file này/, true);
  const seq = await s.seq();
  await s.page.click('#sb-trust');
  await s.waitReady(wpath(f), seq);
  await s.page.waitForTimeout(500);
  r = await st();
  check('tin file: script ngoài được phép (tải động chạy), chip báo đang bật', r.dyn === 'loaded' && /bật/.test(await s.page.textContent('#sb-trust')), JSON.stringify(r));
  const c = await s.content();
  check('tin/không tin không đổi file', c === original, firstDiff(c, original));
  // Untrusting asks to drop undo history; cancelling keeps the frame and the stored trust as is.
  await s.typeAtEnd('#c1', '!');
  await s.frame.locator('#c1').press('Escape');
  s.expectDialog('confirm', null, false);
  await s.page.click('#sb-trust');
  await s.page.waitForTimeout(300);
  check('huỷ đổi quyền: chip và khung sửa giữ chế độ đang chạy', /bật/.test(await s.page.textContent('#sb-trust')) && (await st()).dyn === 'loaded');
  await s.close();

  // The raw file on the editor origin is sandboxed (opaque origin): its scripts cannot use the API.
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto(`${url}/${wpath(f)}`);
  const raw = await pg.evaluate(async ([file]) => {
    const st = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file, content: '<p>pwn</p>', force: true }) }).then(r => r.status, () => 'blocked');
    return { origin: self.origin, st };   // the document's origin (location.origin is the URL's)
  }, [wpath(f)]);
  check('file HTML gốc trên origin editor: origin null, gọi API bị từ chối, file không đổi', raw.origin === 'null' && raw.st !== 200 && disk(f) === original, JSON.stringify(raw));
  await ctx.close();
}

// HTML the parser repairs (stray </p>, </br>): edits still patch only what changed.
async function malformed(browser, url) {
  section('HTML sai chuẩn (</p>, </br> thừa): no-op giữ nguyên, sửa vẫn vá đúng chỗ');
  const f = 'malformed.html';
  const original = disk(f);
  const s = await new Session(browser, url).start();
  await s.open(wpath(f));
  let c = await s.content();
  check('no-op: byte-identical', c === original, firstDiff(c, original));
  await s.typeAtEnd('#m-after', '!');
  await s.frame.locator('#m-after').press('Escape');
  let want = original.replace('>Paragraph after the stray end tag<', '>Paragraph after the stray end tag!<');
  c = await s.content();
  check('sửa đoạn ngay sau </p> thừa: chỉ chữ đó đổi (không ghi lại cả file)', c === want, firstDiff(c, want));
  await s.typeAtEnd('#m-last', '?');
  await s.frame.locator('#m-last').press('Escape');
  want = want.replace('>Last paragraph<', '>Last paragraph?<');
  c = await s.content();
  check('sửa đoạn sau </br> thừa: chỉ chữ đó đổi', c === want, firstDiff(c, want));
  await s.close();
}

async function realFiles(browser) {
  section(`file thật trong workspace ${REAL_ROOT}: no-op serialization`);
  const real = await startServer([], REAL_ROOT);
  const url = real.url;
  try {
  for (const f of REAL_FILES) {
    if (!fs.existsSync(path.join(REAL_ROOT, f))) { check(`${f} tồn tại`, false); continue; }
    const s = await new Session(browser, url).start();
    await s.open(f);
    const raw = fs.readFileSync(path.join(REAL_ROOT, f), 'utf8');
    const c = await s.content();
    const badge = await s.page.textContent('#mode-badge');
    check(`${f} [${badge}]: byte-identical, không dirty`, c === raw && !(await s.dirty()), firstDiff(c, raw));
    if (f.endsWith('ai-foundation-deck.html')) {
      // Its animations are scenes registered from its script: the effects panel lists them,
      // even with the CDN script (anime.js) off in the edit view.
      await s.page.click('#filmstrip .thumb >> nth=10');
      await s.page.click('.rail-item[data-panel="effects"]');
      const list = await s.page.textContent('#fx-list');
      check(`${f}: panel hiệu ứng thấy scene của slide 11 (script ngoài đang tắt)`, /scene: ai-foundation/.test(list) && /Trình chiếu/.test(list), list.slice(0, 160));
      await s.page.click('.rail-item[data-panel="effects"]');
      await s.page.click('#filmstrip .thumb >> nth=0');
      // The deck animates (anime.js) only while presenting: none of it may reach the edit side.
      await s.page.click('#btn-present');
      await s.page.waitForFunction(() => document.body.dataset.presentState === 'active', null, { timeout: 15000 });
      for (let i = 0; i < 3; i++) { await s.page.keyboard.press('ArrowRight'); await s.page.waitForTimeout(700); }
      const idx = await s.page.evaluate(() => document.body.dataset.presentIndex);
      await s.page.keyboard.press('Escape');
      await s.page.waitForFunction(() => !document.querySelector('.present-frame'), null, { timeout: 10000 });
      const after = await s.content();
      // Opened on its own, the deck's scenes run through its FX runtime as the slides scroll in.
      const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const pg = await ctx2.newPage();
      const errs = [];
      pg.on('pageerror', e => errs.push(e.message));
      await pg.goto(`${url}/${f}`);
      await pg.waitForTimeout(800);
      const cover = await pg.evaluate(() => ({ fx: !!window.__htmldeckFx, running: window.anime ? window.anime.running.length : -1 }));
      await pg.locator('.slide[data-anim]').nth(8).scrollIntoViewIfNeeded();
      await pg.waitForTimeout(900);
      const away = await pg.evaluate(() => window.anime.running.filter(a => a.animatables.some(x => x.target.closest && x.target.closest('.slide') === document.querySelector('.slide[data-anim]'))).length);
      check(`${f}: mở độc lập → scene chạy; rời slide bìa → animation lặp của bìa dừng`, cover.fx && cover.running > 0 && away === 0 && !errs.length, JSON.stringify({ cover, away, errs }));
      await ctx2.close();
      check(`${f}: present 3 slide có animation rồi thoát → về slide 4, vẫn byte-identical`,
        idx === '3' && (await s.page.textContent('#page-count')).trim().startsWith('4 /') && after === raw && !(await s.dirty()), `idx=${idx} ${firstDiff(after, raw)}`);
    }
    await s.close();
  }
  } finally { await stopServer(real); }
}

// ---------------------------------------------------------------- main
let server, browser;
try {
  for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(WORK, f));
  // reveal.js inside the workspace (the server never serves files outside it).
  for (const d of ['dist', 'plugin']) fs.cpSync(path.join(ROOT, 'node_modules/reveal.js', d), path.join(WORK, 'reveal', d), { recursive: true });
  server = await startServer(['--test-hooks']);
  browser = await chromium.launch();
  if (!args.has('--real-only')) {
    for (const scenario of [detection, textColourHistory, modeSwitch, structural, conflict, rewriteFallback, saveInFlight, failedStep, failedSingleStep, draftRestore, language, mutating, present, reveal, effects, motion, scenesSpec, remoteScriptsSpec, malformed]) {
      try { await scenario(browser, server.url); }
      catch (e) { failures.push(`${scenario.name} dừng giữa chừng: ${e.message.split('\n')[0]}`); console.log(`  ✖ ${scenario.name} dừng giữa chừng: ${e.message.split('\n')[0]}`); }
    }
    try { await bootOrder(browser); }
    catch (e) { failures.push(`bootOrder dừng giữa chừng: ${e.message.split('\n')[0]}`); console.log(`  ✖ bootOrder: ${e.message.split('\n')[0]}`); }
  }
  if (!args.has('--fixtures-only')) {
    if (REAL_ROOT && REAL_FILES.length) await realFiles(browser);
    else console.log('\n┌─ file thật: bỏ qua (đặt HTMLDECK_REAL_ROOT và HTMLDECK_REAL_FILES để chạy)');
  }
} catch (e) {
  failures.push(`dừng giữa chừng: ${e.message.split('\n')[0]}`);
  console.log(`  ✖ dừng giữa chừng: ${e.stack}`);
} finally {
  await browser?.close();
  await stopServer(server);
  fs.rmSync(WORK, { recursive: true, force: true });
}

if (passed === 0) failures.push('không chạy được check nào');
console.log(`\n${failures.length ? '✖' : '✔'} ${passed} pass, ${failures.length} fail${known.length ? `, ${known.length} known` : ''}`);
if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
