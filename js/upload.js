// upload.js — image compression: canvas longest side ≤1536, JPEG q0.85 → base64
// Browser-only (document/canvas); the pure logic is parameterized (maxSide/quality) for testability

export const MAX_SIDE = 1536;
export const JPEG_QUALITY = 0.85;
export const ACCEPT_MIME = ['image/jpeg', 'image/png', 'image/webp'];

async function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {}
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('ERR_READ'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const i = s.indexOf(',');
      res(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.onerror = () => rej(new Error('ERR_READ'));
    fr.readAsDataURL(blob);
  });
}

export function scaledSize(width, height, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    w: Math.max(1, Math.round(width * scale)),
    h: Math.max(1, Math.round(height * scale)),
  };
}

export async function compressImage(file, { maxSide = MAX_SIDE, quality = JPEG_QUALITY } = {}) {
  if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) {
    throw new Error('ERR_TYPE');
  }
  const bitmap = await loadImage(file);
  const { w, h } = scaledSize(bitmap.width, bitmap.height, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (typeof bitmap.close === 'function') bitmap.close();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error('ERR_READ');
  const base64 = await blobToBase64(blob);
  return {
    blob,
    base64,
    mime: 'image/jpeg',
    width: w,
    height: h,
    previewUrl: URL.createObjectURL(blob),
  };
}
