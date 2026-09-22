// test/gallery-v4.test.mjs — SPEC-433/T-733 W4+W3' 静态断言
// gallery 恰 4 条目 01–04 / 被删样张文件不存在且零引用 / 存留 8 文件 md5 == main 原值 /
// 卡内横向结构（DOM 顺序 + nowrap）/ 2×2 网格 + 窄屏 1 列 / W3' 结果框内联 SVG 占位、无空 src <img>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const md5 = (p) => createHash('md5').update(readFileSync(join(ROOT, p))).digest('hex');

const html = read('index.html');
const css = read('css/style.css');
const appJs = read('js/app.js');

test('gallery 恰 4 条目，序号 01–04，cap 键 cap1–cap4 顺序对齐', () => {
  assert.equal(html.split('class="gcard"').length - 1, 4);
  const idx = [...html.matchAll(/<span class="idx">(\d+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(idx, ['01', '02', '03', '04']);
  const caps = [...html.matchAll(/data-i18n="(cap\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(caps, ['cap1', 'cap2', 'cap3', 'cap4']);
});

test('被删样张（02 Shiba / 05 Fox）文件不存在且全站零引用', () => {
  for (const f of ['char-2.png', 'char-5.png', 'icon-2.png', 'icon-5.png']) {
    assert.equal(existsSync(join(ROOT, 'gallery', f)), false, `gallery/${f} 应已删除`);
  }
  for (const p of ['index.html', 'js/app.js', 'js/i18n.js', 'js/upload.js', 'css/style.css']) {
    const src = read(p);
    for (const tok of ['char-2', 'char-5', 'icon-2', 'icon-5', 'cap5', 'cap6']) {
      assert.ok(!src.includes(tok), `${p} 仍引用 ${tok}`);
    }
  }
});

test('存留 8 文件 md5 == origin/main 原值（字节不动区）', () => {
  const ORIG = {
    'gallery/icon-1.png': 'fc40f351965e7210a50261b1d447d79e',
    'gallery/icon-3.png': '14f36d63a2b5576db7f7986b4af36680',
    'gallery/icon-4.png': '67f4594df9d36a4a0629f6df3df9f9c8',
    'gallery/icon-6.png': 'cd881eb59db94e0171a733f43ce6464c',
    'gallery/char-1.png': 'b616a42679b2b446a03f7268172c81b5',
    'gallery/char-3.png': '43f483a294c50591cc41ff5ff1a986c3',
    'gallery/char-4.png': 'a9b0a508e9d9057a7514f25d34d6346d',
    'gallery/char-6.png': '83369818c25aed35ff591c0d7039fea8',
  };
  for (const [p, h] of Object.entries(ORIG)) assert.equal(md5(p), h, `${p} 被动过`);
});

test('卡内横向结构：char img → 水平箭头 → icon img（同编号成对），CSS nowrap 强制不换行', () => {
  const re = /<div class="pair sm"><img src="gallery\/char-(\d+)\.png[^"]*"[^>]*><div class="arrow"[^>]*>→<\/div><img src="gallery\/icon-\1\.png[^"]*"[^>]*><\/div>/g;
  const nums = [...html.matchAll(re)].map((m) => Number(m[1]));
  assert.deepEqual(nums, [1, 3, 4, 6], '4 卡均为 输入图→箭头→生成图 横向 DOM 顺序');
  assert.match(css, /\.gcard \.pair\.sm \{[^}]*flex-wrap: nowrap/, '卡内对比禁 wrap（v3 纵向堆叠破因）');
  assert.match(css, /\.gcard \.pair\.sm \.arrow \{ flex: none; \}/, '箭头不参与压缩');
});

test('2×2 网格：desktop 恰 2 列；≤640px 降 1 列', () => {
  assert.match(css, /\.grid \{ display: grid; grid-template-columns: repeat\(2, 1fr\)/);
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.grid \{ grid-template-columns: 1fr; \}/);
});

test("W3': 结果框初始 DOM 为内联 SVG 占位（currentColor 随主题），无空 src <img>", () => {
  assert.match(html, /id="resultBox"><svg[^>]*id="resultPh"/, 'resultBox 首子节点为内联 SVG');
  const svgBlock = html.slice(html.indexOf('id="resultPh"'), html.indexOf('</svg>', html.indexOf('id="resultPh"')));
  assert.ok(svgBlock.includes('currentColor'), 'SVG 用 currentColor 随主题着色');
  assert.ok(!html.includes('xlink:href') && !/<img[^>]*id="resultPh"/.test(html), '占位非外链位图');
  // 初始 DOM 所有 <img> 必带非空 src（gallery 8 张）；不存在 srcPreview/resultImg 静态节点
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 8);
  for (const tag of imgs) assert.match(tag, /src="[^"]+"/, '空 src img 不允许');
  assert.ok(!html.includes('srcPreview') && !html.includes('resultImg'), '结果/原图 img 均动态渲染');
});

test("W3': app.js 状态切换不设空 src（error/pending 走 SVG 占位）", () => {
  for (const fn of ['function renderBefore', 'function clearResult', 'function showResult']) {
    assert.ok(appJs.includes(fn), `app.js 缺 ${fn}`);
  }
  assert.ok(!appJs.includes(".src = ''") && !appJs.includes('.src = ""'), '不赋空 src');
  assert.ok(!appJs.includes("removeAttribute('src')"), '不用 removeAttribute(src) 制造破图');
  assert.match(appJs, /img\.src = url;/, 'done 才设 src（showResult）');
  assert.match(appJs, /clearResult\(\); \/\/ 等待期结果框显 SVG 占位/, 'pending 期显式回占位');
});
