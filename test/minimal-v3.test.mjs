// test/minimal-v3.test.mjs — SPEC-432 W4 minimal-restyle static assertions
// Zero residue of terminal vocabulary / font stack / wrangler compat / gallery md5 anchors / ?v=432 versioning / asset-reference consistency / theme mechanism preserved
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const md5 = (p) => createHash('md5').update(readFileSync(join(ROOT, p))).digest('hex');

const SURFACE = {
  'index.html': read('index.html'),
  'css/style.css': read('css/style.css'),
  'js/app.js': read('js/app.js'),
  'js/i18n.js': read('js/i18n.js'),
};

test('zero residue of terminal vocabulary: scanline/crt/ASCII face/prompt copy/bracket labels/terminal chrome', () => {
  const banned = [/scanline/i, /\bcrt\b/i, 'dz-ascii', 'termwin', 'termbar', 'termpath', 'ps1',
    '$ botu', 'ls ./gallery', '▮', '⠋', '[OK]', '[ERR]', '[QUOTA]', '[☾', '[☀'];
  for (const [f, src] of Object.entries(SURFACE)) {
    for (const b of banned) {
      const hit = b instanceof RegExp ? b.test(src) : src.includes(b);
      assert.ok(!hit, `${f} still contains terminal token: ${String(b)}`);
    }
  }
});

test('zero residue of the old fluorescent-green/amber high-saturation colors', () => {
  const oldColors = ['#3fb950', '#1a7f37', '#d29922', '#9a6700', '#0d1117', '#f6f1e7', 'rgba(63, 185, 80'];
  for (const [f, src] of Object.entries(SURFACE)) {
    const low = src.toLowerCase();
    for (const c of oldColors) assert.ok(!low.includes(c.toLowerCase()), `${f} still contains old color ${c}`);
  }
});

test('font stack: starts with system-ui + ends with sans-serif (zero external webfonts)', () => {
  assert.match(SURFACE['css/style.css'],
    /system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif/);
  assert.match(SURFACE['css/style.css'], /font-family: var\(--sans\)/);
  assert.ok(!/@import|fonts\.googleapis|fonts\.gstatic/.test(SURFACE['css/style.css']), 'no external fonts');
});

test('no serif (except the sans-serif substring) / Courier / monospace site-wide', () => {
  for (const [f, src] of Object.entries(SURFACE)) {
    assert.ok(!/(?<![-\w])serif/i.test(src), `${f} contains a standalone serif declaration`);
    assert.ok(!/Courier|monospace|SFMono|\bMenlo\b|Consolas/i.test(src), `${f} contains a mono font`);
  }
});

test('wrangler.toml: compatibility_date + nodejs_compat present', () => {
  const w = read('wrangler.toml');
  assert.match(w, /^compatibility_date = "\d{4}-\d{2}-\d{2}"$/m);
  assert.match(w, /^compatibility_flags = \["nodejs_compat"\]$/m);
});

test('gallery swap anchor: icon-1 WebP md5 == the SPEC-437 final value and ≤ 120000B (PNG retired; icon-2/5 deleted in SPEC-433 W4)', () => {
  assert.equal(md5('gallery/icon-1.webp'), '6ac6ab74c0217941eb773bf886675dee');
  assert.ok(readFileSync(join(ROOT, 'gallery/icon-1.webp')).length <= 120000, 'icon-1 size gate');
});

test('gallery frozen anchors: icon-3/4/6 + char-1/3/4/6 WebP md5 == the SPEC-437 final values (surviving set)', () => {
  const ORIG = {
    'gallery/icon-3.webp': 'ad67f9e8b552779a365d5079629afd37',
    'gallery/icon-4.webp': '04ced5895b37ae4fc7cbec5e57acd9b7',
    'gallery/icon-6.webp': 'd54d04363924fd3613f5372c7c5546a8',
    'gallery/char-1.webp': '180dcaeb4fcfa0c192a7fef281a7fc6e',
    'gallery/char-3.webp': '8ae57f22a682dd9e8f7ddcbea24dea7b',
    'gallery/char-4.webp': 'f04678c56a08fe5724c60c1839967481',
    'gallery/char-6.webp': '8f5d2b17c14b410f7b3441b0da6c7df1',
  };
  for (const [p, h] of Object.entries(ORIG)) assert.equal(md5(p), h, `${p} was modified`);
});

test('?v=445 css / ?v=445 js / ?v=437 gallery present (favicon stays at 433, content unchanged)', () => {
  const html = SURFACE['index.html'];
  for (const a of ['css/style.css?v=445', 'js/app.js?v=445', 'favicon.png?v=433']) {
    assert.ok(html.includes(`"${a}"`), `missing versioned ref: ${a}`);
  }
  const refs = [...html.matchAll(/src="(gallery\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(refs.length, 8, '8 gallery images (4 samples × before/after)');
  for (const r of refs) assert.match(r, /\.webp\?v=437$/, r);
});

test('?v=432 zero residue (html/js/css/tests)', () => {
  for (const f of ['index.html', 'js/app.js', 'js/i18n.js', 'js/upload.js', 'css/style.css', 'test/seo.test.mjs']) {
    assert.ok(!read(f).includes('v=432'), `${f} still contains v=432`);
  }
});

test('asset references match existing files: favicon / og-image / gallery', () => {
  const html = SURFACE['index.html'];
  assert.ok(existsSync(join(ROOT, 'favicon.png')), 'favicon.png exists');
  assert.ok(html.includes('href="favicon.png?v=433"'), 'the favicon ref is present');
  assert.ok(existsSync(join(ROOT, 'og-image.png')), 'og-image.png exists');
  assert.ok(html.includes('https://botu.openclawd.co/og-image.png'), 'the og:image ref is present');
  const files = [...html.matchAll(/src="gallery\/([^"?]+)\?v=/g)].map((m) => m[1]);
  assert.equal(files.length, 8);
  for (const f of files) assert.ok(existsSync(join(ROOT, 'gallery', f)), `gallery/${f} exists`);
});

test('theme-switch mechanism preserved: botu-theme key + the anti-flash inline script in head', () => {
  assert.ok(SURFACE['js/app.js'].includes("'botu-theme'"), 'app.js keeps the botu-theme key');
  assert.match(SURFACE['index.html'], /localStorage\.getItem\('botu-theme'\)/);
  assert.match(SURFACE['index.html'], /setAttribute\('data-theme'/);
});
