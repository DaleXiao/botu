// functions/api/quota.js — SPEC-431 W6
// GET /api/quota → {"remaining":N} (same key rule as generate: rl:<ip>:<UTC yyyymmdd>)
// Other methods → 405 JSON. A missing KV binding or read faults fail open → remaining=DAILY_LIMIT.

import { clientIp, rlReadCount, DAILY_LIMIT } from './generate.js';

export function remainingOf(count) {
  return Math.max(0, DAILY_LIMIT - count);
}

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
  const count = await rlReadCount(env, clientIp(request));
  return json({ remaining: remainingOf(count) });
}
