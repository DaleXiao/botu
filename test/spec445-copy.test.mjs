// SPEC-445 / T-746: copy slimming + en capitalization static assertions
// F1 three removals (subTagline / loadingNote / elapsedBox) with zero residue across DOM+i18n+CSS+JS
// F2 footerNote fully removed + the seoFooter element is sr-only (visually removed, kept for crawlers)
// F3 en UI copy capitalized (the brand word botu stays lowercase; the zh section is untouched)
// F4 asset versions v=444→v=445
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICT } from '../js/i18n.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const html = read('index.html');
const css = read('css/style.css');
const appJs = read('js/app.js');
const i18nJs = read('js/i18n.js');

// ── F1/F2: zero residue of removed items ──────────────────────────────
test('F1/F2: zero residue of subTagline/loadingNote/elapsedBox/elapsedFmt/footerNote (DOM+JS+i18n); the css .elapsed rule is deleted', () => {
  const gone = ['subTagline', 'loadingNote', 'elapsedBox', 'elapsedFmt', 'footerNote'];
  for (const name of gone) {
    for (const [file, src] of [['index.html', html], ['js/i18n.js', i18nJs], ['js/app.js', appJs]]) {
      assert.ok(!src.includes(name), `${file} should not contain ${name}`);
    }
  }
  assert.ok(!/\.elapsed\s*\{/.test(css), 'the css has no .elapsed rule');
  assert.ok(!/\.footnote/.test(css), 'the css has no .footnote rule');
});

test('F2: the seoFooter element carries sr-only (visually hidden, readable by crawlers)', () => {
  assert.match(html, /class="foot-seo sr-only"[^>]*data-i18n="seoFooter"/);
});

// ── F3: en capitalization ──────────────────────────────
test('F3: en UI copy capitalized (12-key spot check + loadingHints); the brand word botu stays lowercase', () => {
  const keys = [
    'beforeLabel', 'afterLabel', 'dropActive', 'idleHint', 'generate', 'regenerate',
    'download', 'newImage', 'galleryTitle', 'errRead', 'themeAriaToLight', 'quotaOut',
  ];
  for (const k of keys) {
    assert.match(DICT.en[k], /^[A-Z]/, `en.${k} should start capitalized`);
  }
  for (const hint of DICT.en.loadingHints) {
    assert.match(hint, /^[A-Z]/, 'en.loadingHints start capitalized');
  }
  assert.equal(DICT.en.appTitle, 'botu', 'the brand word botu is lowercase');
  // The zh section is unaffected
  assert.equal(DICT.zh.beforeLabel, '原图');
  assert.equal(DICT.zh.generate, '生成图标');
});

// ── F4: asset versions ──────────────────────────────
test('F4: css/js ?v=445 present, zero v=444 residue', () => {
  assert.match(html, /css\/style\.css\?v=445/);
  assert.match(html, /js\/app\.js\?v=445/);
  assert.ok(!html.includes('v=444'), 'index.html has zero v=444 residue');
});
