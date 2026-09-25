// test/binding.test.mjs — SPEC-440/T-742 service-binding two-leg split unit tests
// Hard constraint (lynx ev20535): the API_LLM binding may only serve the gateway POST leg; the image-download leg
// (the external absolute URL returned by extractImage, e.g. OSS) never uses the binding (non-/v1/* path → 404 → 100% failure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGeneration, UPSTREAM_PATH, LLM_USECASE } from '../lib/jobcore.js';

const B64 = 'aGVsbG8=';
const TEST_KEY = ['test', '_key'].join('');
const GW = 'https://gw.test';
const GW_URL = GW + UPSTREAM_PATH;
const IMG_URL = 'https://oss.example/img.png';

const V = { image_base64: B64, mime: 'image/png' };

const gwResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ output: { choices: [{ message: { content: [{ image: IMG_URL }] } }] } }),
});
const imgResponse = () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
});

function mockApiLlm() {
  const calls = [];
  return {
    calls,
    binding: {
      async fetch(url, init) {
        calls.push({ url, init });
        return gwResponse();
      },
    },
  };
}

test('1. both __fetch and API_LLM present: the gateway leg uses __fetch, API_LLM.fetch call count = 0', async () => {
  const apiLlm = mockApiLlm();
  const urls = [];
  const __fetch = async (url) => {
    urls.push(url);
    return url === GW_URL ? gwResponse() : imgResponse();
  };
  const r = await runGeneration(
    { LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, __fetch, API_LLM: apiLlm.binding },
    V,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(urls, [GW_URL, IMG_URL]);
  assert.equal(apiLlm.calls.length, 0, '__fetch has top priority; the binding is never called');
});

test('2. API_LLM only: the gateway POST goes through the binding, the image-download leg only hits global fetch (total binding calls = 1)', async () => {
  const apiLlm = mockApiLlm();
  const realFetch = globalThis.fetch;
  const globalUrls = [];
  try {
    globalThis.fetch = async (url) => {
      globalUrls.push(url);
      return imgResponse();
    };
    const signal = new AbortController().signal;
    const r = await runGeneration(
      { LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, API_LLM: apiLlm.binding },
      V,
      { signal },
    );
    assert.equal(r.ok, true);
    // Gateway leg: exactly 1 binding POST with all contract fields present
    assert.equal(apiLlm.calls.length, 1, 'total binding call count = 1 (the download leg never uses the binding)');
    const call = apiLlm.calls[0];
    assert.equal(call.url, GW_URL, 'url = LLM_GATEWAY_URL + /v1/images/generations');
    assert.equal(call.init.method, 'POST');
    assert.ok(call.init.headers.Authorization.startsWith('Bearer '), 'Authorization Bearer prefix');
    assert.equal(call.init.headers['x-llm-usecase'], LLM_USECASE);
    assert.equal(LLM_USECASE, 'icon-image');
    assert.equal(call.init.signal, signal, 'the same signal object is passed through');
    // Image leg: the OSS absolute URL only hits global fetch
    assert.deepEqual(globalUrls, [IMG_URL]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('3. neither __fetch nor API_LLM: both legs fall back to global fetch, sequence [gatewayUrl, imgUrl]', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async (url) => {
      urls.push(url);
      return url === GW_URL ? gwResponse() : imgResponse();
    };
    const r = await runGeneration({ LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY }, V);
    assert.equal(r.ok, true);
    assert.deepEqual(urls, [GW_URL, IMG_URL]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('4. the success path returns {ok:true, image_base64 non-empty, mime:image/png}', async () => {
  const apiLlm = mockApiLlm();
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => imgResponse();
    const r = await runGeneration(
      { LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, API_LLM: apiLlm.binding },
      V,
    );
    assert.equal(r.ok, true);
    assert.equal(typeof r.image_base64, 'string');
    assert.ok(r.image_base64.length > 0, 'image_base64 non-empty');
    assert.equal(r.image_base64, Buffer.from([1, 2, 3]).toString('base64'));
    assert.equal(r.mime, 'image/png');
  } finally {
    globalThis.fetch = realFetch;
  }
});
