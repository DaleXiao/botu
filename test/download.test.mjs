// SPEC-441 / T-741: download button switched to blob URLs — b64ToBytes pure-conversion unit tests
// Covers: base64→bytes round-trips (all byte values / PNG magic / empty input / padding boundaries) + invalid input throws controllable errors
// Run: `node --test` at the repo root (like all existing tests; do not pass a directory argument)
import test from 'node:test';
import assert from 'node:assert/strict';
import { b64ToBytes } from '../js/app.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

test('b64ToBytes: round-trip for all byte values 0x00–0xFF', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  const out = b64ToBytes(b64(all));
  assert.ok(out instanceof Uint8Array, 'returns a Uint8Array');
  assert.deepEqual(out, all);
});

test('b64ToBytes: PNG magic header round-trip', () => {
  const magic = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  assert.deepEqual(b64ToBytes(b64(magic)), magic);
});

test('b64ToBytes: empty string → zero-length Uint8Array', () => {
  const out = b64ToBytes('');
  assert.ok(out instanceof Uint8Array);
  assert.equal(out.length, 0);
});

test('b64ToBytes: long buffer and padding boundaries (len%3 = 0/1/2) round-trip', () => {
  const buf = new Uint8Array(1000);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 167 + 13) % 256;
  for (const len of [999, 1000, 998]) {
    const slice = buf.subarray(0, len);
    assert.deepEqual(b64ToBytes(b64(slice)), slice, `len=${len}`);
  }
});

test('b64ToBytes: invalid base64 throws InvalidCharacterError (a controllable DOMException)', () => {
  assert.throws(() => b64ToBytes('!!!!not-base64!!!!'), { name: 'InvalidCharacterError' });
  assert.throws(() => b64ToBytes('a'), { name: 'InvalidCharacterError' }); // length %4 === 1 is invalid under forgiving-base64
});

test('b64ToBytes: non-string input throws TypeError', () => {
  for (const bad of [null, undefined, 123, {}, ['iVBORw0=']]) {
    assert.throws(() => b64ToBytes(bad), TypeError, `input ${String(bad)}`);
  }
});
