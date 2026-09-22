// test/minimal-v3.test.mjs — SPEC-432 W4 极简风改版静态断言
// terminal 语汇零残留 / 字体栈 / wrangler compat / gallery md5 锚 / ?v=432 版本化 / 资产引用一致 / 主题机制保留
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const md5 = (p) => createHash('md5').update(readFileSync(join(ROOT, p))).digest('hex');

const SURFACE = {
  'index.html': read('index.html'),
  'css/style.css': read('css/style.css'),
  'js/app.js': read('js/app.js'),
  'js/i18n.js': read('js/i18n.js'),
};

test('terminal 语汇零残留: scanline/crt/ASCII 脸/prompt 文案/方括号标签/终端 chrome', () => {
  const banned = [/scanline/i, /\bcrt\b/i, 'dz-ascii', 'termwin', 'termbar', 'termpath', 'ps1',
    '$ botu', 'ls ./gallery', '▮', '⠋', '[OK]', '[ERR]', '[QUOTA]', '[☾', '[☀'];
  for (const [f, src] of Object.entries(SURFACE)) {
    for (const b of banned) {
      const hit = b instanceof RegExp ? b.test(src) : src.includes(b);
      assert.ok(!hit, `${f} 仍含 terminal token: ${String(b)}`);
    }
  }
});

test('旧荧光绿/琥珀高饱和色值零残留', () => {
  const oldColors = ['#3fb950', '#1a7f37', '#d29922', '#9a6700', '#0d1117', '#f6f1e7', 'rgba(63, 185, 80'];
  for (const [f, src] of Object.entries(SURFACE)) {
    const low = src.toLowerCase();
    for (const c of oldColors) assert.ok(!low.includes(c.toLowerCase()), `${f} 仍含旧色值 ${c}`);
  }
});

test('字体栈: system-ui 打头 + sans-serif 收尾（零外链 webfont）', () => {
  assert.match(SURFACE['css/style.css'],
    /system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif/);
  assert.match(SURFACE['css/style.css'], /font-family: var\(--sans\)/);
  assert.ok(!/@import|fonts\.googleapis|fonts\.gstatic/.test(SURFACE['css/style.css']), '无外链字体');
});

test('全站无 serif（sans-serif 子串除外）/ Courier / monospace', () => {
  for (const [f, src] of Object.entries(SURFACE)) {
    assert.ok(!/(?<![-\w])serif/i.test(src), `${f} 含独立 serif 声明`);
    assert.ok(!/Courier|monospace|SFMono|\bMenlo\b|Consolas/i.test(src), `${f} 含 mono 字体`);
  }
});

test('wrangler.toml: compatibility_date + nodejs_compat 在场', () => {
  const w = read('wrangler.toml');
  assert.match(w, /^compatibility_date = "\d{4}-\d{2}-\d{2}"$/m);
  assert.match(w, /^compatibility_flags = \["nodejs_compat"\]$/m);
});

test('gallery 换图锚: icon-1 WebP md5 == SPEC-437 终值且 ≤ 120000B（PNG 已退役；icon-2/5 已随 SPEC-433 W4 删除）', () => {
  assert.equal(md5('gallery/icon-1.webp'), '6ac6ab74c0217941eb773bf886675dee');
  assert.ok(readFileSync(join(ROOT, 'gallery/icon-1.webp')).length <= 120000, 'icon-1 size gate');
});

test('gallery 不动锚: icon-3/4/6 + char-1/3/4/6 WebP md5 == SPEC-437 终值（存留集）', () => {
  const ORIG = {
    'gallery/icon-3.webp': 'ad67f9e8b552779a365d5079629afd37',
    'gallery/icon-4.webp': '04ced5895b37ae4fc7cbec5e57acd9b7',
    'gallery/icon-6.webp': 'd54d04363924fd3613f5372c7c5546a8',
    'gallery/char-1.webp': '180dcaeb4fcfa0c192a7fef281a7fc6e',
    'gallery/char-3.webp': '8ae57f22a682dd9e8f7ddcbea24dea7b',
    'gallery/char-4.webp': 'f04678c56a08fe5724c60c1839967481',
    'gallery/char-6.webp': '8f5d2b17c14b410f7b3441b0da6c7df1',
  };
  for (const [p, h] of Object.entries(ORIG)) assert.equal(md5(p), h, `${p} 被动过`);
});

test('?v=437 在场: css/js/8 张 gallery（favicon 内容未改保持 433）', () => {
  const html = SURFACE['index.html'];
  for (const a of ['css/style.css?v=437', 'js/app.js?v=437', 'favicon.png?v=433']) {
    assert.ok(html.includes(`"${a}"`), `缺版本化引用: ${a}`);
  }
  const refs = [...html.matchAll(/src="(gallery\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(refs.length, 8, '8 张 gallery 图（4 样张 × 前后对比）');
  for (const r of refs) assert.match(r, /\.webp\?v=437$/, r);
});

test('?v=432 零残留（html/js/css/测试）', () => {
  for (const f of ['index.html', 'js/app.js', 'js/i18n.js', 'js/upload.js', 'css/style.css', 'test/seo.test.mjs']) {
    assert.ok(!read(f).includes('v=432'), `${f} 仍含 v=432`);
  }
});

test('资产引用与文件存在一致: favicon / og-image / gallery', () => {
  const html = SURFACE['index.html'];
  assert.ok(existsSync(join(ROOT, 'favicon.png')), 'favicon.png 存在');
  assert.ok(html.includes('href="favicon.png?v=433"'), 'favicon 引用在场');
  assert.ok(existsSync(join(ROOT, 'og-image.png')), 'og-image.png 存在');
  assert.ok(html.includes('https://botu.openclawd.co/og-image.png'), 'og:image 引用在场');
  const files = [...html.matchAll(/src="gallery\/([^"?]+)\?v=/g)].map((m) => m[1]);
  assert.equal(files.length, 8);
  for (const f of files) assert.ok(existsSync(join(ROOT, 'gallery', f)), `gallery/${f} 存在`);
});

test('主题切换机制保留: botu-theme key + head 防闪烁内联脚本', () => {
  assert.ok(SURFACE['js/app.js'].includes("'botu-theme'"), 'app.js 保留 botu-theme key');
  assert.match(SURFACE['index.html'], /localStorage\.getItem\('botu-theme'\)/);
  assert.match(SURFACE['index.html'], /setAttribute\('data-theme'/);
});
