// test/ratelimit.test.js — SPEC-431 W6/W7 每 IP 日限 5 次：纯函数 + handler 集成（mock BOTU_RL）+ /api/quota 契约
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_LIMIT, RL_TTL, utcDay, rlKey, clientIp, rlReadCount, rlWrite,
  UPSTREAM_URL, onRequestPost,
} from '../functions/api/generate.js';
import { onRequest as quotaHandler, remainingOf } from '../functions/api/quota.js';

const B64 = 'aGVsbG8=';
const TEST_KEY = ['test', '_key'].join('');
const IP = '1.2.3.4';
const today = utcDay();
const KEY = rlKey(IP, today);

const okUpstream = {
  output: { choices: [{ message: { content: [{ text: 'done' }, { image: 'https://oss.example/gen.png?sig=***' }] } }] },
};
const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);

function mockFetch() {
  return async (url) => {
    if (url === UPSTREAM_URL) return Response.json(okUpstream);
    return new Response(pngBytes, { status: 200 });
  };
}

function mockKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  const puts = [];
  return {
    puts,
    binding: {
      async get(k) { return store.has(k) ? store.get(k) : null; },
      async put(k, v, opts) { puts.push({ k, v, opts }); store.set(k, v); },
    },
  };
}

const post = (env, ip = IP) =>
  onRequestPost({
    request: new Request('https://botu.openclawd.co/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
      body: JSON.stringify({ image_base64: B64, mime: 'image/png' }),
    }),
    env,
  });

const quotaGet = (env, method = 'GET', ip = IP) =>
  quotaHandler({
    request: new Request('https://botu.openclawd.co/api/quota', {
      method,
      headers: ip ? { 'CF-Connecting-IP': ip } : {},
    }),
    env,
  });

// ── 纯函数 ──────────────────────────────────────
test('utcDay: UTC yyyymmdd', () => {
  assert.equal(utcDay(new Date(Date.UTC(2026, 8, 22, 23, 59))), '20260922');
  assert.equal(utcDay(new Date(Date.UTC(2026, 0, 5))), '20260105');
  assert.match(today, /^\d{8}$/);
});

test('rlKey: rl:<ip>:<day> 格式 + 常量', () => {
  assert.equal(rlKey('9.9.9.9', '20260922'), 'rl:9.9.9.9:20260922');
  assert.equal(DAILY_LIMIT, 5);
  assert.equal(RL_TTL, 172800);
});

test('clientIp: CF-Connecting-IP，缺失回退 unknown', () => {
  assert.equal(clientIp(new Request('https://x/', { headers: { 'CF-Connecting-IP': '5.6.7.8' } })), '5.6.7.8');
  assert.equal(clientIp(new Request('https://x/')), 'unknown');
});

test('rlReadCount: binding 缺失/get 抛异常/脏值 → fail-open 0', async () => {
  assert.equal(await rlReadCount({}, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: {} }, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: { get: async () => { throw new Error('kv down'); } } }, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: { get: async () => 'garbage' } }, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: { get: async () => null } }, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: { get: async () => '-3' } }, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: { get: async () => '4' } }, IP), 4);
});

test('rlWrite: put(key, String(n), ttl 48h)；put 抛异常不冒泡', async () => {
  const kv = mockKV();
  await rlWrite({ BOTU_RL: kv.binding }, IP, 3);
  assert.deepEqual(kv.puts, [{ k: KEY, v: '3', opts: { expirationTtl: 172800 } }]);
  await rlWrite({ BOTU_RL: { put: async () => { throw new Error('kv down'); } } }, IP, 1);
  await rlWrite({}, IP, 1); // no binding: silent
});

test('remainingOf: 5-count 下限 0', () => {
  assert.equal(remainingOf(0), 5);
  assert.equal(remainingOf(3), 2);
  assert.equal(remainingOf(5), 0);
  assert.equal(remainingOf(7), 0);
});

// ── generate.js 集成 ────────────────────────────
test('onRequestPost: 计数已达 5 → 429 JSON 且不打上游', async () => {
  const kv = mockKV({ [KEY]: '5' });
  let fetched = 0;
  const res = await post({
    DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding,
    __fetch: async () => { fetched += 1; return new Response('x'); },
  });
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.equal(j.error, 'daily limit exceeded (5 per IP per day)');
  assert.equal(j.remaining, 0);
  assert.equal(fetched, 0);
  assert.equal(kv.puts.length, 0);
});

test('onRequestPost: 成功生成后计数 +1（含 TTL），key 用 CF-Connecting-IP', async () => {
  const kv = mockKV({ [KEY]: '2' });
  const res = await post({ DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding, __fetch: mockFetch() });
  assert.equal(res.status, 200);
  assert.deepEqual(kv.puts, [{ k: KEY, v: '3', opts: { expirationTtl: 172800 } }]);
});

test('onRequestPost: 上游失败不计数', async () => {
  const kv = mockKV({ [KEY]: '1' });
  const res = await post({
    DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding,
    __fetch: async () => new Response('boom', { status: 500 }),
  });
  assert.equal(res.status, 502);
  assert.equal(kv.puts.length, 0);
});

test('onRequestPost: KV get/put 全挂 → fail-open 照常生成 200', async () => {
  const bad = {
    get: async () => { throw new Error('kv read down'); },
    put: async () => { throw new Error('kv write down'); },
  };
  const res = await post({ DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: bad, __fetch: mockFetch() });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.image_base64, Buffer.from(pngBytes).toString('base64'));
});

test('onRequestPost: 无 CF-Connecting-IP → key 用 unknown', async () => {
  const kv = mockKV();
  const res = await post({ DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding, __fetch: mockFetch() }, null);
  assert.equal(res.status, 200);
  assert.equal(kv.puts[0].k, rlKey('unknown', today));
});

// ── quota.js 契约 ───────────────────────────────
test('quota GET: 无 binding → 200 {"remaining":5}（fail-open）', async () => {
  const res = await quotaGet({});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { remaining: 5 });
});

test('quota GET: 已用 2 → remaining 3；已用 5+ → 0', async () => {
  assert.deepEqual(await (await quotaGet({ BOTU_RL: mockKV({ [KEY]: '2' }).binding })).json(), { remaining: 3 });
  assert.deepEqual(await (await quotaGet({ BOTU_RL: mockKV({ [KEY]: '9' }).binding })).json(), { remaining: 0 });
});

test('quota 非 GET → 405 JSON', async () => {
  const res = await quotaGet({}, 'POST');
  assert.equal(res.status, 405);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await res.json()).error, 'string');
});
