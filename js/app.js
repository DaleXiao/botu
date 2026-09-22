// app.js — T-730 站点接线：上传 → 压缩 → 预览 → 生成 → 结果/下载
// loading 态：转圈 + 已等待秒数 + 轮换文案，明确提示 ~3-4 分钟
import { DICT, detectLang, applyLang } from './i18n.js?v=431';
import { compressImage, ACCEPT_MIME } from './upload.js?v=431';

const $ = (id) => document.getElementById(id);

const state = {
  lang: 'en',
  dict: DICT.en,
  base64: null,
  mime: null,
  width: 0,
  height: 0,
  kb: 0,
  previewUrl: null,
  busy: false,
  timer: null,
  hintTimer: null,
  startedAt: 0,
  hintIdx: 0,
};

function t(key) {
  return state.dict[key] ?? DICT.en[key] ?? key;
}

function fmt(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

function showError(msg) {
  const box = $('errBox');
  box.textContent = msg;
  box.hidden = false;
}

function clearError() {
  $('errBox').hidden = true;
}

function errText(status, payloadError) {
  if (status === 400) return t('err400');
  if (status === 413) return t('err413');
  if (status === 500) return t('err500');
  if (status === 502) return t('err502');
  return fmt(t('errGeneric'), { msg: payloadError || `HTTP ${status}` });
}

async function handleFile(file) {
  clearError();
  if (!file || state.busy) return;
  if (!ACCEPT_MIME.includes(String(file.type || ''))) {
    showError(t('errType'));
    return;
  }
  let c;
  try {
    c = await compressImage(file);
  } catch (e) {
    showError(e && e.message === 'ERR_TYPE' ? t('errType') : t('errRead'));
    return;
  }
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.base64 = c.base64;
  state.mime = c.mime;
  state.width = c.width;
  state.height = c.height;
  state.kb = Math.max(1, Math.round(c.blob.size / 1024));
  state.previewUrl = c.previewUrl;
  $('srcPreview').src = c.previewUrl;
  $('resultImg').hidden = true;
  $('resultImg').removeAttribute('src');
  $('dlBtn').hidden = true;
  $('regenBtn').hidden = true;
  $('idleHint').hidden = false;
  $('genBtn').disabled = false;
  $('dropZone').hidden = true;
  $('workArea').hidden = false;
  renderDynamic();
}

function resetAll() {
  if (state.busy) return;
  stopTimers();
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.base64 = null;
  state.previewUrl = null;
  $('fileInput').value = '';
  $('workArea').hidden = true;
  $('dropZone').hidden = false;
  clearError();
}

function updateElapsed() {
  const s = Math.floor((Date.now() - state.startedAt) / 1000);
  $('elapsedBox').textContent = fmt(t('elapsedFmt'), { s });
}

function startLoading() {
  state.startedAt = Date.now();
  state.hintIdx = 0;
  $('loadingBox').hidden = false;
  $('idleHint').hidden = true;
  $('loadingMsg').textContent = state.dict.loadingHints[0] || '';
  updateElapsed();
  state.timer = setInterval(updateElapsed, 1000);
  state.hintTimer = setInterval(() => {
    state.hintIdx = (state.hintIdx + 1) % state.dict.loadingHints.length;
    $('loadingMsg').textContent = state.dict.loadingHints[state.hintIdx];
  }, 8000);
}

function stopTimers() {
  if (state.timer) clearInterval(state.timer);
  if (state.hintTimer) clearInterval(state.hintTimer);
  state.timer = null;
  state.hintTimer = null;
  $('loadingBox').hidden = true;
}

async function generate() {
  if (state.busy || !state.base64) return;
  clearError();
  state.busy = true;
  $('genBtn').disabled = true;
  $('regenBtn').disabled = true;
  $('dlBtn').hidden = true;
  startLoading();
  try {
    // 无 early-abort：上游生成 ~210s，不设 signal，让浏览器默认超时兜底
    const res = await fetch('api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_base64: state.base64, mime: state.mime }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      showError(errText(res.status, data && data.error));
      return;
    }
    if (!data || typeof data.image_base64 !== 'string') {
      showError(errText(502, 'empty result'));
      return;
    }
    const url = `data:${data.mime || 'image/png'};base64,${data.image_base64}`;
    const img = $('resultImg');
    img.src = url;
    img.hidden = false;
    const dl = $('dlBtn');
    dl.href = url;
    dl.hidden = false;
    $('regenBtn').hidden = false;
  } catch {
    showError(t('errNetwork'));
  } finally {
    stopTimers();
    state.busy = false;
    $('genBtn').disabled = false;
    $('regenBtn').disabled = false;
  }
}

function renderDynamic() {
  $('fileMeta').textContent = state.base64
    ? fmt(t('fileMetaFmt'), { w: state.width, h: state.height, kb: state.kb })
    : '';
  if (state.busy) {
    updateElapsed();
    $('loadingMsg').textContent = state.dict.loadingHints[state.hintIdx] || '';
  }
}

function setLang(lang) {
  state.lang = lang;
  state.dict = applyLang(lang);
  renderDynamic();
}

function pickImageFromList(list) {
  for (const f of list || []) {
    if (String(f.type || '').startsWith('image/')) return f;
  }
  return null;
}

function wire() {
  const dz = $('dropZone');
  const fi = $('fileInput');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fi.click();
    }
  });
  fi.addEventListener('change', () => handleFile(fi.files && fi.files[0]));
  for (const ev of ['dragenter', 'dragover']) {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('dragover');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
    });
  }
  dz.addEventListener('drop', (e) => handleFile(pickImageFromList(e.dataTransfer && e.dataTransfer.files)));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  window.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (String(it.type || '').startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          handleFile(f);
          return;
        }
      }
    }
  });
  $('genBtn').addEventListener('click', generate);
  $('regenBtn').addEventListener('click', generate);
  $('resetBtn').addEventListener('click', resetAll);
  $('langBtn').addEventListener('click', () => setLang(state.lang === 'zh' ? 'en' : 'zh'));
}

setLang(detectLang());
wire();
