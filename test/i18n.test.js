// test/i18n.test.js — zh/en dictionaries share the same key set + essential keys present
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICT, detectLang, applyLang } from '../js/i18n.js';

test('DICT contains zh and en', () => {
  assert.ok(DICT.zh && typeof DICT.zh === 'object');
  assert.ok(DICT.en && typeof DICT.en === 'object');
});

test('zh/en key sets are identical', () => {
  assert.deepEqual(Object.keys(DICT.zh).sort(), Object.keys(DICT.en).sort());
});

test('every value is a non-empty string except the loadingHints array', () => {
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

test('essential keys present (SEO/UI/errors/gallery/footer)', () => {
  for (const k of ['seoTitle', 'appTitle', 'langBtn', 'tagline', 'dropTitle', 'dropHint',
    'beforeLabel', 'afterLabel', 'idleHint', 'generate', 'regenerate', 'download', 'newImage',
    'fileMetaFmt', 'errRead', 'errType', 'err400', 'err413', 'err500',
    'err502', 'errNetwork', 'errGeneric', 'galleryTitle', 'cap1', 'cap2', 'cap3',
    'cap4', 'seoFooter',
    'err429', 'themeAriaToLight', 'themeAriaToDark', 'quotaFmt', 'quotaOut',
    'errTimeout', 'errJobFailed', 'errJobGone']) {
    assert.ok(k in DICT.zh, `zh.${k}`);
    assert.ok(k in DICT.en, `en.${k}`);
  }
});

test('SPEC-431 new-key formats: quota/err429 placeholders complete, theme aria non-empty', () => {
  for (const lang of ['zh', 'en']) {
    assert.match(DICT[lang].quotaFmt, /\{n\}/, `${lang}.quotaFmt {n}`);
    assert.match(DICT[lang].quotaFmt, /\{max\}/, `${lang}.quotaFmt {max}`);
    assert.match(DICT[lang].quotaOut, /\{max\}/, `${lang}.quotaOut {max}`);
    assert.match(DICT[lang].err429, /\{max\}/, `${lang}.err429 {max}`);
    assert.ok(DICT[lang].themeAriaToLight.length > 3, `${lang}.themeAriaToLight`);
    assert.ok(DICT[lang].themeAriaToDark.length > 3, `${lang}.themeAriaToDark`);
  }
});

test('seoTitle contains the keywords in both languages', () => {
  assert.match(DICT.zh.seoTitle, /bot icon/i);
  assert.match(DICT.zh.seoTitle, /机器人图标/);
  assert.match(DICT.en.seoTitle, /bot icon/i);
});

test('detectLang/applyLang are callable under node (the DOM guards do not throw)', () => {
  assert.equal(typeof detectLang, 'function');
  assert.equal(typeof applyLang, 'function');
  const lang = detectLang();
  assert.ok(['zh', 'en'].includes(lang), `detectLang -> ${lang}`);
  const d = applyLang(lang);
  assert.equal(d, DICT[lang]);
});
