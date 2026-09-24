// SPEC-445 / T-746: 文案瘦身 + en 首字母大写 静态断言
// F1 三段删除（subTagline / loadingNote / elapsedBox）DOM+i18n+CSS+JS 零残留
// F2 footerNote 全删 + seoFooter 元素 sr-only（视觉删、爬虫保留）
// F3 en UI 文案首字母大写（品牌词 botu 小写，zh 段不动）
// F4 资产版本 v=444→v=445
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

// ── F1/F2: 删除项零残留 ──────────────────────────────
test('F1/F2: subTagline/loadingNote/elapsedBox/elapsedFmt/footerNote 零残留（DOM+JS+i18n），css .elapsed 规则已删', () => {
  const gone = ['subTagline', 'loadingNote', 'elapsedBox', 'elapsedFmt', 'footerNote'];
  for (const name of gone) {
    for (const [file, src] of [['index.html', html], ['js/i18n.js', i18nJs], ['js/app.js', appJs]]) {
      assert.ok(!src.includes(name), `${file} 应无 ${name}`);
    }
  }
  assert.ok(!/\.elapsed\s*\{/.test(css), 'css 无 .elapsed 规则');
  assert.ok(!/\.footnote/.test(css), 'css 无 .footnote 规则');
});

test('F2: seoFooter 元素带 sr-only（视觉隐藏、爬虫可读）', () => {
  assert.match(html, /class="foot-seo sr-only"[^>]*data-i18n="seoFooter"/);
});

// ── F3: en 首字母大写 ──────────────────────────────
test('F3: en UI 文案首字母大写（12 键抽查 + loadingHints），品牌词 botu 保持小写', () => {
  const keys = [
    'beforeLabel', 'afterLabel', 'dropActive', 'idleHint', 'generate', 'regenerate',
    'download', 'newImage', 'galleryTitle', 'errRead', 'themeAriaToLight', 'quotaOut',
  ];
  for (const k of keys) {
    assert.match(DICT.en[k], /^[A-Z]/, `en.${k} 应首字母大写`);
  }
  for (const hint of DICT.en.loadingHints) {
    assert.match(hint, /^[A-Z]/, 'en.loadingHints 首字母大写');
  }
  assert.equal(DICT.en.appTitle, 'botu', '品牌词 botu 小写');
  // zh 段不受影响
  assert.equal(DICT.zh.beforeLabel, '原图');
  assert.equal(DICT.zh.generate, '生成图标');
});

// ── F4: 资产版本 ──────────────────────────────
test('F4: css/js ?v=445 在场，v=444 零残留', () => {
  assert.match(html, /css\/style\.css\?v=445/);
  assert.match(html, /js\/app\.js\?v=445/);
  assert.ok(!html.includes('v=444'), 'index.html v=444 零残留');
});
