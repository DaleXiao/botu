// test/seo.test.mjs — SPEC-430 SEO 静态断言
// head 全套 / sr-only h1 / footer 双语 / robots / sitemap / og-image IHDR / 零外链 / ?v=431 版本化 / gallery 入库
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

test('head: title 含 bot icon + 机器人图标 双关键词', () => {
  const m = html.match(/<title>([^<]+)<\/title>/);
  assert.ok(m, 'has <title>');
  assert.match(m[1], /bot icon/i);
  assert.match(m[1], /机器人图标/);
});

test('head: description 含中文卖点 + 英文句', () => {
  const m = html.match(/<meta name="description" content="([^"]+)">/);
  assert.ok(m && m[1].length > 40, 'description 非空且 >40 字符');
  assert.match(m[1], /免费/);
  assert.match(m[1], /无需注册/);
  assert.match(m[1], /free/i);
});

test('head: canonical 自指生产域名', () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/botu\.openclawd\.co\/">/);
});

test('head: og:* 齐全（type/site_name/title/description/url/image 1200x630+alt/locale×2）', () => {
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

test('head: twitter card 齐全', () => {
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  for (const n of ['twitter:title', 'twitter:description', 'twitter:image']) {
    assert.match(html, new RegExp(`name="${n}" content="[^"]+"`), n);
  }
});

test('head: theme-color light/dark 各一份', () => {
  assert.match(html, /name="theme-color" media="\(prefers-color-scheme: light\)" content="#[0-9a-fA-F]{6}"/);
  assert.match(html, /name="theme-color" media="\(prefers-color-scheme: dark\)" content="#[0-9a-fA-F]{6}"/);
});

test('head: JSON-LD WebApplication 可解析且字段齐', () => {
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

test('sr-only h1 存在且含双语关键词，CSS 有 .sr-only 工具类', () => {
  const m = html.match(/<h1 class="sr-only">([^<]+)<\/h1>/);
  assert.ok(m, 'has sr-only h1');
  assert.match(m[1], /Bot Icon Generator/i);
  assert.match(m[1], /机器人图标/);
  assert.match(css, /\.sr-only\s*\{/);
});

test('footer: 可爬双语文案（seoFooter/footerNote 双字典 + HTML 挂 data-i18n）', () => {
  for (const lang of ['zh', 'en']) {
    assert.ok(DICT[lang].seoFooter.length > 60, `${lang}.seoFooter`);
    assert.match(DICT[lang].seoFooter, /botu/i);
    assert.ok(DICT[lang].footerNote.length > 8, `${lang}.footerNote`);
  }
  assert.match(html, /data-i18n="seoFooter"/);
  assert.match(html, /data-i18n="footerNote"/);
});

test('robots.txt: allow all + Sitemap 行', () => {
  const r = read('robots.txt');
  assert.match(r, /User-agent: \*/);
  assert.match(r, /Allow: \//);
  assert.match(r, /Sitemap: https:\/\/botu\.openclawd\.co\/sitemap\.xml/);
});

test('sitemap.xml: 生产域名 + lastmod', () => {
  const s = read('sitemap.xml');
  assert.match(s, /<loc>https:\/\/botu\.openclawd\.co\/<\/loc>/);
  assert.match(s, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
});

test('og-image.png: IHDR 尺寸恰为 1200×630', () => {
  const buf = readFileSync(join(ROOT, 'og-image.png'));
  assert.equal(buf.readUInt32BE(16), 1200, 'width');
  assert.equal(buf.readUInt32BE(20), 630, 'height');
});

test('favicon.png 存在', () => {
  assert.ok(existsSync(join(ROOT, 'favicon.png')));
});

test('_headers: 全路径 no-cache', () => {
  const h = read('_headers');
  assert.match(h, /^\/\*/m);
  assert.match(h, /Cache-Control: no-cache/);
});

test('零外链: 全部 src/href 为相对路径（canonical 除外）', () => {
  const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 15, `captured ${refs.length} refs`);
  for (const r of refs) {
    if (r === 'https://botu.openclawd.co/') continue; // canonical
    assert.ok(!/^(https?:)?\/\//.test(r), `external ref not allowed: ${r}`);
  }
});

test('资产版本化: css/js/favicon/gallery 均带 ?v=431', () => {
  for (const a of ['css/style.css?v=431', 'js/app.js?v=431', 'favicon.png?v=431']) {
    assert.ok(html.includes(`"${a}"`), `versioned ref missing: ${a}`);
  }
  const galleryRefs = [...html.matchAll(/src="(gallery\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(galleryRefs.length, 12, '12 gallery imgs');
  for (const r of galleryRefs) assert.match(r, /\?v=431$/, r);
});

test('gallery 成品: 6 对 char/icon png 全部存在且非空', () => {
  for (let i = 1; i <= 6; i += 1) {
    for (const kind of ['char', 'icon']) {
      const p = join(ROOT, `gallery/${kind}-${i}.png`);
      assert.ok(existsSync(p), `${kind}-${i}.png exists`);
      assert.ok(readFileSync(p).length > 1000, `${kind}-${i}.png non-empty`);
    }
  }
});
