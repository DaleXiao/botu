// test/ratelimit.test.js — SPEC-431 W6/W7 daily limit of 5 per IP: pure functions + handler integration (mocked BOTU_RL) + the /api/quota contract
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_LIMIT, RL_TTL, utcDay, rlKey, clientIp, rlReadCount, rlWrite,
  UPSTREAM_PATH, onRequestPost,
} from '../functions/api/generate.js';
import { JobRunner } from '../worker/src/index.js';
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
// Gateway consolidation (Dale 2026-09-22 19:42): mocked api-llm gateway origin
const GW = 'https://gw.test';
const GW_URL = GW + UPSTREAM_PATH;

function mockFetch() {
  return async (url) => {
    if (url === GW_URL) return Response.json(okUpstream);
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

// SPEC-435 v5: DO trigger-chain mock (stub.fetch talks directly to a real JobRunner; alarm driven manually)
function mockDO(env) {
  const instances = new Map();
  const binding = {
    idFromName: (name) => ({ name }),
    get(id) {
      if (!instances.has(id.name)) {
        const data = new Map();
        const st = {
          data,
          storage: {
            async get(k) { return data.has(k) ? data.get(k) : null; },
            async put(k, v) { data.set(k, v); },
            async delete(k) { data.delete(k); },
            async setAlarm() {},
            async getAlarm() { return null; },
            async deleteAll() { data.clear(); },
          },
        };
        instances.set(id.name, new JobRunner(st, env));
      }
      const obj = instances.get(id.name);
      return { fetch: (url, opts) => obj.fetch(new Request(url, opts)) };
    },
  };
  return { binding, alarm: (name) => instances.get(name).alarm() };
}

// Full POST + alarm chain (v5: charging/the terminal state complete inside the alarm)
async function postAndRun(env, ip = IP) {
  const doMock = mockDO(env);
  env.JOB_RUNNER = doMock.binding;
  const res = await post(env, ip);
  if (res.status === 200) {
    const { job_id } = await res.clone().json();
    await doMock.alarm(`job-${job_id}`);
  }
  return res;
}

const quotaGet = (env, method = 'GET', ip = IP) =>
  quotaHandler({
    request: new Request('https://botu.openclawd.co/api/quota', {
      method,
      headers: ip ? { 'CF-Connecting-IP': ip } : {},
    }),
    env,
  });

// ── pure functions ──────────────────────────────────────
test('utcDay: UTC yyyymmdd', () => {
  assert.equal(utcDay(new Date(Date.UTC(2026, 8, 22, 23, 59))), '20260922');
  assert.equal(utcDay(new Date(Date.UTC(2026, 0, 5))), '20260105');
  assert.match(today, /^\d{8}$/);
});

test('rlKey: rl:<ip>:<day> format + constants', () => {
  assert.equal(rlKey('9.9.9.9', '20260922'), 'rl:9.9.9.9:20260922');
  assert.equal(DAILY_LIMIT, 5);
  assert.equal(RL_TTL, 172800);
});

test('clientIp: CF-Connecting-IP, falls back to unknown when missing', () => {
  assert.equal(clientIp(new Request('https://x/', { headers: { 'CF-Connecting-IP': '5.6.7.8' } })), '5.6.7.8');
  assert.equal(clientIp(new Request('https://x/')), 'unknown');
});

test('rlReadCount: missing binding / get throws / dirty value → fail-open 0', async () => {
  assert.equal(await rlReadCount({}, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: {} }, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: { get: async () => { throw new Error('kv down'); } } }, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: { get: async () => 'garbage' } }, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: { get: async () => null } }, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: { get: async () => '-3' } }, IP), 0);
  assert.equal(await rlReadCount({ BOTU_RL: { get: async () => '4' } }, IP), 4);
});

test('rlWrite: put(key, String(n), ttl 48h); a throwing put never bubbles up', async () => {
  const kv = mockKV();
  await rlWrite({ BOTU_RL: kv.binding }, IP, 3);
  assert.deepEqual(kv.puts, [{ k: KEY, v: '3', opts: { expirationTtl: 172800 } }]);
  await rlWrite({ BOTU_RL: { put: async () => { throw new Error('kv down'); } } }, IP, 1);
  await rlWrite({}, IP, 1); // no binding: silent
});

test('remainingOf: 5-count floored at 0', () => {
  assert.equal(remainingOf(0), 5);
  assert.equal(remainingOf(3), 2);
  assert.equal(remainingOf(5), 0);
  assert.equal(remainingOf(7), 0);
});

// ── generate.js integration ────────────────────────────
test('onRequestPost: count already at 5 → 429 JSON without calling the upstream', async () => {
  const kv = mockKV({ [KEY]: '5' });
  let fetched = 0;
  const res = await post({
    LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, BOTU_RL: kv.binding,
    __fetch: async () => { fetched += 1; return new Response('x'); },
  });
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.equal(j.error, 'daily limit exceeded (5 per IP per day)');
  assert.equal(j.remaining, 0);
  assert.equal(fetched, 0);
  assert.equal(kv.puts.length, 0);
});

test('onRequestPost: count +1 after a successful job (with TTL), keyed by CF-Connecting-IP', async () => {
  const kv = mockKV({ [KEY]: '2' });
  const res = await postAndRun({ LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, BOTU_RL: kv.binding, __fetch: mockFetch() });
  assert.equal(res.status, 200);
  const rlPuts = kv.puts.filter((x) => x.k === KEY);
  assert.deepEqual(rlPuts, [{ k: KEY, v: '3', opts: { expirationTtl: 172800 } }]);
});

test('onRequestPost: upstream failure → the alarm writes a job error, count untouched', async () => {
  const kv = mockKV({ [KEY]: '1' });
  const res = await postAndRun({
    LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, BOTU_RL: kv.binding,
    __fetch: async () => new Response('boom', { status: 500 }),
  });
  assert.equal(res.status, 200); // the job was accepted
  const j = await res.json();
  const job = JSON.parse(await kv.binding.get('job:' + j.job_id));
  assert.equal(job.state, 'error');
  assert.equal(kv.puts.filter((x) => x.k === KEY).length, 0);
});

test('onRequestPost: KV fully down → quota fails open but the job cannot be stored → 500, no upstream call', async () => {
  const bad = {
    get: async () => { throw new Error('kv read down'); },
    put: async () => { throw new Error('kv write down'); },
  };
  let fetched = 0;
  const res = await post({
    LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, BOTU_RL: bad,
    __fetch: async () => { fetched += 1; return mockFetch()(); },
  });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'job store unavailable');
  assert.equal(fetched, 0);
});

test('onRequestPost: no CF-Connecting-IP → key uses unknown', async () => {
  const kv = mockKV();
  const res = await postAndRun({ LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, BOTU_RL: kv.binding, __fetch: mockFetch() }, null);
  assert.equal(res.status, 200);
  assert.ok(kv.puts.some((x) => x.k === rlKey('unknown', today)));
});

// ── quota.js contract ───────────────────────────────
test('quota GET: no binding → 200 {"remaining":5} (fail-open)', async () => {
  const res = await quotaGet({});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { remaining: 5 });
});

test('quota GET: 2 used → remaining 3; 5+ used → 0', async () => {
  assert.deepEqual(await (await quotaGet({ BOTU_RL: mockKV({ [KEY]: '2' }).binding })).json(), { remaining: 3 });
  assert.deepEqual(await (await quotaGet({ BOTU_RL: mockKV({ [KEY]: '9' }).binding })).json(), { remaining: 0 });
});

test('quota non-GET → 405 JSON', async () => {
  const res = await quotaGet({}, 'POST');
  assert.equal(res.status, 405);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await res.json()).error, 'string');
});
