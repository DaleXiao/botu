// test/btnrow.test.mjs — SPEC-442 / T-743 按钮行修复静态断言
// 覆盖: [hidden] 语义恢复规则在场 / .btnrow .btn flex 等分（旧 min-width 策略零残留）/ style.css ?v=445 版本化
// 运行: repo root `node --test`（与既有测试一致，勿加目录参数）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('index.html');
const css = read('css/style.css');
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, ''); // 剥离注释，避免注释字面量干扰规则断言

test('[hidden]: display none !important 恢复规则在场', () => {
  const m = cssRules.match(/\[hidden\]\s*\{[^}]*\}/);
  assert.ok(m, 'style.css 含 [hidden] 规则');
  assert.match(m[0], /display:\s*none\s*!important/, '[hidden] 规则为 display: none !important');
});

test('.btnrow .btn: flex 等分策略（flex: 1 1 8.5em + max-width + min-width: 0）', () => {
  const m = cssRules.match(/\.btnrow \.btn\s*\{[^}]*\}/);
  assert.ok(m, 'style.css 含 .btnrow .btn 规则');
  assert.match(m[0], /flex:\s*1 1 8\.5em/, 'flex: 1 1 8.5em 等分');
  assert.match(m[0], /max-width:\s*13em/, 'max-width: 13em 封顶');
  assert.match(m[0], /min-width:\s*0/, 'min-width: 0 允许收缩');
  assert.match(m[0], /text-align:\s*center/, '文本居中保留');
  assert.match(m[0], /padding-left:\s*10px/, '左右 padding 收窄');
  assert.match(m[0], /padding-right:\s*10px/, '左右 padding 收窄');
});

test('SPEC-441 旧 min-width 11.5em 策略零残留', () => {
  assert.ok(!css.includes('11.5em'), 'style.css 全文不含 11.5em');
});

test('index.html: style.css 版本化 ?v=445（app.js?v=445 同步）', () => {
  assert.match(html, /css\/style\.css\?v=445/, 'style.css?v=445');
  assert.ok(!html.includes('style.css?v=444'), '旧版本引用零残留');
  assert.match(html, /js\/app\.js\?v=445/, 'app.js?v=445');
});
