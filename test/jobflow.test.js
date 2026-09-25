// test/jobflow.test.js — SPEC-433/T-733 W5 · SPEC-435/T-736 v5: async job-flow unit tests (in-memory Map KV stub)
// Covers: POST branch semantics / job_id shape / DO trigger chain (stub.fetch→setAlarm→alarm) / the four result branches /
// exactly-once quota idempotency / errors not charged / alarm idempotency guard / attempts cap / 5min hard timeout / img TTL /
// leak assertions (response bodies + job values + result.js & worker sources carry no upstream tokens)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  UPSTREAM_PATH, DAILY_LIMIT, JOB_TTL, jobKey, newJobId, jobRead, sanitizeError,
  rlKey, utcDay, onRequestPost, onRequestGet, imgKey, IMG_TTL, TIMEOUT_ERROR, MAX_JOB_ATTEMPTS,
} from '../functions/api/generate.js';
import { onRequest as resultHandler } from '../functions/api/result.js';
import { JobRunner } from '../worker/src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const B64 = 'aGVsbG8=';
const TEST_KEY = ['te'+'st', '_ke'+'y'].join('');
// Gateway consolidation (Dale 2026-09-22 19:42): mocked api-llm gateway origin
const GW = 'https://gw.test';
const GW_URL = GW + UPSTREAM_PATH;
const IP = '1.2.3.4';
const DAY = utcDay();
const RLK = rlKey(IP, DAY);
const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);

const okUpstream = {
  output: { choices: [{ message: { content: [{ text: 'done' }, { image: 'https://oss.example/gen.png?sig=1' }] } }] },
};

// Forbidden tokens for leak assertions (built from concatenated fragments so this test file never contains the full token shapes)
const FORBIDDEN = [
  new RegExp(['dash', 'scope'].join(''), 'i'),
  /sk-/i,
  new RegExp(['Sign', 'ature='].join(''), 'i'),
  new RegExp(['x-', 'oss-'].join(''), 'i'),
];
// Dirty upstream error body: deliberately carries every forbidden token + a signed URL, to verify sanitization
const DIRTY_BODY = 'rate limited ' + ['sk', 'LEAK123'].join('-')
  + ' ' + ['Sign', 'ature=SEC'].join('')
  + ' ' + ['x-', 'oss-', 'cred'].join('')
  + ' via https://' + ['dash', 'scope'].join('') + '.aliyuncs.com/x?sig=1';

function mockKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  const puts = [];
  const deletes = [];
  return {
    store,
    puts,
    deletes,
    binding: {
      async get(k) {
        if (store.has(k)) return store.get(k);
        return null;
      },
      async put(k, v, opts) { puts.push({ k, v, opts }); store.set(k, v); },
      async delete(k) { deletes.push(k); store.delete(k); },
    },
  };
}

const okFetch = async (url) => (url === GW_URL
  ? Response.json(okUpstream)
  : new Response(pngBytes, { status: 200 }));

const dirtyFetch = async (url) => (url === GW_URL
  ? new Response(DIRTY_BODY, { status: 500 })
  : new Response(pngBytes, { status: 200 }));

// SPEC-433 hotfix: slow-upstream stub — simulates production DashScope 2-4min generation (scaled down to ms), asserting the response comes first
const slowFetch = (ms) => async (url) => { await new Promise((r)=>setTimeout(r,ms)); return okFetch(url); };

const post = (env, { ip = IP, ctx = undefined, waitUntil = undefined, body = JSON.stringify({ image_base64: B64, mime: 'image/png' }) } = {}) =>
  onRequestPost({
    request: new Request('https://botu.openclawd.co/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
      body,
    }),
    env,
    ctx,
    waitUntil,
  });

const getResult = (env, query, method = 'GET') =>
  resultHandler({
    request: new Request('https://botu.openclawd.co/api/result' + query, { method }),
    env,
  });

// SPEC-435 v5: DO trigger-chain mock — stub.fetch talks directly to a real JobRunner instance (in-memory storage stub).
// Production chain: Pages POST → JOB_RUNNER stub.fetch → fetch handler stores meta+setAlarm → the platform invokes alarm().
// In unit tests the alarm is driven manually via doMock.alarm(name); everything else is real code.
function mockDO(env) {
  const instances = new Map();
  const names = [];
  const dispatches = [];
  const binding = {
    idFromName(name) { names.push(name); return { name }; },
    get(id) {
      if (!instances.has(id.name)) {
        const data = new Map();
        const st = {
          data,
          alarmAt: null,
          deleteAllCount: 0,
          storage: {
            async get(k) { return data.has(k) ? data.get(k) : null; },
            async put(k, v) { data.set(k, v); },
            async delete(k) { data.delete(k); },
            async setAlarm(t) { st.alarmAt = t; },
            async getAlarm() { return st.alarmAt; },
            async deleteAll() { data.clear(); st.deleteAllCount += 1; },
          },
        };
        instances.set(id.name, { st, obj: new JobRunner(st, env) });
      }
      const inst = instances.get(id.name);
      return {
        async fetch(url, opts) {
          dispatches.push({ url, opts });
          return inst.obj.fetch(new Request(url, opts));
        },
      };
    },
  };
  return {
    binding, names, dispatches, instances,
    inst: (name) => instances.get(name),
    async alarm(name) { return instances.get(name).obj.alarm(); },
  };
}

// Standard env assembly: KV mock + DO mock + fetch mock (single entry point for the POST integration tests)
function envWith({ fetchMock = okFetch, kvInitial } = {}) {
  const kv = mockKV(kvInitial);
  const env = { LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, BOTU_RL: kv.binding, __fetch: fetchMock };
  const doMock = mockDO(env);
  env.JOB_RUNNER = doMock.binding;
  return { kv, env, doMock };
}

function scanNoLeak(text, label) {
  for (const re of FORBIDDEN) {
    assert.ok(!re.test(String(text)), `${label} leaks forbidden token ${re}`);
  }
}

// ── constants / ids / sanitization ────────────────────────
test('job constants and ids: JOB_TTL=3600, jobKey prefix, newJobId 32-hex uniqueness', () => {
  assert.equal(JOB_TTL, 3600);
  assert.equal(jobKey('abc'), 'job:abc');
  const a = newJobId();
  const b = newJobId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('sanitizeError: strips URLs / credential-like tokens / the upstream domain, truncates to 200', () => {
  const out = sanitizeError(DIRTY_BODY + 'x'.repeat(300));
  scanNoLeak(out, 'sanitizeError output');
  assert.ok(out.length <= 200);
  assert.equal(sanitizeError(null), '');
  assert.equal(sanitizeError(undefined), '');
});

// ── POST: job creation + waitUntil timing ─────────────
test('POST happy path: stub.fetch trigger chain, response first with 200 {job_id}; job starts pending, done after the alarm', async () => {
  const { kv, env, doMock } = envWith();
  const res = await post(env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(Object.keys(j), ['job_id']);
  assert.match(j.job_id, /^[0-9a-f]{32}$/);
  // Trigger-chain assertions: idFromName(job-<id>) one instance per job + stub.fetch exactly once + headers carry jobId/ip
  assert.deepEqual(doMock.names, [`job-${j.job_id}`], 'one instance name per job');
  assert.equal(doMock.dispatches.length, 1, 'stub.fetch exactly once');
  assert.equal(doMock.dispatches[0].opts.headers['x-botu-job'], j.job_id);
  assert.equal(doMock.dispatches[0].opts.headers['x-botu-ip'], IP);
  const inst = doMock.inst(`job-${j.job_id}`);
  assert.ok(inst.st.alarmAt !== null && inst.st.alarmAt <= Date.now(), 'setAlarm immediate');
  // Before the alarm callback: KV holds pending and result returns pending; the img payload is already in KV
  const pend = await jobRead({ BOTU_RL: kv.binding }, j.job_id);
  assert.equal(pend.state, 'pending');
  assert.equal(pend.ip, IP);
  assert.equal(kv.store.get(jobKey(j.job_id)).includes('"state":"pending"'), true);
  assert.equal(typeof kv.store.get(imgKey(j.job_id)), 'string', 'img:<id> written');
  const pr = await getResult({ BOTU_RL: kv.binding }, '?job=' + j.job_id);
  assert.deepEqual(await pr.json(), { state: 'pending' });
  // Alarm callback (real JobRunner.alarm) → done
  await doMock.alarm(`job-${j.job_id}`);
  const done = await jobRead({ BOTU_RL: kv.binding }, j.job_id);
  assert.equal(done.state, 'done');
  assert.equal(done.mime, 'image/png');
  assert.equal(done.image_b64, Buffer.from(pngBytes).toString('base64'));
  assert.equal(done.counted, true);
  assert.equal(done.remaining, DAILY_LIMIT - 1);
  assert.equal(kv.store.get(RLK), '1', 'quota +1 after success');
  assert.deepEqual(kv.deletes, [imgKey(j.job_id)], 'img payload deleted after the terminal state');
  assert.equal(inst.st.deleteAllCount, 1, 'DO storage cleared after the terminal state');
  const dr = await getResult({ BOTU_RL: kv.binding }, '?job=' + j.job_id);
  const dj = await dr.json();
  assert.equal(dj.state, 'done');
  assert.equal(dj.image_base64, done.image_b64);
  assert.equal(dj.remaining, DAILY_LIMIT - 1);
  assert.equal('counted' in dj, false, 'the counted flag never appears in the response');
});

test('POST: both the job put and the img put carry TTL 3600, values are JSON (img contains image_base64/mime)', async () => {
  const { kv, env } = envWith();
  const res = await post(env);
  const { job_id } = await res.json();
  const jobPut = kv.puts.find((x) => x.k === jobKey(job_id));
  assert.equal(jobPut.opts.expirationTtl, JOB_TTL);
  assert.equal(typeof JSON.parse(jobPut.v), 'object');
  const imgPut = kv.puts.find((x) => x.k === imgKey(job_id));
  assert.equal(imgPut.opts.expirationTtl, IMG_TTL);
  assert.equal(IMG_TTL, 3600);
  const imgVal = JSON.parse(imgPut.v);
  assert.equal(imgVal.image_base64, B64);
  assert.equal(imgVal.mime, 'image/png');
  // Write order: job pending first, img second (stub.fetch last; failure semantics are covered by the dispatch-500 branch test)
  assert.ok(kv.puts.indexOf(jobPut) < kv.puts.indexOf(imgPut));
});

// SPEC-435 v5 regression: a slow upstream (1500ms standing in for the production 2-4min) must not block the POST response — generation runs inside the DO alarm,
// immune both to the waitUntil 30s cancellation (v4's cause of death) and to request wall-clock time (v3's 524 cause of death)
test('POST + slow upstream (1500ms): response first in <800ms, done only after the alarm callback (524/30s root-cause regression)', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: slowFetch(1500) });
  const t0 = Date.now();
  const res = await post(env);
  const elapsed = Date.now() - t0;
  const bodyText = await res.text();
  scanNoLeak(bodyText, 'v5 POST response');
  assert.ok(elapsed < 800, `response first: elapsed=${elapsed}ms should be <800ms (generation runs inside the alarm, not on the request)`);
  assert.equal(res.status, 200);
  const j = JSON.parse(bodyText);
  assert.deepEqual(Object.keys(j), ['job_id']);
  assert.match(j.job_id, /^[0-9a-f]{32}$/);
  // Alarm not yet invoked: result returns pending
  const pr = await getResult({ BOTU_RL: kv.binding }, '?job=' + j.job_id);
  assert.deepEqual(await pr.json(), { state: 'pending' });
  // Alarm callback (the slow upstream completes inside the handler) → done, quota exactly once
  await doMock.alarm(`job-${j.job_id}`);
  const done = await jobRead({ BOTU_RL: kv.binding }, j.job_id);
  assert.equal(done.state, 'done');
  assert.equal(done.counted, true);
  assert.equal(kv.store.get(RLK), '1', 'rl count is exactly 1');
});

// ── POST: validation / quota branch semantics unchanged ─────────────
test('POST invalid JSON → 400; non-whitelisted mime → 400: neither creates a job nor calls the upstream', async () => {
  const kv = mockKV();
  let fetched = 0;
  const env = { LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, BOTU_RL: kv.binding, __fetch: async () => { fetched += 1; return new Response('x'); } };
  const r1 = await post(env, { body: 'not-json{' });
  assert.equal(r1.status, 400);
  const r2 = await post(env, { body: JSON.stringify({ image_base64: B64, mime: 'image/gif' }) });
  assert.equal(r2.status, 400);
  assert.equal(fetched, 0);
  assert.equal(kv.puts.length, 0);
});

test('POST quota exceeded → 429 {error, remaining:0}: no job created, no upstream call', async () => {
  const kv = mockKV({ [RLK]: '5' });
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

test('POST without a KV binding → 500 job store unavailable, no upstream call (quota still fails open)', async () => {
  let fetched = 0;
  const res = await post({
    LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY,
    __fetch: async () => { fetched += 1; return new Response('x'); },
  });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'job store unavailable');
  assert.equal(fetched, 0);
});

test('GET /api/generate → 405 (semantics unchanged)', async () => {
  assert.equal((await onRequestGet()).status, 405);
});

// ── GET /api/result: four branches + fault paths ────────────
test('result 404: unknown id / missing param / malformed id / corrupt value', async () => {
  const kv = mockKV({ [jobKey('ff'.repeat(16))]: 'not-json{{{' });
  const env = { BOTU_RL: kv.binding };
  const unknown = await getResult(env, '?job=' + 'ab'.repeat(16));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'job not found or expired');
  const missing = await getResult(env, '');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'job not found');
  const malformed = await getResult(env, '?job=xyz');
  assert.equal(malformed.status, 404);
  assert.equal((await malformed.json()).error, 'job not found');
  const corrupt = await getResult(env, '?job=' + 'ff'.repeat(16));
  assert.equal(corrupt.status, 404);
  assert.equal((await corrupt.json()).error, 'job not found or expired');
});

test('result: KV get throws → 500 (distinct from 404); non-GET → 405', async () => {
  const bad = { get: async () => { throw new Error('kv down'); } };
  const r = await getResult({ BOTU_RL: bad }, '?job=' + 'ab'.repeat(16));
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'job store unavailable');
  const m = await getResult({}, '?job=' + 'ab'.repeat(16), 'POST');
  assert.equal(m.status, 405);
});

test('result done/error branch shapes (KV values seeded directly)', async () => {
  const id = 'cd'.repeat(16);
  const kv = mockKV({
    [jobKey(id)]: JSON.stringify({ state: 'done', image_b64: B64, mime: 'image/png', remaining: 3, counted: true, ip: IP }),
  });
  const d = await getResult({ BOTU_RL: kv.binding }, '?job=' + id);
  assert.deepEqual(await d.json(), { state: 'done', image_base64: B64, mime: 'image/png', remaining: 3 });
  const eid = 'ee'.repeat(16);
  kv.store.set(jobKey(eid), JSON.stringify({ state: 'error', error: 'upstream 500: [redacted]' }));
  const e = await getResult({ BOTU_RL: kv.binding }, '?job=' + eid);
  assert.deepEqual(await e.json(), { state: 'error', error: 'upstream 500: [redacted]' });
});

// ── exactly-once quota / errors not charged ─────────────────
test('quota exactly once: repeated polls after done never raise the count (idempotent)', async () => {
  const { kv, env, doMock } = envWith({ kvInitial: { [RLK]: '2' } });
  const res = await post(env);
  const { job_id } = await res.json();
  await doMock.alarm(`job-${job_id}`);
  assert.equal(kv.store.get(RLK), '3', '+1 on success');
  const rlPutsBefore = kv.puts.filter((x) => x.k === RLK).length;
  for (let i = 0; i < 3; i += 1) {
    const r = await getResult({ BOTU_RL: kv.binding }, '?job=' + job_id);
    const j = await r.json();
    assert.equal(j.state, 'done');
    assert.equal(j.remaining, DAILY_LIMIT - 3);
  }
  assert.equal(kv.store.get(RLK), '3', 'repeated polls do not raise it further');
  assert.equal(kv.puts.filter((x) => x.k === RLK).length, rlPutsBefore, 'no extra rl writes');
});

test('errors not charged: upstream failure → the alarm writes a job error (sanitized), the rl count is unchanged', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: dirtyFetch, kvInitial: { [RLK]: '1' } });
  const res = await post(env);
  const { job_id } = await res.json();
  await doMock.alarm(`job-${job_id}`);
  const job = await jobRead({ BOTU_RL: kv.binding }, job_id);
  assert.equal(job.state, 'error');
  scanNoLeak(job.error, 'job.error');
  assert.match(job.error, /upstream 500/);
  assert.equal(kv.store.get(RLK), '1', 'not charged');
  assert.equal(kv.puts.filter((x) => x.k === RLK).length, 0);
  const r = await getResult({ BOTU_RL: kv.binding }, '?job=' + job_id);
  assert.equal(r.status, 200);
  const body = await r.text();
  scanNoLeak(body, 'result error response');
});

// ── leak surface scan ─────────────────────────────
test('leak scan: dirty-upstream v5 full chain (POST response + alarm terminal state + job values + result response) has no forbidden tokens; result.js/worker sources have none either', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: dirtyFetch });
  const bodies = [];
  // Dirty failure chain (POST → alarm → error terminal state → result)
  const r1 = await post(env);
  bodies.push(await r1.text());
  const j1 = JSON.parse(bodies[0]);
  await doMock.alarm(`job-${j1.job_id}`);
  const r2 = await getResult({ BOTU_RL: kv.binding }, '?job=' + j1.job_id);
  bodies.push(await r2.text());
  // Success chain (an OSS signed URL exists in the mock and must never leak)
  const ok = envWith({ fetchMock: okFetch });
  const r3 = await post(ok.env);
  bodies.push(await r3.text());
  const j3 = JSON.parse(bodies[2]);
  await ok.doMock.alarm(`job-${j3.job_id}`);
  const r4 = await getResult({ BOTU_RL: ok.kv.binding }, '?job=' + j3.job_id);
  bodies.push(await r4.text());
  // 404/405 branches
  bodies.push(await (await getResult({ BOTU_RL: kv.binding }, '?job=' + 'ab'.repeat(16))).text());
  bodies.push(await (await getResult({ BOTU_RL: kv.binding }, '', 'POST')).text());
  // All KV job values (both chains)
  for (const [k, v] of kv.store.entries()) if (k.startsWith('job:')) bodies.push(v);
  for (const [k, v] of ok.kv.store.entries()) if (k.startsWith('job:')) bodies.push(v);
  for (const b of bodies) scanNoLeak(b, 'response/job value');
  assert.ok(!bodies.some((b) => b.includes('sig=1')), 'the signed-URL fragment never leaks');
  // The result.js / worker sources themselves contain no forbidden tokens (lib/jobcore.js holds the sanitizeError forbidden-token regexes and the gateway path constant — functionally required, noted separately)
  const rsrc = readFileSync(join(ROOT, 'functions/api/result.js'), 'utf8');
  scanNoLeak(rsrc, 'result.js source');
  const wsrc = readFileSync(join(ROOT, 'worker/src/index.js'), 'utf8');
  scanNoLeak(wsrc, 'worker source');
});

// ── SPEC-435/T-736 v5: DO JobRunner executor unit tests ──────────────────
test('alarm idempotency guard: job already terminal (done) → short-circuit cleanup, no upstream call, no double charge', async () => {
  let fetched = 0;
  const counting = async (url) => { fetched += 1; return okFetch(url); };
  const { kv, env, doMock } = envWith({ fetchMock: counting });
  const res = await post(env);
  const { job_id } = await res.json();
  await doMock.alarm(`job-${job_id}`);
  assert.equal(kv.store.get(RLK), '1', 'the first alarm charges exactly once');
  const callsAfterFirst = fetched;
  assert.equal(callsAfterFirst, 2, '2 fetches total: upstream + image download');
  // Platform at-least-once redelivery: re-seed meta and run the alarm again → the guard short-circuits
  const inst = doMock.inst(`job-${job_id}`);
  await inst.st.storage.put('job', { jobId: job_id, ip: IP });
  await doMock.alarm(`job-${job_id}`);
  assert.equal(fetched, callsAfterFirst, 'terminal short-circuit: no upstream call');
  assert.equal(kv.store.get(RLK), '1', 'no double charge');
  const job = await jobRead({ BOTU_RL: kv.binding }, job_id);
  assert.equal(job.state, 'done', 'the terminal state is not overwritten');
});

test('attempts cap: ≥MAX_JOB_ATTEMPTS → error terminal state stops retries, no upstream call, no charge', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: okFetch });
  const res = await post(env);
  const { job_id } = await res.json();
  const inst = doMock.inst(`job-${job_id}`);
  // Simulate the first two alarms crashing mid-way (no terminal state written); the platform redelivers a third time
  await inst.st.storage.put('attempts', MAX_JOB_ATTEMPTS - 1);
  let fetched = 0;
  env.__fetch = async (url) => { fetched += 1; return okFetch(url); };
  await doMock.alarm(`job-${job_id}`);
  assert.equal(fetched, 0, 'attempts exhausted: no further generation');
  const job = await jobRead({ BOTU_RL: kv.binding }, job_id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, 'generation failed after retries');
  scanNoLeak(job.error, 'attempts error text');
  assert.equal(kv.store.has(RLK), false, 'not charged');
  assert.equal(kv.deletes.includes(imgKey(job_id)), true, 'img cleaned up');
  assert.equal(inst.st.data.size, 0, 'storage cleared');
});

test('5min hard timeout: abort → error terminal state "generation timed out", not charged', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: slowFetch(400) });
  env.__JOB_HARD_TIMEOUT_MS = 30; // ms-scale for unit tests; production default is JOB_HARD_TIMEOUT_MS=300000
  const res = await post(env);
  const { job_id } = await res.json();
  await doMock.alarm(`job-${job_id}`);
  const job = await jobRead({ BOTU_RL: kv.binding }, job_id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, TIMEOUT_ERROR);
  scanNoLeak(job.error, 'timeout error text');
  assert.equal(kv.store.has(RLK), false, 'a timeout is not charged');
  const r = await getResult({ BOTU_RL: kv.binding }, '?job=' + job_id);
  const body = await r.text();
  scanNoLeak(body, 'timeout result response');
  assert.equal(JSON.parse(body).state, 'error');
});

test('img missing (TTL expired): the alarm writes the "job input expired" terminal state, no upstream call, no charge', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: okFetch });
  const res = await post(env);
  const { job_id } = await res.json();
  let fetched = 0;
  env.__fetch = async (url) => { fetched += 1; return okFetch(url); };
  kv.store.delete(imgKey(job_id)); // simulate the 1h TTL expiring
  await doMock.alarm(`job-${job_id}`);
  assert.equal(fetched, 0);
  const job = await jobRead({ BOTU_RL: kv.binding }, job_id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, 'job input expired');
  assert.equal(kv.store.has(RLK), false);
});

test('the error terminal state also deletes the img payload (the failure chain leaves no large image behind)', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: dirtyFetch });
  const res = await post(env);
  const { job_id } = await res.json();
  assert.equal(kv.store.has(imgKey(job_id)), true);
  await doMock.alarm(`job-${job_id}`);
  assert.equal(kv.store.has(imgKey(job_id)), false, 'img deleted after the error terminal state');
  assert.deepEqual(kv.deletes, [imgKey(job_id)]);
});

test('dispatch failures: missing binding / stub.fetch throws / non-2xx → 500, the job stays pending, not charged', async () => {
  // Missing binding
  const a = envWith();
  delete a.env.JOB_RUNNER;
  const r1 = await post(a.env);
  assert.equal(r1.status, 500);
  assert.equal((await r1.json()).error, 'job dispatch unavailable');
  // stub.fetch throws
  const b = envWith();
  b.env.JOB_RUNNER = { idFromName: (n) => ({ n }), get: () => ({ fetch: async () => { throw new Error('do unreachable'); } }) };
  const r2 = await post(b.env);
  assert.equal(r2.status, 500);
  assert.equal((await r2.json()).error, 'job dispatch unavailable');
  // Non-2xx
  const c = envWith();
  c.env.JOB_RUNNER = { idFromName: (n) => ({ n }), get: () => ({ fetch: async () => new Response('x', { status: 503 }) }) };
  const r3 = await post(c.env);
  assert.equal(r3.status, 500);
  assert.equal((await r3.json()).error, 'job dispatch unavailable');
  // The job record is already pending (a 500 does not roll back KV; the 1h TTL cleans up), no charge
  assert.equal(a.kv.store.get(RLK), undefined);
  for (const [k, v] of a.kv.store.entries()) if (k.startsWith('job:')) assert.equal(JSON.parse(v).state, 'pending');
});

test('JobRunner.fetch: invalid job id → 400 without setAlarm; valid → 204 + meta + immediate setAlarm', async () => {
  const { env, doMock } = envWith();
  const badName = 'job-' + newJobId();
  const badStub = doMock.binding.get(doMock.binding.idFromName(badName));
  const bad = await badStub.fetch('https://job.internal/run', { headers: { 'x-botu-job': 'not-hex!!' } });
  assert.equal(bad.status, 400);
  assert.equal(doMock.inst(badName).st.alarmAt, null, 'an invalid id does not setAlarm');
  const jobId = newJobId();
  const name = `job-${jobId}`;
  const stub = doMock.binding.get(doMock.binding.idFromName(name));
  const good = await stub.fetch('https://job.internal/run', { headers: { 'x-botu-job': jobId, 'x-botu-ip': IP } });
  assert.equal(good.status, 204);
  const inst = doMock.inst(name);
  const meta = inst.st.data.get('job');
  assert.equal(meta.jobId, jobId);
  assert.equal(meta.ip, IP);
  assert.ok(Math.abs(inst.st.alarmAt - Date.now()) < 5000, 'setAlarm immediate');
});

test('meta missing: the alarm clears storage and returns safely (no throw, no KV writes)', async () => {
  const { kv, env, doMock } = envWith();
  const name = `job-${newJobId()}`;
  doMock.binding.get(doMock.binding.idFromName(name)); // instantiate but do not seed meta
  await doMock.alarm(name);
  assert.equal(doMock.inst(name).st.deleteAllCount, 1);
  assert.equal(kv.puts.length, 0, 'no KV writes');
});

test('worker health entry: default.fetch → 200', async () => {
  const mod = await import('../worker/src/index.js');
  const res = await mod.default.fetch(new Request('https://x/'));
  assert.equal(res.status, 200);
  scanNoLeak(await res.text(), 'worker health response');
});
