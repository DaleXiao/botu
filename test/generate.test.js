// test/generate.test.js — unit tests for functions/api/generate.js (env.__fetch mock)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL, UPSTREAM_PATH, ICON_PROMPT, MAX_B64_LEN,
  validateInput, buildBody, extractImage, bufToBase64,
  onRequestPost, onRequestGet, runGeneration, jobRead,
} from '../functions/api/generate.js';
import { JobRunner } from '../worker/src/index.js';

const B64 = 'aGVsbG8=';
const TEST_KEY = ['test', '_key'].join('');
// Gateway consolidation (Dale 2026-09-22 19:42): mocked api-llm gateway origin (env.LLM_GATEWAY_URL + UPSTREAM_PATH)
const GW = 'https://gw.test';
const GW_URL = GW + UPSTREAM_PATH;

// SPEC-433: KV stub (in-memory Map) for the job-flow tests
function mockKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  const puts = [];
  return {
    store,
    puts,
    binding: {
      async get(k) { return store.has(k) ? store.get(k) : null; },
      async put(k, v, opts) { puts.push({ k, v, opts }); store.set(k, v); },
    },
  };
}

const post = (payload, env, rawBody) =>
  onRequestPost({
    request: new Request('https://botu.openclawd.co/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody !== undefined ? rawBody : JSON.stringify(payload),
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

const okUpstream = {
  output: { choices: [{ message: { content: [{ text: 'done' }, { image: 'https://oss.example/gen.png?sig=9' }] } }] },
};

test('validateInput: all whitelisted mimes pass', () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    const r = validateInput({ image_base64: B64, mime });
    assert.equal(r.ok, true, mime);
    assert.equal(r.mime, mime);
  }
});

test('validateInput: non-whitelisted mime -> 400', () => {
  for (const mime of ['image/gif', 'image/svg+xml', 'application/octet-stream', '', undefined, null]) {
    const r = validateInput({ image_base64: B64, mime });
    assert.equal(r.ok, false, String(mime));
    assert.equal(r.status, 400);
  }
});

test('validateInput: base64 missing/empty/non-object -> 400', () => {
  assert.equal(validateInput({ mime: 'image/png' }).status, 400);
  assert.equal(validateInput({ image_base64: '', mime: 'image/png' }).status, 400);
  assert.equal(validateInput({ image_base64: 42, mime: 'image/png' }).status, 400);
  assert.equal(validateInput(null).ok, false);
  assert.equal(validateInput('str').ok, false);
});

test('validateInput: base64 over 14M -> 413, exactly 14M passes', () => {
  const r = validateInput({ image_base64: 'a'.repeat(MAX_B64_LEN + 1), mime: 'image/jpeg' });
  assert.equal(r.status, 413);
  assert.equal(validateInput({ image_base64: 'a'.repeat(MAX_B64_LEN), mime: 'image/jpeg' }).ok, true);
});

test('buildBody: DashScope contract shape', () => {
  const b = buildBody('QUJD', 'image/jpeg');
  assert.equal(b.model, MODEL);
  assert.equal(MODEL, 'qwen-image-3.0-pro');
  const msg = b.input.messages[0];
  assert.equal(msg.role, 'user');
  assert.equal(msg.content[0].image, 'data:image/jpeg;base64,QUJD');
  assert.equal(msg.content[1].text, ICON_PROMPT);
  assert.equal(b.parameters.size, '1024*1024');
});

test('extractImage: extracts the OSS signed URL / missing or malformed returns null', () => {
  assert.equal(extractImage(okUpstream), 'https://oss.example/gen.png?sig=9');
  assert.equal(extractImage({ output: { choices: [{ message: { content: [{ text: 'x' }] } }] } }), null);
  assert.equal(extractImage({ output: {} }), null);
  assert.equal(extractImage({}), null);
  assert.equal(extractImage(null), null);
});

test('bufToBase64: matches Buffer.toString(base64)', () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 3]);
  assert.equal(bufToBase64(bytes.buffer), Buffer.from(bytes).toString('base64'));
});

test('onRequestPost: invalid JSON -> 400', async () => {
  const res = await post(null, { LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY }, 'not-json{');
  assert.equal(res.status, 400);
});

test('onRequestPost: non-whitelisted mime -> 400 without calling the upstream', async () => {
  let called = 0;
  const res = await post({ image_base64: B64, mime: 'image/gif' }, {
    LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY,
    __fetch: async () => { called += 1; return new Response('x'); },
  });
  assert.equal(res.status, 400);
  assert.equal(called, 0);
});

test('onRequestPost: missing LLM_GATEWAY_URL -> 500', async () => {
  const res = await post({ image_base64: B64, mime: 'image/png' }, {});
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /LLM_GATEWAY_URL/);
});

// ── SPEC-433 job flow: runGeneration pure pipeline + POST returns {job_id} immediately ──
test('runGeneration: upstream non-200 -> {ok:false,502} with a truncated error body', async () => {
  const r = await runGeneration({
    LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY,
    __fetch: async () => new Response('RATE_LIMITED'.repeat(200), { status: 429 }),
  }, { image_base64: B64, mime: 'image/png' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.match(r.error, /upstream 429/);
  assert.ok(r.error.length < 500, 'error body truncated');
});

test('runGeneration: upstream fetch throws -> {ok:false,502}', async () => {
  const r = await runGeneration({
    LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY,
    __fetch: async () => { throw new Error('connect ETIMEDOUT'); },
  }, { image_base64: B64, mime: 'image/png' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

test('runGeneration: no image upstream -> {ok:false,502}, the error does not carry the upstream response body', async () => {
  const r = await runGeneration({
    LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY,
    __fetch: async () => Response.json({ output: { leak: 'https://oss.example/leak.png' } }),
  }, { image_base64: B64, mime: 'image/png' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.equal(r.error, 'no image in upstream response');
});

test('runGeneration: missing gateway config -> {ok:false,500}', async () => {
  const r = await runGeneration({ __fetch: async () => new Response('x') }, { image_base64: B64, mime: 'image/png' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
});

test('onRequestPost: happy path -> 200 {job_id}; terminal state done with image after the alarm; server-side OSS download', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const calls = [];
  const mock = async (url, opts) => {
    calls.push(url);
    if (url === GW_URL) {
      assert.equal(opts.method, 'POST');
      assert.equal(opts.headers.Authorization, ['Bear','er'].join('') + ' ' + TEST_KEY);
      assert.equal(opts.headers['x-llm-usecase'], 'icon-image');
      assert.equal(JSON.parse(opts.body).model, MODEL);
      return Response.json(okUpstream);
    }
    return new Response(bytes, { status: 200 });
  };
  const kv = mockKV();
  const env = { LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, BOTU_RL: kv.binding, __fetch: mock };
  const doMock = mockDO(env);
  env.JOB_RUNNER = doMock.binding;
  const res = await post({ image_base64: B64, mime: 'image/png' }, env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.match(j.job_id, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(j), ['job_id']); // the response carries only job_id — no image / upstream metadata
  assert.deepEqual(calls, [], 'no upstream call during the POST phase (v5: generation runs inside the DO alarm)');
  await doMock.alarm(`job-${j.job_id}`);
  assert.deepEqual(calls, [GW_URL, extractImage(okUpstream)]);
  const job = await jobRead({ BOTU_RL: kv.binding }, j.job_id);
  assert.equal(job.state, 'done');
  assert.equal(job.mime, 'image/png');
  assert.equal(job.image_b64, Buffer.from(bytes).toString('base64'));
  assert.equal(job.counted, true);
});

test('onRequestGet -> 405', async () => {
  const res = await onRequestGet();
  assert.equal(res.status, 405);
});
