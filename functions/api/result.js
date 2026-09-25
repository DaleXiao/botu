// functions/api/result.js — SPEC-433/T-733 W2
// GET /api/result?job=<id> → 200 {state:'pending'} / {state:'done',image_base64,mime,remaining}
//                          / {state:'error',error} / 404 unknown or expired job / 500 KV fault / 405 non-GET
// Option (b): generation completes inside generate.js's ctx.waitUntil and writes the terminal state to KV job:<id>; this handler is a pure KV read,
// it never calls back to the upstream and never charges quota (exactly-once is guaranteed by runJob's counted flag).
// Leak discipline: only whitelisted fields are emitted; error text is sanitized on the write side and sanitized once more on the read side (double safety).

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

  // KV faults and missing jobs are distinct: a fault → 500 (the frontend treats it as transient and keeps polling); missing/corrupt → 404 (terminal)
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
