// test/btnrow.test.mjs — SPEC-442 / T-743 button-row fix static assertions
// Covers: the [hidden] semantics-restore rule is present / .btnrow .btn flex sharing (zero residue of the old min-width strategy) / style.css ?v=445 versioning
// Run: `node --test` at the repo root (like all existing tests; do not pass a directory argument)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('index.html');
const css = read('css/style.css');
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments so comment literals cannot interfere with the rule assertions

test('[hidden]: display none !important restore rule present', () => {
  const m = cssRules.match(/\[hidden\]\s*\{[^}]*\}/);
  assert.ok(m, 'style.css contains the [hidden] rule');
  assert.match(m[0], /display:\s*none\s*!important/, 'the [hidden] rule is display: none !important');
});

test('.btnrow .btn: flex sharing strategy (flex: 1 1 8.5em + max-width + min-width: 0)', () => {
  const m = cssRules.match(/\.btnrow \.btn\s*\{[^}]*\}/);
  assert.ok(m, 'style.css contains the .btnrow .btn rule');
  assert.match(m[0], /flex:\s*1 1 8\.5em/, 'flex: 1 1 8.5em sharing');
  assert.match(m[0], /max-width:\s*13em/, 'max-width: 13em cap');
  assert.match(m[0], /min-width:\s*0/, 'min-width: 0 allows shrinking');
  assert.match(m[0], /text-align:\s*center/, 'text centering preserved');
  assert.match(m[0], /padding-left:\s*10px/, 'narrower horizontal padding');
  assert.match(m[0], /padding-right:\s*10px/, 'narrower horizontal padding');
});

test('SPEC-441 old min-width 11.5em strategy has zero residue', () => {
  assert.ok(!css.includes('11.5em'), 'style.css contains no 11.5em anywhere');
});

test('index.html: style.css versioned ?v=445 (app.js?v=445 in sync)', () => {
  assert.match(html, /css\/style\.css\?v=445/, 'style.css?v=445');
  assert.ok(!html.includes('style.css?v=444'), 'zero residue of old version refs');
  assert.match(html, /js\/app\.js\?v=445/, 'app.js?v=445');
});
