// test/seo.test.mjs — SPEC-430 SEO static assertions
// Full head suite / sr-only h1 / bilingual footer / robots / sitemap / og-image IHDR / zero external links / ?v=437 versioning / gallery assets committed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DICT } from '../js/i18n.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('index.html');
const css = read('css/style.css');

test('head: the title contains both keywords — bot icon + the Chinese robot-icon phrase', () => {
  const m = html.match(/<title>([^<]+)<\/title>/);
  assert.ok(m, 'has <title>');
  assert.match(m[1], /bot icon/i);
  assert.match(m[1], /机器人图标/);
});

test('head: the description contains the Chinese selling points + an English sentence', () => {
  const m = html.match(/<meta name="description" content="([^"]+)">/);
  assert.ok(m && m[1].length > 40, 'description non-empty and >40 chars');
  assert.match(m[1], /免费/);
  assert.match(m[1], /无需注册/);
  assert.match(m[1], /free/i);
});

test('head: canonical points at the production domain itself', () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/botu\.openclawd\.co\/">/);
});

test('head: og:* complete (type/site_name/title/description/url/image 1200x630+alt/locale×2)', () => {
  for (const p of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image']) {
    assert.match(html, new RegExp(`<meta property="${p}" content="[^"]+"`), p);
  }
  assert.match(html, /property="og:image" content="https:\/\/botu\.openclawd\.co\/og-image\.png"/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);
  assert.match(html, /property="og:image:alt" content="[^"]+"/);
  assert.match(html, /property="og:locale" content="zh_CN"/);
  assert.match(html, /property="og:locale:alternate" content="en_US"/);
});

test('head: twitter card complete', () => {
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  for (const n of ['twitter:title', 'twitter:description', 'twitter:image']) {
    assert.match(html, new RegExp(`name="${n}" content="[^"]+"`), n);
  }
});

test('head: one theme-color each for light/dark', () => {
  assert.match(html, /name="theme-color" media="\(prefers-color-scheme: light\)" content="#[0-9a-fA-F]{6}"/);
  assert.match(html, /name="theme-color" media="\(prefers-color-scheme: dark\)" content="#[0-9a-fA-F]{6}"/);
});

test('head: the JSON-LD WebApplication parses with all fields', () => {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'has inline JSON-LD');
  const ld = JSON.parse(m[1]);
  assert.equal(ld['@type'], 'WebApplication');
  assert.equal(ld.url, 'https://botu.openclawd.co/');
  assert.equal(ld.name, 'botu');
  assert.ok(Array.isArray(ld.inLanguage) && ld.inLanguage.includes('zh-CN') && ld.inLanguage.includes('en'));
  assert.equal(ld.offers.price, '0');
  assert.ok(Array.isArray(ld.featureList) && ld.featureList.length >= 3);
  assert.ok(ld.description.length > 20);
});

test('the sr-only h1 exists with bilingual keywords; the CSS has the .sr-only utility class', () => {
  const m = html.match(/<h1 class="sr-only">([^<]+)<\/h1>/);
  assert.ok(m, 'has sr-only h1');
  assert.match(m[1], /Bot Icon Generator/i);
  assert.match(m[1], /机器人图标/);
  assert.match(css, /\.sr-only\s*\{/);
});

test('footer: seoFooter crawlable in both dictionaries + visually hidden via sr-only in HTML; zero footerNote residue', () => {
  for (const lang of ['zh', 'en']) {
    assert.ok(DICT[lang].seoFooter.length > 60, `${lang}.seoFooter`);
    assert.match(DICT[lang].seoFooter, /botu/i);
    assert.ok(!('footerNote' in DICT[lang]), `${lang}.footerNote should be deleted`);
  }
  assert.match(html, /<p class="foot-seo sr-only" data-i18n="seoFooter">/);
  assert.doesNotMatch(html, /footerNote/);
  assert.doesNotMatch(html, /footnote/);
});

test('robots.txt: allow all + a Sitemap line', () => {
  const r = read('robots.txt');
  assert.match(r, /User-agent: \*/);
  assert.match(r, /Allow: \//);
  assert.match(r, /Sitemap: https:\/\/botu\.openclawd\.co\/sitemap\.xml/);
});

test('sitemap.xml: production domain + lastmod', () => {
  const s = read('sitemap.xml');
  assert.match(s, /<loc>https:\/\/botu\.openclawd\.co\/<\/loc>/);
  assert.match(s, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
});

test('og-image.png: IHDR dimensions are exactly 1200×630', () => {
  const buf = readFileSync(join(ROOT, 'og-image.png'));
  assert.equal(buf.readUInt32BE(16), 1200, 'width');
  assert.equal(buf.readUInt32BE(20), 630, 'height');
});

test('favicon.png exists', () => {
  assert.ok(existsSync(join(ROOT, 'favicon.png')));
});

test('_headers: no-cache for all paths', () => {
  const h = read('_headers');
  assert.match(h, /^\/\*/m);
  assert.match(h, /Cache-Control: no-cache/);
});

test('zero external links: every src/href is a relative path (except canonical)', () => {
  const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 12, `captured ${refs.length} refs`); // SPEC-433 W4: canonical+favicon+css+8 gallery+app.js
  for (const r of refs) {
    if (r === 'https://botu.openclawd.co/') continue; // canonical
    assert.ok(!/^(https?:)?\/\//.test(r), `external ref not allowed: ${r}`);
  }
});

test('asset versioning: css ?v=445 / js ?v=445 / gallery ?v=437, favicon ?v=433 (content unchanged)', () => {
  for (const a of ['css/style.css?v=445', 'js/app.js?v=445', 'favicon.png?v=433']) {
    assert.ok(html.includes(`"${a}"`), `versioned ref missing: ${a}`);
  }
  const galleryRefs = [...html.matchAll(/src="(gallery\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(galleryRefs.length, 8, '8 gallery imgs (4 pairs)');
  for (const r of galleryRefs) assert.match(r, /\.webp\?v=437$/, r);
});

test('gallery assets: all 4 char/icon WebP pairs (surviving set 1/3/4/6, SPEC-437 340px) exist and are non-empty', () => {
  for (const i of [1, 3, 4, 6]) {
    for (const kind of ['char', 'icon']) {
      const p = join(ROOT, `gallery/${kind}-${i}.webp`);
      assert.ok(existsSync(p), `${kind}-${i}.webp exists`);
      assert.ok(readFileSync(p).length > 1000, `${kind}-${i}.webp non-empty`);
    }
  }
});
