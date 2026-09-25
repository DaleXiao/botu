// functions/api/generate.js — T-730/SPEC-430 · SPEC-433/T-733 v4 · SPEC-435/T-736 v5
// POST /api/generate {image_base64, mime} → 200 {job_id}: validation/quota semantics identical to v3/v4, returns immediately.
// v5: the generation executor moved into the companion worker's DO alarm handler (worker/src/index.js JobRunner) —
// CF waitUntil force-cancels unsettled promises 30s after the invocation ends (official runtime-apis/context docs),
// while DashScope synchronous image generation takes 2-4min → v4 jobs stayed pending forever (proven in production: job 4940b924…, 22.5min / 66 poll rounds).
// Trigger chain: job:<id> pending → img:<id> KV (TTL 1h) → stub.fetch (x-botu-job/x-botu-ip) → setAlarm immediately.
// Core logic lives in lib/jobcore.js (this file re-exports it: existing imports in result.js/tests stay unchanged).
// Gateway directive (Dale 2026-09-22 19:42): image generation goes through the api-llm gateway; the Pages side only validates the LLM_GATEWAY_URL var,
// LLM_SERVICE_TOKEN exists only as a companion-worker secret (generation never happens inside a Pages invocation).
// Server-side proxy for qwen-image-3.0-pro img2img; OSS signed URLs / tokens never leave the worker.

export * from '../../lib/jobcore.js';

import {
  DAILY_LIMIT, clientIp, rlReadCount, jobWrite, imgWrite, newJobId, validateInput,
} from '../../lib/jobcore.js';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const v = validateInput(body);
  if (!v.ok) return json({ error: v.error }, v.status);

  // SPEC-431 W6: 5 per IP per day — over the limit → 429; charging happens only after a successful generation (runJob inside the DO alarm)
  const ip = clientIp(request);
  const rlCount = await rlReadCount(env, ip);
  if (rlCount >= DAILY_LIMIT) {
    return json({ error: `daily limit exceeded (${DAILY_LIMIT} per IP per day)`, remaining: 0 }, 429);
  }

  // Gateway directive (Dale 2026-09-22 19:42): all image generation goes through the api-llm gateway; here we only verify the URL var exists
  if (!env.LLM_GATEWAY_URL) return json({ error: 'server misconfigured: missing LLM_GATEWAY_URL' }, 500);

  // SPEC-435 v5: create the job and return immediately — generation runs inside the companion worker's DO alarm handler,
  // eliminating the waitUntil 30s platform cancellation at the root (spec §Background 3). Image payloads go through KV img:<id> (TTL 1h);
  // trigger chain: stub.fetch → handler stores meta + setAlarm (immediate). KV/stub failure → 500 (existing branch semantics preserved).
  const jobId = newJobId();
  const stored = await jobWrite(env, jobId, { state: 'pending', ip, created: Date.now() });
  if (!stored) return json({ error: 'job store unavailable' }, 500);
  const imgStored = await imgWrite(env, jobId, { image_base64: v.image_base64, mime: v.mime });
  if (!imgStored) return json({ error: 'job store unavailable' }, 500);

  try {
    const ns = env.JOB_RUNNER;
    if (!ns || typeof ns.idFromName !== 'function' || typeof ns.get !== 'function') {
      return json({ error: 'job dispatch unavailable' }, 500);
    }
    const stub = ns.get(ns.idFromName(`job-${jobId}`));
    const res = await stub.fetch('https://job.internal/run', {
      method: 'POST',
      headers: { 'x-botu-job': jobId, 'x-botu-ip': ip },
    });
    if (!res || !res.ok) return json({ error: 'job dispatch unavailable' }, 500);
  } catch (e) {
    console.error('job dispatch failed:', String(e).slice(0, 200));
    return json({ error: 'job dispatch unavailable' }, 500);
  }
  return json({ job_id: jobId });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestGet() {
  return json({ error: 'method not allowed; POST {image_base64, mime}' }, 405);
}
