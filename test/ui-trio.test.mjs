// SPEC-444 / T-745: botu UI 三件套静态断言
// F1 work 区横排（.pair nowrap + slot 收缩 + img min(240px,38vw)）
// F2 done 态零占位符（resultPh 物理 remove/重建 + #resultBox:has(img) .ph CSS 兜底）
// F3 gallerySub 三处零残留 / F4 资产版本 v=444
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

// ── F1 work 区横排 ──────────────────────────────
test('F1: work 顶层 .pair 规则 flex-wrap:nowrap（与 .gcard .pair.sm / .btnrow 区分）', () => {
  const m = css.match(/(?:^|\n)\.pair\s*\{([^}]*)\}/);
  assert.ok(m, '顶层 .pair 规则在场');
  assert.match(m[1], /flex-wrap:\s*nowrap/, '.pair 含 nowrap');
  assert.ok(!m[1].includes('flex-wrap: wrap'), '.pair 不含 wrap');
});

test('F1: .slot 可收缩 + .slotbox min-width:0 + img max-width:min(240px,38vw)（旧 240px/40vw 策略零残留）', () => {
  const slot = css.match(/(?:^|\n)\.slot\s*\{([^}]*)\}/);
  assert.ok(slot, '.slot 规则在场');
  assert.match(slot[1], /flex:\s*0 1 auto/, '.slot flex 收缩');
  assert.match(slot[1], /min-width:\s*0/, '.slot min-width:0');
  assert.ok(!css.includes('min-width: 240px'), 'slotbox 旧 min-width:240px 零残留');
  assert.match(css, /\.slotbox img\s*\{[^}]*max-width:\s*min\(240px,\s*38vw\)/, 'img 收缩上限');
  assert.ok(!css.includes('40vw'), '@560 旧 40vw 双策略零残留（单一 min(240px,38vw)）');
});

// ── F2 done 态零占位符 ──────────────────────────
test('F2: CSS 兜底 #resultBox:has(img) .ph display:none!important 在场', () => {
  assert.match(css, /#resultBox:has\(img\)\s+\.ph\s*\{[^}]*display:\s*none\s*!important/, ':has(img) 兜底规则');
});

test('F2: app.js 物理 remove + 模板常量重建（旧 hidden=true 无效路径零残留）', () => {
  assert.ok(appJs.includes('const RESULT_PH_SVG ='), 'RESULT_PH_SVG 模板常量在场');
  assert.match(appJs, /if \(ph\) ph\.remove\(\);/, 'showResult 物理移除占位');
  assert.ok(appJs.includes("insertAdjacentHTML('afterbegin', RESULT_PH_SVG)"), 'clearResult 不存在则重建并 prepend');
  assert.ok(!/^\s*\$\('resultPh'\)\.hidden = true/m.test(appJs), '旧 hidden=true 代码行零残留（注释提及根因不算）');
});

test('F2: app.js RESULT_PH_SVG 与 index.html 内联 SVG markup 逐字一致（gallery-v4 W3\u0027 pin 不回归）', () => {
  const m = html.match(/id="resultBox">(<svg[\s\S]*?<\/svg>)/);
  assert.ok(m, 'index.html resultBox 首子节点为内联 SVG');
  assert.ok(appJs.includes(m[1]), 'RESULT_PH_SVG 与 index.html SVG 逐字一致');
});

// ── F3 gallerySub 零残留 ────────────────────────
test('F3: gallerySub 在 index.html / js/i18n.js / test/i18n.test.js 三处零残留', () => {
  for (const [name, src] of [['index.html', html], ['js/i18n.js', i18nJs], ['test/i18n.test.js', i18nTest]]) {
    assert.ok(!src.includes('gallerySub'), `${name} 仍含 gallerySub`);
  }
});

// ── F4 资产版本 bump ────────────────────────────
test('F4: index.html css/js ?v=444 两处 bump、v=439 零残留（favicon ?v=433 / gallery ?v=437 不动）', () => {
  assert.match(html, /css\/style\.css\?v=444/, 'style.css?v=444');
  assert.match(html, /js\/app\.js\?v=444/, 'app.js?v=444');
  assert.ok(!html.includes('v=439'), 'index.html v=439 零残留');
  assert.match(html, /favicon\.png\?v=433/, 'favicon 版本不动');
  const galleryRefs = [...html.matchAll(/src="gallery\/[^"]+"/g)].map((x) => x[0]);
  assert.equal(galleryRefs.length, 8, 'gallery 8 张引用不动');
  for (const r of galleryRefs) assert.match(r, /\.webp\?v=437"/, r);
});

// ── 不回归 ──────────────────────────────────────
test('不回归: SPEC-442 [hidden]{display:none!important} 与 gallery .pair.sm 横排先例在场', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, '[hidden] 语义恢复规则保留');
  assert.match(css, /\.gcard \.pair\.sm\s*\{[^}]*flex-wrap:\s*nowrap/, 'gallery 横排先例保留');
});
