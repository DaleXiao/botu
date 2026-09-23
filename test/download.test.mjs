// SPEC-441 / T-741: 下载按钮 blob URL 化 — b64ToBytes 纯转换单测
// 覆盖: base64→bytes 往返一致（全字节值 / PNG magic / 空输入 / padding 边界）+ 非法输入抛可控错误
// 运行: repo root `node --test`（与既有测试一致，勿加目录参数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { b64ToBytes } from '../js/app.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

test('b64ToBytes: 0x00–0xFF 全字节值往返一致', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  const out = b64ToBytes(b64(all));
  assert.ok(out instanceof Uint8Array, '返回 Uint8Array');
  assert.deepEqual(out, all);
});

test('b64ToBytes: PNG magic header 往返一致', () => {
  const magic = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  assert.deepEqual(b64ToBytes(b64(magic)), magic);
});

test('b64ToBytes: 空字符串 → 0 长 Uint8Array', () => {
  const out = b64ToBytes('');
  assert.ok(out instanceof Uint8Array);
  assert.equal(out.length, 0);
});

test('b64ToBytes: 长缓冲与 padding 边界（len%3 = 0/1/2）往返一致', () => {
  const buf = new Uint8Array(1000);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 167 + 13) % 256;
  for (const len of [999, 1000, 998]) {
    const slice = buf.subarray(0, len);
    assert.deepEqual(b64ToBytes(b64(slice)), slice, `len=${len}`);
  }
});

test('b64ToBytes: 非法 base64 抛 InvalidCharacterError（DOMException，可控错误）', () => {
  assert.throws(() => b64ToBytes('!!!!not-base64!!!!'), { name: 'InvalidCharacterError' });
  assert.throws(() => b64ToBytes('a'), { name: 'InvalidCharacterError' }); // 长度 %4 === 1，forgiving-base64 非法
});

test('b64ToBytes: 非字符串输入抛 TypeError', () => {
  for (const bad of [null, undefined, 123, {}, ['iVBORw0=']]) {
    assert.throws(() => b64ToBytes(bad), TypeError, `input ${String(bad)}`);
  }
});
