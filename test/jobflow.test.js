// test/jobflow.test.js — SPEC-433/T-733 W5 · SPEC-435/T-736 v5：异步 job 流单测（KV stub 内存 Map）
// 覆盖：POST 分支语义 / job_id 形状 / DO 触发链（stub.fetch→setAlarm→alarm）/ result 四分支 /
// quota 恰好一次幂等 / error 不扣 / alarm 幂等 guard / attempts 上限 / 5min 硬超时 / img TTL /
// 泄漏断言（响应体 + job 值 + result.js & worker 源码 无上游 token）
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
// Gateway 收敛（Dale 2026-09-22 19:42）：mock api-llm gateway 源
const GW = 'https://gw.test';
const GW_URL = GW + UPSTREAM_PATH;
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

// SPEC-435 v5：DO 触发链 mock — stub.fetch 直连真实 JobRunner 实例（storage 内存 stub）。
// 生产链路：Pages POST → JOB_RUNNER stub.fetch → fetch handler 存 meta+setAlarm → 平台回调 alarm()。
// 单测里 alarm 由 doMock.alarm(name) 手动驱动，其余全部真实代码。
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

// 标准 env 装配：KV mock + DO mock + fetch mock（POST 集成测试统一入口）
function envWith({ fetchMock = okFetch, kvInitial } = {}) {
  const kv = mockKV(kvInitial);
  const env = { LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY, BOTU_RL: kv.binding, __fetch: fetchMock };
  const doMock = mockDO(env);
  env.JOB_RUNNER = doMock.binding;
  return { kv, env, doMock };
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
test('POST happy：stub.fetch 触发链，响应先行 200 {job_id}；job 先 pending，alarm 后 done', async () => {
  const { kv, env, doMock } = envWith();
  const res = await post(env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(Object.keys(j), ['job_id']);
  assert.match(j.job_id, /^[0-9a-f]{32}$/);
  // 触发链断言：idFromName(job-<id>) 一 job 一实例 + stub.fetch 恰一次 + headers 带 jobId/ip
  assert.deepEqual(doMock.names, [`job-${j.job_id}`], '一 job 一实例名');
  assert.equal(doMock.dispatches.length, 1, 'stub.fetch 恰好一次');
  assert.equal(doMock.dispatches[0].opts.headers['x-botu-job'], j.job_id);
  assert.equal(doMock.dispatches[0].opts.headers['x-botu-ip'], IP);
  const inst = doMock.inst(`job-${j.job_id}`);
  assert.ok(inst.st.alarmAt !== null && inst.st.alarmAt <= Date.now(), 'setAlarm 立即');
  // alarm 回调前：KV 为 pending，result 回 pending；img 载荷已落 KV
  const pend = await jobRead({ BOTU_RL: kv.binding }, j.job_id);
  assert.equal(pend.state, 'pending');
  assert.equal(pend.ip, IP);
  assert.equal(kv.store.get(jobKey(j.job_id)).includes('"state":"pending"'), true);
  assert.equal(typeof kv.store.get(imgKey(j.job_id)), 'string', 'img:<id> 已写入');
  const pr = await getResult({ BOTU_RL: kv.binding }, '?job=' + j.job_id);
  assert.deepEqual(await pr.json(), { state: 'pending' });
  // alarm 回调（真实 JobRunner.alarm）→ done
  await doMock.alarm(`job-${j.job_id}`);
  const done = await jobRead({ BOTU_RL: kv.binding }, j.job_id);
  assert.equal(done.state, 'done');
  assert.equal(done.mime, 'image/png');
  assert.equal(done.image_b64, Buffer.from(pngBytes).toString('base64'));
  assert.equal(done.counted, true);
  assert.equal(done.remaining, DAILY_LIMIT - 1);
  assert.equal(kv.store.get(RLK), '1', 'quota 成功后 +1');
  assert.deepEqual(kv.deletes, [imgKey(j.job_id)], '终态后删 img 载荷');
  assert.equal(inst.st.deleteAllCount, 1, '终态后 DO storage 清空');
  const dr = await getResult({ BOTU_RL: kv.binding }, '?job=' + j.job_id);
  const dj = await dr.json();
  assert.equal(dj.state, 'done');
  assert.equal(dj.image_base64, done.image_b64);
  assert.equal(dj.remaining, DAILY_LIMIT - 1);
  assert.equal('counted' in dj, false, 'counted 标记不出响应');
});

test('POST：job put 与 img put 均带 TTL 3600，值为 JSON（img 含 image_base64/mime）', async () => {
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
  // 写入顺序：job pending 在前、img 在后（stub.fetch 最后；失败语义见 dispatch 500 分支测试）
  assert.ok(kv.puts.indexOf(jobPut) < kv.puts.indexOf(imgPut));
});

// SPEC-435 v5 回归：慢上游（1500ms 模拟生产 2-4min）不得阻塞 POST 响应 — 生成在 DO alarm 内，
// 既不受 waitUntil 30s 取消（v4 死因），也不占请求壁钟（v3 524 死因）
test('POST + 慢上游(1500ms)：响应先行 <800ms，alarm 回调后才 done（524/30s 根因回归）', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: slowFetch(1500) });
  const t0 = Date.now();
  const res = await post(env);
  const elapsed = Date.now() - t0;
  const bodyText = await res.text();
  scanNoLeak(bodyText, 'v5 POST 响应');
  assert.ok(elapsed < 800, `响应先行：elapsed=${elapsed}ms 应 <800ms（生成在 alarm 内，不占请求）`);
  assert.equal(res.status, 200);
  const j = JSON.parse(bodyText);
  assert.deepEqual(Object.keys(j), ['job_id']);
  assert.match(j.job_id, /^[0-9a-f]{32}$/);
  // alarm 未回调：result 回 pending
  const pr = await getResult({ BOTU_RL: kv.binding }, '?job=' + j.job_id);
  assert.deepEqual(await pr.json(), { state: 'pending' });
  // alarm 回调（慢上游在 handler 内跑完）→ done，quota 恰好一次
  await doMock.alarm(`job-${j.job_id}`);
  const done = await jobRead({ BOTU_RL: kv.binding }, j.job_id);
  assert.equal(done.state, 'done');
  assert.equal(done.counted, true);
  assert.equal(kv.store.get(RLK), '1', 'rl 计数恰好 1');
});

// ── POST：校验 / quota 分支语义不变 ─────────────
test('POST 非法 JSON → 400；非白名单 mime → 400：均不建 job 不打上游', async () => {
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

test('POST quota 超限 → 429 {error, remaining:0}：不建 job 不打上游', async () => {
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

test('POST 无 KV binding → 500 job store unavailable，不打上游（quota 仍 fail-open）', async () => {
  let fetched = 0;
  const res = await post({
    LLM_GATEWAY_URL: GW, LLM_SERVICE_TOKEN: TEST_KEY,
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
  const { kv, env, doMock } = envWith({ kvInitial: { [RLK]: '2' } });
  const res = await post(env);
  const { job_id } = await res.json();
  await doMock.alarm(`job-${job_id}`);
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

test('error 不扣：上游失败 → alarm 写 job error（已脱敏），rl 计数不变', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: dirtyFetch, kvInitial: { [RLK]: '1' } });
  const res = await post(env);
  const { job_id } = await res.json();
  await doMock.alarm(`job-${job_id}`);
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
test('泄漏扫描：脏上游 v5 全链路（POST 响应 + alarm 终态 + job 值 + result 响应）无禁词；result.js/worker 源码无禁词', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: dirtyFetch });
  const bodies = [];
  // 脏失败链路（POST → alarm → error 终态 → result）
  const r1 = await post(env);
  bodies.push(await r1.text());
  const j1 = JSON.parse(bodies[0]);
  await doMock.alarm(`job-${j1.job_id}`);
  const r2 = await getResult({ BOTU_RL: kv.binding }, '?job=' + j1.job_id);
  bodies.push(await r2.text());
  // 成功链路（OSS 签名 URL 存在于 mock 中，不得外泄）
  const ok = envWith({ fetchMock: okFetch });
  const r3 = await post(ok.env);
  bodies.push(await r3.text());
  const j3 = JSON.parse(bodies[2]);
  await ok.doMock.alarm(`job-${j3.job_id}`);
  const r4 = await getResult({ BOTU_RL: ok.kv.binding }, '?job=' + j3.job_id);
  bodies.push(await r4.text());
  // 404/405 分支
  bodies.push(await (await getResult({ BOTU_RL: kv.binding }, '?job=' + 'ab'.repeat(16))).text());
  bodies.push(await (await getResult({ BOTU_RL: kv.binding }, '', 'POST')).text());
  // 全部 KV job 值（两套链路）
  for (const [k, v] of kv.store.entries()) if (k.startsWith('job:')) bodies.push(v);
  for (const [k, v] of ok.kv.store.entries()) if (k.startsWith('job:')) bodies.push(v);
  for (const b of bodies) scanNoLeak(b, '响应/job 值');
  assert.ok(!bodies.some((b) => b.includes('sig=1')), '签名 URL 片段不外泄');
  // result.js / worker 源码自身无禁词（lib/jobcore.js 含 sanitizeError 禁词正则与网关路径常量，属功能必需，另行备注）
  const rsrc = readFileSync(join(ROOT, 'functions/api/result.js'), 'utf8');
  scanNoLeak(rsrc, 'result.js 源码');
  const wsrc = readFileSync(join(ROOT, 'worker/src/index.js'), 'utf8');
  scanNoLeak(wsrc, 'worker 源码');
});

// ── SPEC-435/T-736 v5：DO JobRunner 执行体单测 ──────────────────
test('alarm 幂等 guard：job 已终态(done) → 短路收尾，不打上游不双扣', async () => {
  let fetched = 0;
  const counting = async (url) => { fetched += 1; return okFetch(url); };
  const { kv, env, doMock } = envWith({ fetchMock: counting });
  const res = await post(env);
  const { job_id } = await res.json();
  await doMock.alarm(`job-${job_id}`);
  assert.equal(kv.store.get(RLK), '1', '首次 alarm 成功扣费一次');
  const callsAfterFirst = fetched;
  assert.equal(callsAfterFirst, 2, '上游+下图共 2 次 fetch');
  // 平台 at-least-once 重投：重新塞 meta 后再跑 alarm → guard 短路
  const inst = doMock.inst(`job-${job_id}`);
  await inst.st.storage.put('job', { jobId: job_id, ip: IP });
  await doMock.alarm(`job-${job_id}`);
  assert.equal(fetched, callsAfterFirst, '终态短路：不打上游');
  assert.equal(kv.store.get(RLK), '1', '不双扣');
  const job = await jobRead({ BOTU_RL: kv.binding }, job_id);
  assert.equal(job.state, 'done', '终态不被改写');
});

test('attempts 上限：≥MAX_JOB_ATTEMPTS → error 终态停止重试，不打上游不扣', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: okFetch });
  const res = await post(env);
  const { job_id } = await res.json();
  const inst = doMock.inst(`job-${job_id}`);
  // 模拟前两次 alarm 中途崩溃（未写终态），平台第三次重投
  await inst.st.storage.put('attempts', MAX_JOB_ATTEMPTS - 1);
  let fetched = 0;
  env.__fetch = async (url) => { fetched += 1; return okFetch(url); };
  await doMock.alarm(`job-${job_id}`);
  assert.equal(fetched, 0, 'attempts 到顶：不再生成');
  const job = await jobRead({ BOTU_RL: kv.binding }, job_id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, 'generation failed after retries');
  scanNoLeak(job.error, 'attempts error 文本');
  assert.equal(kv.store.has(RLK), false, '不扣');
  assert.equal(kv.deletes.includes(imgKey(job_id)), true, 'img 清理');
  assert.equal(inst.st.data.size, 0, 'storage 清空');
});

test('5min 硬超时：abort → error 终态 generation timed out，不扣', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: slowFetch(400) });
  env.__JOB_HARD_TIMEOUT_MS = 30; // 单测 ms 级缩放；生产默认 JOB_HARD_TIMEOUT_MS=300000
  const res = await post(env);
  const { job_id } = await res.json();
  await doMock.alarm(`job-${job_id}`);
  const job = await jobRead({ BOTU_RL: kv.binding }, job_id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, TIMEOUT_ERROR);
  scanNoLeak(job.error, 'timeout error 文本');
  assert.equal(kv.store.has(RLK), false, '超时不扣');
  const r = await getResult({ BOTU_RL: kv.binding }, '?job=' + job_id);
  const body = await r.text();
  scanNoLeak(body, 'timeout result 响应');
  assert.equal(JSON.parse(body).state, 'error');
});

test('img 缺失（TTL 过期）：alarm 写 job input expired 终态，不打上游不扣', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: okFetch });
  const res = await post(env);
  const { job_id } = await res.json();
  let fetched = 0;
  env.__fetch = async (url) => { fetched += 1; return okFetch(url); };
  kv.store.delete(imgKey(job_id)); // 模拟 1h TTL 过期
  await doMock.alarm(`job-${job_id}`);
  assert.equal(fetched, 0);
  const job = await jobRead({ BOTU_RL: kv.binding }, job_id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, 'job input expired');
  assert.equal(kv.store.has(RLK), false);
});

test('error 终态同样删 img 载荷（失败链路不残留大图）', async () => {
  const { kv, env, doMock } = envWith({ fetchMock: dirtyFetch });
  const res = await post(env);
  const { job_id } = await res.json();
  assert.equal(kv.store.has(imgKey(job_id)), true);
  await doMock.alarm(`job-${job_id}`);
  assert.equal(kv.store.has(imgKey(job_id)), false, 'error 终态后 img 已删');
  assert.deepEqual(kv.deletes, [imgKey(job_id)]);
});

test('dispatch 失败：binding 缺失 / stub.fetch 抛异常 / 非 2xx → 500，job 留 pending 不扣', async () => {
  // binding 缺失
  const a = envWith();
  delete a.env.JOB_RUNNER;
  const r1 = await post(a.env);
  assert.equal(r1.status, 500);
  assert.equal((await r1.json()).error, 'job dispatch unavailable');
  // stub.fetch 抛异常
  const b = envWith();
  b.env.JOB_RUNNER = { idFromName: (n) => ({ n }), get: () => ({ fetch: async () => { throw new Error('do unreachable'); } }) };
  const r2 = await post(b.env);
  assert.equal(r2.status, 500);
  assert.equal((await r2.json()).error, 'job dispatch unavailable');
  // 非 2xx
  const c = envWith();
  c.env.JOB_RUNNER = { idFromName: (n) => ({ n }), get: () => ({ fetch: async () => new Response('x', { status: 503 }) }) };
  const r3 = await post(c.env);
  assert.equal(r3.status, 500);
  assert.equal((await r3.json()).error, 'job dispatch unavailable');
  // job 记录已落 pending（500 不回滚 KV；TTL 1h 兜底清理），不扣费
  assert.equal(a.kv.store.get(RLK), undefined);
  for (const [k, v] of a.kv.store.entries()) if (k.startsWith('job:')) assert.equal(JSON.parse(v).state, 'pending');
});

test('JobRunner.fetch：非法 job id → 400 不 setAlarm；合法 → 204 + meta + setAlarm 立即', async () => {
  const { env, doMock } = envWith();
  const badName = 'job-' + newJobId();
  const badStub = doMock.binding.get(doMock.binding.idFromName(badName));
  const bad = await badStub.fetch('https://job.internal/run', { headers: { 'x-botu-job': 'not-hex!!' } });
  assert.equal(bad.status, 400);
  assert.equal(doMock.inst(badName).st.alarmAt, null, '非法 id 不 setAlarm');
  const jobId = newJobId();
  const name = `job-${jobId}`;
  const stub = doMock.binding.get(doMock.binding.idFromName(name));
  const good = await stub.fetch('https://job.internal/run', { headers: { 'x-botu-job': jobId, 'x-botu-ip': IP } });
  assert.equal(good.status, 204);
  const inst = doMock.inst(name);
  const meta = inst.st.data.get('job');
  assert.equal(meta.jobId, jobId);
  assert.equal(meta.ip, IP);
  assert.ok(Math.abs(inst.st.alarmAt - Date.now()) < 5000, 'setAlarm 立即');
});

test('meta 缺失：alarm 直接清空 storage 安全返回（不抛不写 KV）', async () => {
  const { kv, env, doMock } = envWith();
  const name = `job-${newJobId()}`;
  doMock.binding.get(doMock.binding.idFromName(name)); // 实例化但不塞 meta
  await doMock.alarm(name);
  assert.equal(doMock.inst(name).st.deleteAllCount, 1);
  assert.equal(kv.puts.length, 0, '无 KV 写');
});

test('worker 健康入口：default.fetch → 200', async () => {
  const mod = await import('../worker/src/index.js');
  const res = await mod.default.fetch(new Request('https://x/'));
  assert.equal(res.status, 200);
  scanNoLeak(await res.text(), 'worker 健康响应');
});
