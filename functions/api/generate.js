// functions/api/generate.js — T-730/SPEC-430
// POST /api/generate {image_base64, mime} → {image_base64, mime:"image/png"}
// 服务端代理 DashScope qwen-image-3.0-pro img2img；OSS 签名 URL 不出 worker。
// 纯函数（validateInput/buildBody/extractImage/bufToBase64）export 供 node --test；
// env.__fetch 可覆写 fetch 供单测 mock。

export const MODEL = 'qwen-image-3.0-pro';
export const UPSTREAM_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const MIME_ALLOW = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_B64_LEN = 14_000_000; // base64 chars ≈ 10.5 MB binary
export const ICON_PROMPT =
  'Transform the main character of this image into a minimal cute robot-style bot icon. Preserve recognizable features: hairstyle silhouette, signature colors, key accessories. Flat vector illustration, simple rounded shapes, clean solid pastel background, centered composition, app icon aesthetic, no text.';

export function validateInput(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: 'invalid request body' };
  }
  const { image_base64, mime } = body;
  if (typeof image_base64 !== 'string' || image_base64.length === 0) {
    return { ok: false, status: 400, error: 'image_base64 is required (non-empty string)' };
  }
  if (typeof mime !== 'string' || !MIME_ALLOW.includes(mime)) {
    return { ok: false, status: 400, error: `mime must be one of: ${MIME_ALLOW.join(', ')}` };
  }
  if (image_base64.length > MAX_B64_LEN) {
    return { ok: false, status: 413, error: 'image too large (base64 exceeds 14M chars)' };
  }
  return { ok: true, image_base64, mime };
}

export function buildBody(imageBase64, mime) {
  return {
    model: MODEL,
    input: {
      messages: [
        {
          role: 'user',
          content: [
            { image: `data:${mime};base64,${imageBase64}` },
            { text: ICON_PROMPT },
          ],
        },
      ],
    },
    parameters: { size: '1024*1024' },
  };
}

export function extractImage(data) {
  const content = data?.output?.choices?.[0]?.message?.content;
  if (!Array.isArray(content)) return null;
  for (const it of content) {
    if (it && typeof it === 'object' && typeof it.image === 'string' && it.image) return it.image;
  }
  return null;
}

export function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost({ request, env }) {
  const doFetch = env.__fetch || fetch;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const v = validateInput(body);
  if (!v.ok) return json({ error: v.error }, v.status);

  const key = env.DASHSCOPE_API_KEY;
  if (!key) return json({ error: 'server misconfigured: missing DASHSCOPE_API_KEY' }, 500);

  let upstreamRes;
  try {
    upstreamRes = await doFetch(UPSTREAM_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(v.image_base64, v.mime)),
    });
  } catch (e) {
    return json({ error: `upstream fetch failed: ${String(e).slice(0, 200)}` }, 502);
  }

  if (!upstreamRes.ok) {
    const text = (await upstreamRes.text().catch(() => '')).slice(0, 400);
    return json({ error: `upstream ${upstreamRes.status}: ${text}` }, 502);
  }

  let data;
  try {
    data = await upstreamRes.json();
  } catch {
    return json({ error: 'upstream returned non-JSON body' }, 502);
  }

  const imgUrl = extractImage(data);
  if (!imgUrl) {
    return json({ error: `no image in upstream response: ${JSON.stringify(data).slice(0, 400)}` }, 502);
  }

  let imgRes;
  try {
    imgRes = await doFetch(imgUrl);
  } catch (e) {
    return json({ error: `image download failed: ${String(e).slice(0, 200)}` }, 502);
  }
  if (!imgRes.ok) {
    return json({ error: `image download failed with ${imgRes.status}` }, 502);
  }

  const bytes = await imgRes.arrayBuffer();
  return json({ image_base64: bufToBase64(bytes), mime: 'image/png' });
}

export async function onRequestGet() {
  return json({ error: 'method not allowed; POST {image_base64, mime}' }, 405);
}
