// SPEC-444 / T-745: botu UI trio static assertions
// F1 horizontal work area (.pair nowrap + shrinkable slots + img min(240px,38vw))
// F2 zero placeholders in the done state (resultPh physically removed/rebuilt + the #resultBox:has(img) .ph CSS fallback)
// F3 zero gallerySub residue in three places / F4 asset version v=445
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const css = read('css/style.css');
const html = read('index.html');
const appJs = read('js/app.js');
const i18nJs = read('js/i18n.js');
const i18nTest = read('test/i18n.test.js');

// ── F1 horizontal work area ──────────────────────────────
test('F1: the top-level work .pair rule is flex-wrap:nowrap (distinct from .gcard .pair.sm / .btnrow)', () => {
  const m = css.match(/(?:^|\n)\.pair\s*\{([^}]*)\}/);
  assert.ok(m, 'the top-level .pair rule is present');
  assert.match(m[1], /flex-wrap:\s*nowrap/, '.pair contains nowrap');
  assert.ok(!m[1].includes('flex-wrap: wrap'), '.pair does not contain wrap');
});

test('F1: .slot shrinkable + .slotbox min-width:0 + img max-width:min(240px,38vw) (zero residue of the old 240px/40vw strategy)', () => {
  const slot = css.match(/(?:^|\n)\.slot\s*\{([^}]*)\}/);
  assert.ok(slot, 'the .slot rule is present');
  assert.match(slot[1], /flex:\s*0 1 auto/, '.slot flex shrink');
  assert.match(slot[1], /min-width:\s*0/, '.slot min-width:0');
  assert.ok(!css.includes('min-width: 240px'), 'zero residue of the old slotbox min-width:240px');
  assert.match(css, /\.slotbox img\s*\{[^}]*max-width:\s*min\(240px,\s*38vw\)/, 'the img shrink cap');
  assert.ok(!css.includes('40vw'), 'zero residue of the old @560 40vw dual strategy (single min(240px,38vw))');
});

// ── F2 zero placeholders in the done state ──────────────────────────
test('F2: the CSS fallback #resultBox:has(img) .ph display:none!important is present', () => {
  assert.match(css, /#resultBox:has\(img\)\s+\.ph\s*\{[^}]*display:\s*none\s*!important/, 'the :has(img) fallback rule');
});

test('F2: app.js uses physical remove + template-constant rebuild (zero residue of the ineffective hidden=true path)', () => {
  assert.ok(appJs.includes('const RESULT_PH_SVG ='), 'the RESULT_PH_SVG template constant is present');
  assert.match(appJs, /if \(ph\) ph\.remove\(\);/, 'showResult physically removes the placeholder');
  assert.ok(appJs.includes("insertAdjacentHTML('afterbegin', RESULT_PH_SVG)"), 'clearResult rebuilds and prepends when missing');
  assert.ok(!/^\s*\$\('resultPh'\)\.hidden = true/m.test(appJs), 'zero residue of the old hidden=true code line (root-cause mentions in comments do not count)');
});

test('F2: app.js RESULT_PH_SVG is byte-identical to the inline SVG markup in index.html (the gallery-v4 W3\u0027 pin does not regress)', () => {
  const m = html.match(/id="resultBox">(<svg[\s\S]*?<\/svg>)/);
  assert.ok(m, 'index.html resultBox first child is the inline SVG');
  assert.ok(appJs.includes(m[1]), 'RESULT_PH_SVG matches the index.html SVG byte for byte');
});

// ── F3 zero gallerySub residue ────────────────────────
test('F3: zero gallerySub residue in index.html / js/i18n.js / test/i18n.test.js', () => {
  for (const [name, src] of [['index.html', html], ['js/i18n.js', i18nJs], ['test/i18n.test.js', i18nTest]]) {
    assert.ok(!src.includes('gallerySub'), `${name} still contains gallerySub`);
  }
});

// ── F4 asset version bump ────────────────────────────
test('F4: index.html css/js both bumped to ?v=445, zero v=444 residue (favicon ?v=433 / gallery ?v=437 unchanged)', () => {
  assert.match(html, /css\/style\.css\?v=445/, 'style.css?v=445');
  assert.match(html, /js\/app\.js\?v=445/, 'app.js?v=445');
  assert.ok(!html.includes('v=444'), 'index.html has zero v=444 residue');
  assert.match(html, /favicon\.png\?v=433/, 'the favicon version is unchanged');
  const galleryRefs = [...html.matchAll(/src="gallery\/[^"]+"/g)].map((x) => x[0]);
  assert.equal(galleryRefs.length, 8, 'the 8 gallery refs are unchanged');
  for (const r of galleryRefs) assert.match(r, /\.webp\?v=437"/, r);
});

// ── no regressions ──────────────────────────────────────
test('no regression: SPEC-442 [hidden]{display:none!important} and the gallery .pair.sm horizontal precedent are present', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'the [hidden] semantics-restore rule is preserved');
  assert.match(css, /\.gcard \.pair\.sm\s*\{[^}]*flex-wrap:\s*nowrap/, 'the gallery horizontal precedent is preserved');
});
