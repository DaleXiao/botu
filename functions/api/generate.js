// functions/api/generate.js — T-730/SPEC-430 · SPEC-433/T-733 v4 · SPEC-435/T-736 v5
// POST /api/generate {image_base64, mime} → 200 {job_id}：校验/quota 语义与 v3/v4 一致，立即返回。
// v5：生成执行体迁入 companion worker DO alarm handler（worker/src/index.js JobRunner）——
// CF waitUntil 在 invocation 结束 30s 后强制取消未 settle Promise（官方 runtime-apis/context 文档），
// DashScope 同步出图 2-4min → v4 job 永远 pending（线上 4940b924… 22.5min/66 轮实证）。
// 触发链：job:<id> pending → img:<id> KV（TTL 1h）→ stub.fetch（x-botu-job/x-botu-ip）→ setAlarm 立即。
// 核心逻辑在 lib/jobcore.js（本文件 re-export：result.js/tests 既有 import 不变）。
// Gateway 指令（Dale 2026-09-22 19:42）：出图走 api-llm gateway；Pages 侧只校验 LLM_GATEWAY_URL var，
// LLM_SERVICE_TOKEN 只在 companion worker secret（生成不发生在 Pages invocation 内）。
// 服务端代理 qwen-image-3.0-pro img2img；OSS 签名 URL / token 不出 worker。

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

  // SPEC-431 W6: 每 IP 日限 5 次 — 超限 429；扣费只在生成成功后（DO alarm 内 runJob）
  const ip = clientIp(request);
  const rlCount = await rlReadCount(env, ip);
  if (rlCount >= DAILY_LIMIT) {
    return json({ error: `daily limit exceeded (${DAILY_LIMIT} per IP per day)`, remaining: 0 }, 429);
  }

  // Gateway 指令（Dale 2026-09-22 19:42）：出图统一走 api-llm gateway；此处只验 URL var 存在
  if (!env.LLM_GATEWAY_URL) return json({ error: 'server misconfigured: missing LLM_GATEWAY_URL' }, 500);

  // SPEC-435 v5: 建 job 立即返回 — 生成在 companion worker DO alarm handler 内执行，
  // 根治 waitUntil 30s 平台取消（spec §背景 3）。图片载荷走 KV img:<id>（TTL 1h）；
  // 触发链 stub.fetch → handler 存 meta + setAlarm（立即）。KV/stub 失败 → 500（沿用既有分支语义）。
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
