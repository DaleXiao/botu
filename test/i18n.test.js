// test/i18n.test.js — zh/en 字典键集一致 + 关键键在场
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICT, detectLang, applyLang } from '../js/i18n.js';

test('DICT 含 zh 与 en', () => {
  assert.ok(DICT.zh && typeof DICT.zh === 'object');
  assert.ok(DICT.en && typeof DICT.en === 'object');
});

test('zh/en 键集完全一致', () => {
  assert.deepEqual(Object.keys(DICT.zh).sort(), Object.keys(DICT.en).sort());
});

test('除 loadingHints 数组外全部为非空字符串', () => {
  for (const lang of ['zh', 'en']) {
    for (const [k, v] of Object.entries(DICT[lang])) {
      if (k === 'loadingHints') {
        assert.ok(Array.isArray(v) && v.length >= 3, `${lang}.loadingHints`);
        for (const h of v) assert.ok(typeof h === 'string' && h.length > 0, `${lang}.loadingHints item`);
      } else {
        assert.ok(typeof v === 'string' && v.length > 0, `${lang}.${k}`);
      }
    }
  }
  assert.equal(DICT.zh.loadingHints.length, DICT.en.loadingHints.length);
});

test('关键键在场（SEO/UI/错误/画廊/footer）', () => {
  for (const k of ['seoTitle', 'appTitle', 'langBtn', 'tagline', 'subTagline', 'dropTitle', 'dropHint',
    'beforeLabel', 'afterLabel', 'idleHint', 'generate', 'regenerate', 'download', 'newImage',
    'loadingNote', 'elapsedFmt', 'fileMetaFmt', 'errRead', 'errType', 'err400', 'err413', 'err500',
    'err502', 'errNetwork', 'errGeneric', 'galleryTitle', 'gallerySub', 'cap1', 'cap2', 'cap3',
    'cap4', 'cap5', 'cap6', 'footerNote', 'seoFooter']) {
    assert.ok(k in DICT.zh, `zh.${k}`);
    assert.ok(k in DICT.en, `en.${k}`);
  }
});

test('seoTitle 双语均含关键词', () => {
  assert.match(DICT.zh.seoTitle, /bot icon/i);
  assert.match(DICT.zh.seoTitle, /机器人图标/);
  assert.match(DICT.en.seoTitle, /bot icon/i);
});

test('detectLang/applyLang 在 node 下可调用（DOM guard 不抛错）', () => {
  assert.equal(typeof detectLang, 'function');
  assert.equal(typeof applyLang, 'function');
  const lang = detectLang();
  assert.ok(['zh', 'en'].includes(lang), `detectLang -> ${lang}`);
  const d = applyLang(lang);
  assert.equal(d, DICT[lang]);
});
