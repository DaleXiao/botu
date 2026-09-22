// test/generate.test.js — functions/api/generate.js 单测（env.__fetch mock）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL, UPSTREAM_URL, ICON_PROMPT, MAX_B64_LEN,
  validateInput, buildBody, extractImage, bufToBase64,
  onRequestPost, onRequestGet,
} from '../functions/api/generate.js';

const B64 = 'aGVsbG8=';

const post = (payload, env, rawBody) =>
  onRequestPost({
    request: new Request('https://botu.openclawd.co/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody !== undefined ? rawBody : JSON.stringify(payload),
    }),
    env,
  });

const okUpstream = {
  output: { choices: [{ message: { content: [{ text: 'done' }, { image: 'https://oss.example/gen.png?sig=9' }] } }] },
};

test('validateInput: 白名单 mime 全通过', () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    const r = validateInput({ image_base64: B64, mime });
    assert.equal(r.ok, true, mime);
    assert.equal(r.mime, mime);
  }
});

test('validateInput: 非白名单 mime -> 400', () => {
  for (const mime of ['image/gif', 'image/svg+xml', 'application/octet-stream', '', undefined, null]) {
    const r = validateInput({ image_base64: B64, mime });
    assert.equal(r.ok, false, String(mime));
    assert.equal(r.status, 400);
  }
});

test('validateInput: base64 缺失/空/非对象 -> 400', () => {
  assert.equal(validateInput({ mime: 'image/png' }).status, 400);
  assert.equal(validateInput({ image_base64: '', mime: 'image/png' }).status, 400);
  assert.equal(validateInput({ image_base64: 42, mime: 'image/png' }).status, 400);
  assert.equal(validateInput(null).ok, false);
  assert.equal(validateInput('str').ok, false);
});

test('validateInput: base64 超 14M -> 413，恰好 14M 通过', () => {
  const r = validateInput({ image_base64: 'a'.repeat(MAX_B64_LEN + 1), mime: 'image/jpeg' });
  assert.equal(r.status, 413);
  assert.equal(validateInput({ image_base64: 'a'.repeat(MAX_B64_LEN), mime: 'image/jpeg' }).ok, true);
});

test('buildBody: DashScope 契约形状', () => {
  const b = buildBody('QUJD', 'image/jpeg');
  assert.equal(b.model, MODEL);
  assert.equal(MODEL, 'qwen-image-3.0-pro');
  const msg = b.input.messages[0];
  assert.equal(msg.role, 'user');
  assert.equal(msg.content[0].image, 'data:image/jpeg;base64,QUJD');
  assert.equal(msg.content[1].text, ICON_PROMPT);
  assert.equal(b.parameters.size, '1024*1024');
});

test('extractImage: 取 OSS 签名 URL / 缺失畸形返回 null', () => {
  assert.equal(extractImage(okUpstream), 'https://oss.example/gen.png?sig=9');
  assert.equal(extractImage({ output: { choices: [{ message: { content: [{ text: 'x' }] } }] } }), null);
  assert.equal(extractImage({ output: {} }), null);
  assert.equal(extractImage({}), null);
  assert.equal(extractImage(null), null);
});

test('bufToBase64: 与 Buffer.toString(base64) 一致', () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 3]);
  assert.equal(bufToBase64(bytes.buffer), Buffer.from(bytes).toString('base64'));
});

test('onRequestPost: 非法 JSON -> 400', async () => {
  const res = await post(null, { DASHSCOPE_API_KEY: '***' }, 'not-json{');
  assert.equal(res.status, 400);
});

test('onRequestPost: 非白名单 mime -> 400 且不打上游', async () => {
  let called = 0;
  const res = await post({ image_base64: B64, mime: 'image/gif' }, {
    DASHSCOPE_API_KEY: '***',
    __fetch: async () => { called += 1; return new Response('x'); },
  });
  assert.equal(res.status, 400);
  assert.equal(called, 0);
});

test('onRequestPost: 缺 DASHSCOPE_API_KEY -> 500', async () => {
  const res = await post({ image_base64: B64, mime: 'image/png' }, {});
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /DASHSCOPE_API_KEY/);
});

test('onRequestPost: 上游非 200 -> 502 带截断错误体', async () => {
  const res = await post({ image_base64: B64, mime: 'image/png' }, {
    DASHSCOPE_API_KEY: '***',
    __fetch: async () => new Response('RATE_LIMITED'.repeat(200), { status: 429 }),
  });
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.match(j.error, /upstream 429/);
  assert.ok(j.error.length < 500, 'error body truncated');
});

test('onRequestPost: 上游 fetch 抛异常 -> 502', async () => {
  const res = await post({ image_base64: B64, mime: 'image/png' }, {
    DASHSCOPE_API_KEY: '***',
    __fetch: async () => { throw new Error('connect ETIMEDOUT'); },
  });
  assert.equal(res.status, 502);
});

test('onRequestPost: 上游无 image -> 502', async () => {
  const res = await post({ image_base64: B64, mime: 'image/png' }, {
    DASHSCOPE_API_KEY: '***',
    __fetch: async () => Response.json({ output: {} }),
  });
  assert.equal(res.status, 502);
});

test('onRequestPost: happy path -> 服务端下载 OSS，返回 {image_base64, mime:image/png}', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const calls = [];
  const mock = async (url, opts) => {
    calls.push(url);
    if (url === UPSTREAM_URL) {
      assert.equal(opts.method, 'POST');
      assert.equal(opts.headers.Authorization, '***');
      assert.equal(JSON.parse(opts.body).model, MODEL);
      return Response.json(okUpstream);
    }
    return new Response(bytes, { status: 200 });
  };
  const res = await post({ image_base64: B64, mime: 'image/png' }, { DASHSCOPE_API_KEY: '***', __fetch: mock });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.mime, 'image/png');
  assert.equal(j.image_base64, Buffer.from(bytes).toString('base64'));
  assert.deepEqual(calls, [UPSTREAM_URL, 'https://oss.example/gen.png?sig=9']);
});

test('onRequestGet -> 405', async () => {
  const res = await onRequestGet();
  assert.equal(res.status, 405);
});
