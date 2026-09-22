// functions/api/result.js — SPEC-433/T-733 W2
// GET /api/result?job=<id> → 200 {state:'pending'} / {state:'done',image_base64,mime,remaining}
//                          / {state:'error',error} / 404 未知或过期 job / 500 KV 异常 / 405 非 GET
// 方案 (b)：生成在 generate.js 的 ctx.waitUntil 内完成并把终态写 KV job:<id>；本 handler 纯 KV 读，
// 永不回源上游、永不扣 quota（恰好一次由 runJob 的 counted 标记保证）。
// 泄漏纪律：只输出白名单字段；error 文本写入侧已脱敏，读取侧再脱敏一次（双保险）。

import { jobKey, sanitizeError } from './generate.js';

const JOB_ID_RE = /^[0-9a-f]{32,64}$/i;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') {
    return json({ error: 'method not allowed; GET only' }, 405);
  }
  const id = new URL(request.url).searchParams.get('job') || '';
  if (!JOB_ID_RE.test(id)) return json({ error: 'job not found' }, 404);

  // KV 异常与 job 缺失分开：异常 → 500（前端视为瞬时错误继续轮询）；缺失/损坏 → 404（终态）
  let raw = null;
  if (env && env.BOTU_RL && typeof env.BOTU_RL.get === 'function') {
    try {
      raw = await env.BOTU_RL.get(jobKey(id));
    } catch (e) {
      console.error('result kv read failed:', String(e).slice(0, 200));
      return json({ error: 'job store unavailable' }, 500);
    }
  }
  if (!raw) return json({ error: 'job not found or expired' }, 404);

  let job;
  try {
    job = JSON.parse(raw);
  } catch {
    job = null;
  }
  if (!job || typeof job !== 'object' || typeof job.state !== 'string') {
    return json({ error: 'job not found or expired' }, 404);
  }

  if (job.state === 'done' && typeof job.image_b64 === 'string') {
    const out = { state: 'done', image_base64: job.image_b64, mime: job.mime || 'image/png' };
    if (typeof job.remaining === 'number') out.remaining = job.remaining;
    return json(out);
  }
  if (job.state === 'error') {
    return json({ state: 'error', error: sanitizeError(job.error || 'generation failed') });
  }
  if (job.state === 'pending') return json({ state: 'pending' });
  return json({ error: 'job not found or expired' }, 404);
}
