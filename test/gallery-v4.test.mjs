// test/gallery-v4.test.mjs — SPEC-433/T-733 W4+W3' static assertions
// The gallery has exactly 4 entries 01–04 / deleted sample files are gone with zero references / the 8 surviving WebPs match the SPEC-437 final md5s /
// horizontal in-card structure (DOM order + nowrap) / 2×2 grid + 1 column on narrow screens / W3' result box uses an inline SVG placeholder, no empty-src <img>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const md5 = (p) => createHash('md5').update(readFileSync(join(ROOT, p))).digest('hex');

const html = read('index.html');
const css = read('css/style.css');
const appJs = read('js/app.js');

test('the gallery has exactly 4 entries, numbered 01–04, cap keys cap1–cap4 in order', () => {
  assert.equal(html.split('class="gcard"').length - 1, 4);
  const idx = [...html.matchAll(/<span class="idx">(\d+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(idx, ['01', '02', '03', '04']);
  const caps = [...html.matchAll(/data-i18n="(cap\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(caps, ['cap1', 'cap2', 'cap3', 'cap4']);
});

test('deleted samples (02 Shiba / 05 Fox) do not exist and have zero references site-wide', () => {
  for (const f of ['char-2.png', 'char-5.png', 'icon-2.png', 'icon-5.png']) {
    assert.equal(existsSync(join(ROOT, 'gallery', f)), false, `gallery/${f} should be deleted`);
  }
  for (const p of ['index.html', 'js/app.js', 'js/i18n.js', 'js/upload.js', 'css/style.css']) {
    const src = read(p);
    for (const tok of ['char-2', 'char-5', 'icon-2', 'icon-5', 'cap5', 'cap6']) {
      assert.ok(!src.includes(tok), `${p} still references ${tok}`);
    }
  }
});

test('the 8 surviving WebPs match the SPEC-437 final md5s (byte-frozen zone); the 512px PNGs are retired', () => {
  const ORIG = {
    'gallery/icon-1.webp': '6ac6ab74c0217941eb773bf886675dee',
    'gallery/icon-3.webp': 'ad67f9e8b552779a365d5079629afd37',
    'gallery/icon-4.webp': '04ced5895b37ae4fc7cbec5e57acd9b7',
    'gallery/icon-6.webp': 'd54d04363924fd3613f5372c7c5546a8',
    'gallery/char-1.webp': '180dcaeb4fcfa0c192a7fef281a7fc6e',
    'gallery/char-3.webp': '8ae57f22a682dd9e8f7ddcbea24dea7b',
    'gallery/char-4.webp': 'f04678c56a08fe5724c60c1839967481',
    'gallery/char-6.webp': '8f5d2b17c14b410f7b3441b0da6c7df1',
  };
  for (const [p, h] of Object.entries(ORIG)) assert.equal(md5(p), h, `${p} was modified`);
  for (const n of ['icon-1', 'icon-3', 'icon-4', 'icon-6', 'char-1', 'char-3', 'char-4', 'char-6']) {
    assert.equal(existsSync(join(ROOT, `gallery/${n}.png`)), false, `gallery/${n}.png should be retired (SPEC-437 WebP migration)`);
  }
});

test('horizontal in-card structure: char img → horizontal arrow → icon img (paired by number), CSS nowrap forbids wrapping', () => {
  const re = /<div class="pair sm"><img src="gallery\/char-(\d+)\.webp[^"]*"[^>]*><div class="arrow"[^>]*>→<\/div><img src="gallery\/icon-\1\.webp[^"]*"[^>]*><\/div>/g;
  const nums = [...html.matchAll(re)].map((m) => Number(m[1]));
  assert.deepEqual(nums, [1, 3, 4, 6], 'all 4 cards use the input→arrow→output horizontal DOM order');
  assert.match(css, /\.gcard \.pair\.sm \{[^}]*flex-wrap: nowrap/, 'the in-card comparison must not wrap (v3 stacked vertically — the breakage cause)');
  assert.match(css, /\.gcard \.pair\.sm \.arrow \{ flex: none; \}/, 'the arrow never shrinks');
});

test('2×2 grid: exactly 2 columns on desktop; 1 column at ≤640px', () => {
  assert.match(css, /\.grid \{ display: grid; grid-template-columns: repeat\(2, 1fr\)/);
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.grid \{ grid-template-columns: 1fr; \}/);
});

test("W3': the result box's initial DOM is an inline SVG placeholder (currentColor follows the theme), no empty-src <img>", () => {
  assert.match(html, /id="resultBox"><svg[^>]*id="resultPh"/, 'resultBox first child is the inline SVG');
  const svgBlock = html.slice(html.indexOf('id="resultPh"'), html.indexOf('</svg>', html.indexOf('id="resultPh"')));
  assert.ok(svgBlock.includes('currentColor'), 'the SVG uses currentColor to follow the theme');
  assert.ok(!html.includes('xlink:href') && !/<img[^>]*id="resultPh"/.test(html), 'the placeholder is not an external bitmap');
  // Every <img> in the initial DOM must carry a non-empty src (the 8 gallery images); no static srcPreview/resultImg nodes exist
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 8);
  for (const tag of imgs) assert.match(tag, /src="[^"]+"/, 'an empty-src img is not allowed');
  assert.ok(!html.includes('srcPreview') && !html.includes('resultImg'), 'the result/before imgs are both rendered dynamically');
});

test("W3': app.js state transitions never set an empty src (error/pending fall back to the SVG placeholder)", () => {
  for (const fn of ['function renderBefore', 'function clearResult', 'function showResult']) {
    assert.ok(appJs.includes(fn), `app.js is missing ${fn}`);
  }
  assert.ok(!appJs.includes(".src = ''") && !appJs.includes('.src = ""'), 'never assigns an empty src');
  assert.ok(!appJs.includes("removeAttribute('src')"), 'never uses removeAttribute(src) to create a broken image');
  assert.match(appJs, /img\.src = url;/, 'src is set only when done (showResult)');
  assert.match(appJs, /clearResult\(\); \/\/ 等待期结果框显 SVG 占位/, 'the pending state explicitly falls back to the placeholder');
});
