// test/binding.test.mjs — SPEC-440/T-742 service binding 两腿拆单单测
// 硬约束（lynx ev20535）：API_LLM binding 只准用于 gateway POST 腿；图片下载腿
// （extractImage 返回的外部绝对 URL，如 OSS）永不走 binding（非 /v1/* path → 404 → 100% 失败）。
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

test('① __fetch 与 API_LLM 同在：gateway 腿走 __fetch，API_LLM.fetch 计数=0', async () => {
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
  assert.equal(apiLlm.calls.length, 0, '__fetch 优先级最高，binding 零调用');
});

test('② 仅 API_LLM：gateway POST 走 binding，图片下载腿只落全局 fetch（binding 总调用=1）', async () => {
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
    // gateway 腿：binding 恰好 1 次 POST，契约字段齐全
    assert.equal(apiLlm.calls.length, 1, 'binding 总调用计数=1（下载腿永不走 binding）');
    const call = apiLlm.calls[0];
    assert.equal(call.url, GW_URL, 'url = LLM_GATEWAY_URL + /v1/images/generations');
    assert.equal(call.init.method, 'POST');
    assert.ok(call.init.headers.Authorization.startsWith('Bearer '), 'Authorization Bearer 前缀');
    assert.equal(call.init.headers['x-llm-usecase'], LLM_USECASE);
    assert.equal(LLM_USECASE, 'icon-image');
    assert.equal(call.init.signal, signal, 'signal 透传同一对象');
    // 图片腿：OSS 绝对 URL 只落全局 fetch
    assert.deepEqual(globalUrls, [IMG_URL]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('③ 无 __fetch 无 API_LLM：两腿回落全局 fetch，序列 [gatewayUrl, imgUrl]', async () => {
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

test('④ 成功路径返回 {ok:true, image_base64:非空, mime:image/png}', async () => {
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
    assert.ok(r.image_base64.length > 0, 'image_base64 非空');
    assert.equal(r.image_base64, Buffer.from([1, 2, 3]).toString('base64'));
    assert.equal(r.mime, 'image/png');
  } finally {
    globalThis.fetch = realFetch;
  }
});
