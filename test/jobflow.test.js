// test/jobflow.test.js — SPEC-433/T-733 W5：异步 job 流单测（KV stub 内存 Map）
// 覆盖：POST 分支语义 / job_id 形状 / result 四分支（404/pending/done/error）/ quota 恰好一次幂等 /
// error 不扣 / 泄漏断言（响应体 + job 值 + result.js 源码 无上游 token）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  UPSTREAM_URL, DAILY_LIMIT, JOB_TTL, jobKey, newJobId, jobRead, sanitizeError,
  rlKey, utcDay, onRequestPost, onRequestGet,
} from '../functions/api/generate.js';
import { onRequest as resultHandler } from '../functions/api/result.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const B64 = 'aGVsbG8=';
const TEST_KEY = ['te'+'st', '_ke'+'y'].join('');
const IP = '1.2.3.4';
const DAY = utcDay();
const RLK = rlKey(IP, DAY);
const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);

const okUpstream = {
  output: { choices: [{ message: { content: [{ text: 'done' }, { image: 'https://oss.example/gen.png?sig=1' }] } }] },
};

// 泄漏断言用禁词（碎片拼接构造，避免测试文件自身出现连续 token 形态）
const FORBIDDEN = [
  new RegExp(['dash', 'scope'].join(''), 'i'),
  /sk-/i,
  new RegExp(['Sign', 'ature='].join(''), 'i'),
  new RegExp(['x-', 'oss-'].join(''), 'i'),
];
// 脏上游错误体：故意携带全部禁词 + 签名 URL，验证脱敏
const DIRTY_BODY = 'rate limited ' + ['sk', 'LEAK123'].join('-')
  + ' ' + ['Sign', 'ature=SEC'].join('')
  + ' ' + ['x-', 'oss-', 'cred'].join('')
  + ' via https://' + ['dash', 'scope'].join('') + '.aliyuncs.com/x?sig=1';

function mockKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  const puts = [];
  return {
    store,
    puts,
    binding: {
      async get(k) {
        if (store.has(k)) return store.get(k);
        return null;
      },
      async put(k, v, opts) { puts.push({ k, v, opts }); store.set(k, v); },
    },
  };
}

const okFetch = async (url) => (url === UPSTREAM_URL
  ? Response.json(okUpstream)
  : new Response(pngBytes, { status: 200 }));

const dirtyFetch = async (url) => (url === UPSTREAM_URL
  ? new Response(DIRTY_BODY, { status: 500 })
  : new Response(pngBytes, { status: 200 }));

// SPEC-433 hotfix：慢上游 stub — 模拟生产 DashScope 2-4min 出图（ms 级缩放），断言响应先行
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

function ctxStub() {
  const captured = [];
  return { captured, ctx: { waitUntil: (p) => captured.push(p) } };
}

// Pages Functions 生产 context 形状：顶层 waitUntil、无 ctx 字段
//（wrangler templates/pages-template-worker.ts 构造，旧代码只认 ctx.waitUntil → 内联 → 524）
function pagesCtxStub() {
  const captured = [];
  return { captured, waitUntil: (p) => captured.push(p) };
}

function scanNoLeak(text, label) {
  for (const re of FORBIDDEN) {
    assert.ok(!re.test(String(text)), `${label} 泄漏禁词 ${re}`);
  }
}

// ── 常量 / id / 脱敏 ────────────────────────────
test('job 常量与 id：JOB_TTL=3600，jobKey 前缀，newJobId 32-hex 唯一', () => {
  assert.equal(JOB_TTL, 3600);
  assert.equal(jobKey('abc'), 'job:abc');
  const a = newJobId();
  const b = newJobId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('sanitizeError：剥 URL/凭证样 token/上游域名，截断 200', () => {
  const out = sanitizeError(DIRTY_BODY + 'x'.repeat(300));
  scanNoLeak(out, 'sanitizeError 输出');
  assert.ok(out.length <= 200);
  assert.equal(sanitizeError(null), '');
  assert.equal(sanitizeError(undefined), '');
});

// ── POST：job 创建 + waitUntil 时序 ─────────────
test('POST happy：ctx.waitUntil 捕获，响应先行 200 {job_id}；job 先 pending 后 done', async () => {
  const kv = mockKV();
  const { captured, ctx } = ctxStub();
  const res = await post({ DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding, __fetch: okFetch }, { ctx });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(Object.keys(j), ['job_id']);
  assert.match(j.job_id, /^[0-9a-f]{32}$/);
  assert.equal(captured.length, 1, 'waitUntil 恰好一次');
  // 后台未完成时：KV 为 pending，result 回 pending
  const pend = await jobRead({ BOTU_RL: kv.binding }, j.job_id);
  assert.equal(pend.state, 'pending');
  assert.equal(pend.ip, IP);
  assert.equal(kv.store.get(jobKey(j.job_id)).includes('"state":"pending"'), true);
  const pr = await getResult({ BOTU_RL: kv.binding }, '?job=' + j.job_id);
  assert.deepEqual(await pr.json(), { state: 'pending' });
  // 等后台跑完 → done
  await captured[0];
  const done = await jobRead({ BOTU_RL: kv.binding }, j.job_id);
  assert.equal(done.state, 'done');
  assert.equal(done.mime, 'image/png');
  assert.equal(done.image_b64, Buffer.from(pngBytes).toString('base64'));
  assert.equal(done.counted, true);
  assert.equal(done.remaining, DAILY_LIMIT - 1);
  assert.equal(kv.store.get(RLK), '1', 'quota 成功后 +1');
  const dr = await getResult({ BOTU_RL: kv.binding }, '?job=' + j.job_id);
  const dj = await dr.json();
  assert.equal(dj.state, 'done');
  assert.equal(dj.image_base64, done.image_b64);
  assert.equal(dj.remaining, DAILY_LIMIT - 1);
  assert.equal('counted' in dj, false, 'counted 标记不出响应');
});

test('POST：job put 带 TTL 3600，值为 JSON', async () => {
  const kv = mockKV();
  const { captured, ctx } = ctxStub();
  const res = await post({ DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding, __fetch: okFetch }, { ctx });
  const { job_id } = await res.json();
  const jobPut = kv.puts.find((x) => x.k === jobKey(job_id));
  assert.equal(jobPut.opts.expirationTtl, JOB_TTL);
  assert.equal(typeof JSON.parse(jobPut.v), 'object');
  await captured[0];
});

// SPEC-433 hotfix 回归：旧代码下必红（无 ctx → 内联 await run → elapsed ≥1500ms）
test('POST Pages 生产形状：顶层 waitUntil + 慢上游(1500ms) → 响应先行（线上 524 根因回归）', async () => {
  const kv = mockKV();
  const { captured, waitUntil } = pagesCtxStub();
  const t0 = Date.now();
  const res = await post({ DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding, __fetch: slowFetch(1500) }, { waitUntil });
  const elapsed = Date.now() - t0;
  const bodyText = await res.text();
  scanNoLeak(bodyText, 'Pages 形状 POST 响应');
  assert.ok(elapsed < 800, `响应先行：elapsed=${elapsed}ms 应 <800ms（旧代码内联兜底会 ≥1500ms）`);
  assert.equal(res.status, 200);
  const j = JSON.parse(bodyText);
  assert.deepEqual(Object.keys(j), ['job_id']);
  assert.match(j.job_id, /^[0-9a-f]{32}$/);
  assert.equal(captured.length, 1, '顶层 waitUntil 恰好捕获一次');
  // 后台未完成（慢上游仍在跑）：result 回 pending
  const pr = await getResult({ BOTU_RL: kv.binding }, '?job=' + j.job_id);
  assert.deepEqual(await pr.json(), { state: 'pending' });
  // 等后台跑完 → done，quota 恰好一次
  await captured[0];
  const done = await jobRead({ BOTU_RL: kv.binding }, j.job_id);
  assert.equal(done.state, 'done');
  assert.equal(done.counted, true);
  assert.equal(kv.store.get(RLK), '1', 'rl 计数恰好 1');
});

// ── POST：校验 / quota 分支语义不变 ─────────────
test('POST 非法 JSON → 400；非白名单 mime → 400：均不建 job 不打上游', async () => {
  const kv = mockKV();
  let fetched = 0;
  const env = { DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding, __fetch: async () => { fetched += 1; return new Response('x'); } };
  const r1 = await post(env, { body: 'not-json{' });
  assert.equal(r1.status, 400);
  const r2 = await post(env, { body: JSON.stringify({ image_base64: B64, mime: 'image/gif' }) });
  assert.equal(r2.status, 400);
  assert.equal(fetched, 0);
  assert.equal(kv.puts.length, 0);
});

test('POST quota 超限 → 429 {error, remaining:0}：不建 job 不打上游', async () => {
  const kv = mockKV({ [RLK]: '5' });
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

test('POST 无 KV binding → 500 job store unavailable，不打上游（quota 仍 fail-open）', async () => {
  let fetched = 0;
  const res = await post({
    DASHSCOPE_API_KEY: TEST_KEY,
    __fetch: async () => { fetched += 1; return new Response('x'); },
  });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'job store unavailable');
  assert.equal(fetched, 0);
});

test('GET /api/generate → 405（语义不变）', async () => {
  assert.equal((await onRequestGet()).status, 405);
});

// ── GET /api/result：四分支 + 异常路径 ────────────
test('result 404：未知 id / 缺参 / 非法 id / 损坏值', async () => {
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

test('result：KV get 抛异常 → 500（与 404 区分）；非 GET → 405', async () => {
  const bad = { get: async () => { throw new Error('kv down'); } };
  const r = await getResult({ BOTU_RL: bad }, '?job=' + 'ab'.repeat(16));
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'job store unavailable');
  const m = await getResult({}, '?job=' + 'ab'.repeat(16), 'POST');
  assert.equal(m.status, 405);
});

test('result done/error 分支形状（直塞 KV 值）', async () => {
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

// ── quota 恰好一次 / error 不扣 ─────────────────
test('quota 恰好一次：done 后重复 poll 计数不涨（幂等）', async () => {
  const kv = mockKV({ [RLK]: '2' });
  const { captured, ctx } = ctxStub();
  const res = await post({ DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding, __fetch: okFetch }, { ctx });
  const { job_id } = await res.json();
  await captured[0];
  assert.equal(kv.store.get(RLK), '3', '成功 +1');
  const rlPutsBefore = kv.puts.filter((x) => x.k === RLK).length;
  for (let i = 0; i < 3; i += 1) {
    const r = await getResult({ BOTU_RL: kv.binding }, '?job=' + job_id);
    const j = await r.json();
    assert.equal(j.state, 'done');
    assert.equal(j.remaining, DAILY_LIMIT - 3);
  }
  assert.equal(kv.store.get(RLK), '3', '重复 poll 不再涨');
  assert.equal(kv.puts.filter((x) => x.k === RLK).length, rlPutsBefore, '无额外 rl 写');
});

test('error 不扣：上游失败 → job error（已脱敏），rl 计数不变', async () => {
  const kv = mockKV({ [RLK]: '1' });
  const { captured, ctx } = ctxStub();
  const res = await post({ DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding, __fetch: dirtyFetch }, { ctx });
  const { job_id } = await res.json();
  await captured[0];
  const job = await jobRead({ BOTU_RL: kv.binding }, job_id);
  assert.equal(job.state, 'error');
  scanNoLeak(job.error, 'job.error');
  assert.match(job.error, /upstream 500/);
  assert.equal(kv.store.get(RLK), '1', '不扣');
  assert.equal(kv.puts.filter((x) => x.k === RLK).length, 0);
  const r = await getResult({ BOTU_RL: kv.binding }, '?job=' + job_id);
  assert.equal(r.status, 200);
  const body = await r.text();
  scanNoLeak(body, 'result error 响应');
});

// ── 泄漏扇面扫描 ─────────────────────────────
test('泄漏扫描：脏上游全链路（POST 响应 + job 值 + result 响应）无禁词；result.js 源码无禁词', async () => {
  const kv = mockKV();
  const { captured, ctx } = ctxStub();
  const bodies = [];
  // 脏失败链路
  const r1 = await post({ DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding, __fetch: dirtyFetch }, { ctx });
  bodies.push(await r1.text());
  const j1 = JSON.parse(bodies[0]);
  await captured[0];
  const r2 = await getResult({ BOTU_RL: kv.binding }, '?job=' + j1.job_id);
  bodies.push(await r2.text());
  // 成功链路（OSS 签名 URL 存在于 mock 中，不得外泄）
  const { captured: c2, ctx: ctx2 } = ctxStub();
  const r3 = await post({ DASHSCOPE_API_KEY: TEST_KEY, BOTU_RL: kv.binding, __fetch: okFetch }, { ctx2 });
  bodies.push(await r3.text());
  const j3 = JSON.parse(bodies[2]);
  await c2[0];
  const r4 = await getResult({ BOTU_RL: kv.binding }, '?job=' + j3.job_id);
  bodies.push(await r4.text());
  // 404/405/500 分支
  bodies.push(await (await getResult({ BOTU_RL: kv.binding }, '?job=' + 'ab'.repeat(16))).text());
  bodies.push(await (await getResult({ BOTU_RL: kv.binding }, '', 'POST')).text());
  // 全部 KV job 值
  for (const [k, v] of kv.store.entries()) if (k.startsWith('job:')) bodies.push(v);
  for (const b of bodies) scanNoLeak(b, '响应/job 值');
  assert.ok(!bodies.some((b) => b.includes('sig=1')), '签名 URL 片段不外泄');
  // result.js 源码自身无禁词（generate.js 含 UPSTREAM_URL 功能常量，属不动区，另行备注）
  const rsrc = readFileSync(join(ROOT, 'functions/api/result.js'), 'utf8');
  scanNoLeak(rsrc, 'result.js 源码');
});
