// app.js — T-730 site wiring: upload → compress → preview → generate → result/download
// SPEC-433 W3: generation moved to an async job flow — POST returns a job_id, then /api/result is polled every 3s, capped at 6min
// Loading state: spinner + seconds waited + rotating hints; the result box uses an inline SVG placeholder and renders the <img> only when done (W3', no empty src in any state)
import { DICT, detectLang, applyLang } from './i18n.js?v=438';
import { compressImage, ACCEPT_MIME } from './upload.js?v=433';

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
  resultUrl: null, // SPEC-441: current result blob URL (revoked before rebuild / new image / regenerate, to prevent leaks)
  busy: false,
  remaining: null,
  hintTimer: null,
  hintIdx: 0,
};

function t(key) {
  return state.dict[key] ?? DICT.en[key] ?? key;
}

function tt(key, fb) {
  const v = t(key);
  return v === key ? fb : v;
}

// --- theme (SPEC-431 W4): localStorage botu-theme · default dark · fallback prefers-color-scheme (pre-applied inline in <head>)
function currentTheme() {
  const a = document.documentElement.getAttribute('data-theme');
  return a === 'light' ? 'light' : 'dark';
}

// SPEC-436: target-state icons (icon forge semantics) — dark shows sun (click to go light), light shows moon (click to go dark)
const SUN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle"><path d="M12 3v1.5M12 19.5V21M4.219 4.219l1.061 1.061M17.72 17.72l1.06 1.06M3 12h1.5M19.5 12H21M4.219 19.781l1.061-1.061M17.72 6.28l1.06-1.06"/><circle cx="12" cy="12" r="4.5"/></svg>';
const MOON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle"><path d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"/></svg>';

function renderThemeBtn() {
  const b = $('themeBtn');
  if (!b) return;
  const dark = currentTheme() === 'dark';
  b.innerHTML = dark ? SUN_SVG : MOON_SVG;
  const aria = dark
    ? tt('themeAriaToLight', 'Switch to light theme')
    : tt('themeAriaToDark', 'Switch to dark theme');
  b.setAttribute('aria-label', aria);
  b.title = aria;
}

function applyTheme(th) {
  document.documentElement.setAttribute('data-theme', th);
  try {
    localStorage.setItem('botu-theme', th);
  } catch {}
  renderThemeBtn();
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
  if (status === 429) return fmt(t('err429'), { max: QUOTA_MAX });
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
  renderBefore(c.previewUrl);
  clearResult();
  $('dlBtn').hidden = true;
  $('regenBtn').hidden = true;
  $('idleHint').hidden = false;
  $('genBtn').disabled = state.remaining === 0;
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
  clearResult();
}

function startLoading() {
  state.hintIdx = 0;
  $('loadingBox').hidden = false;
  $('idleHint').hidden = true;
  $('loadingMsg').textContent = state.dict.loadingHints[0] || '';
  state.hintTimer = setInterval(() => {
    state.hintIdx = (state.hintIdx + 1) % state.dict.loadingHints.length;
    $('loadingMsg').textContent = state.dict.loadingHints[state.hintIdx];
  }, 8000);
}

function stopTimers() {
  if (state.hintTimer) clearInterval(state.hintTimer);
  state.hintTimer = null;
  $('loadingBox').hidden = true;
}

// SPEC-433 W3': both images render dynamically — no empty-src <img> in the initial DOM; the placeholder is an inline SVG bot face (currentColor follows the theme)
function renderBefore(url) {
  const box = $('beforeBox');
  box.textContent = '';
  const img = document.createElement('img');
  img.alt = 'before';
  img.src = url;
  box.appendChild(img);
}

// SPEC-444 F2: resultPh placeholder SVG template constant (byte-identical to the inline markup in index.html; pinned by test/ui-trio.test.mjs)
// Root cause: SVGElement has no hidden IDL property — assigning $('resultPh').hidden = true only creates an expando property and never reflects to the attribute,
// so SPEC-442's [hidden]{display:none!important} never matches → the placeholder leaked through in the done state. Fix: physical remove/rebuild, with the CSS :has(img) fallback as a second layer.
const RESULT_PH_SVG = '<svg class="ph" id="resultPh" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9.25" stroke="currentColor" stroke-width="1.2"/><rect x="8" y="9" width="2.5" height="5.5" rx="1.25" fill="currentColor"/><rect x="13.5" y="9" width="2.5" height="5.5" rx="1.25" fill="currentColor"/></svg>';

function clearResult() {
  // SPEC-441: single place that revokes the previous result blob URL — shared by all three paths: resetBtn / regenerate (generate→clearResult) / rebuild (showResult→clearResult)
  if (state.resultUrl) {
    URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = null;
  }
  const box = $('resultBox');
  const old = box.querySelector('img');
  if (old) old.remove();
  // SPEC-444 F2: if the placeholder is missing, rebuild it from the constant and prepend (matches the initial state in index.html: resultBox's first child is the SVG)
  if (!$('resultPh')) box.insertAdjacentHTML('afterbegin', RESULT_PH_SVG);
  $('resultPh').hidden = false;
}

function showResult(url) {
  clearResult();
  const img = document.createElement('img');
  img.id = 'resultImg';
  img.alt = 'after';
  img.src = url;
  $('resultBox').appendChild(img);
  // SPEC-444 F2: zero placeholders in the done state — physically remove it (assigning hidden has no effect on SVGElement; see the RESULT_PH_SVG comment)
  const ph = $('resultPh');
  if (ph) ph.remove();
}

// SPEC-433 W3: poll /api/result every 3s with a 6min budget; network hiccups/5xx count as transient and polling continues; 404/error/timeout surface a retryable message
const POLL_MS = 3000;
const POLL_BUDGET_MS = 6 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollResult(jobId) {
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let res = null;
    let data = null;
    try {
      res = await fetch('api/result?job=' + encodeURIComponent(jobId));
      try {
        data = await res.json();
      } catch {}
    } catch {
      continue; // transient network hiccup: do not interrupt polling
    }
    if (res.status === 404) {
      showError(t('errJobGone'));
      return;
    }
    if (!res.ok) continue; // 5xx (including KV faults): transient, keep polling
    if (data && data.state === 'done' && typeof data.image_base64 === 'string') {
      renderDone(data);
      return;
    }
    if (data && data.state === 'error') {
      showError(t('errJobFailed'));
      return;
    }
    // pending → keep going; the progress UI (spinner / seconds / rotating hints) is owned by loadingBox
  }
  showError(t('errTimeout'));
}

// SPEC-441 / T-741: base64 → blob URL — a[download] on data: URLs does not work in Safari/some browsers, so everything uses blobs
// b64ToBytes is a pure function (touches no DOM/URL), exported by name for direct node:test coverage (test/download.test.mjs)
export function b64ToBytes(b64) {
  if (typeof b64 !== 'string') throw new TypeError('b64ToBytes: expected base64 string');
  const bin = atob(b64); // invalid base64 → DOMException(InvalidCharacterError)
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64ToBlobUrl(b64, mime) {
  const blob = new Blob([b64ToBytes(b64)], { type: mime || 'image/png' });
  return URL.createObjectURL(blob);
}

function renderDone(data) {
  const url = b64ToBlobUrl(data.image_base64, data.mime || 'image/png');
  showResult(url);
  state.resultUrl = url; // showResult→clearResult already revoked the old value; register the new objectURL here
  const dl = $('dlBtn');
  dl.href = url;
  dl.hidden = false;
  $('regenBtn').hidden = false;
  if (typeof data.remaining === 'number') {
    state.remaining = Math.max(0, data.remaining); // server-authoritative remaining count
  } else if (state.remaining !== null) {
    state.remaining = Math.max(0, state.remaining - 1);
  }
  renderQuota();
}

async function generate() {
  if (state.busy || !state.base64) return;
  if (state.remaining === 0) {
    showError(fmt(t('quotaOut'), { max: QUOTA_MAX }));
    return;
  }
  clearError();
  state.busy = true;
  $('genBtn').disabled = true;
  $('regenBtn').disabled = true;
  $('dlBtn').hidden = true;
  clearResult(); // 等待期结果框显 SVG 占位，不出现空 src 破图
  startLoading();
  try {
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
      if (res.status === 429) {
        state.remaining = 0;
        renderQuota();
      }
      showError(errText(res.status, data && data.error));
      return;
    }
    if (!data || typeof data.job_id !== 'string') {
      showError(errText(502, 'empty result'));
      return;
    }
    await pollResult(data.job_id);
  } catch {
    showError(t('errNetwork'));
  } finally {
    stopTimers();
    state.busy = false;
    const out = state.remaining === 0;
    $('genBtn').disabled = out;
    $('regenBtn').disabled = out;
  }
}

function renderDynamic() {
  $('fileMeta').textContent = state.base64
    ? fmt(t('fileMetaFmt'), { w: state.width, h: state.height, kb: state.kb })
    : '';
  if (state.busy) {
    $('loadingMsg').textContent = state.dict.loadingHints[state.hintIdx] || '';
  }
  renderQuota();
}

// --- quota (SPEC-431 W6): 5 per IP per day — GET api/quota shows the remainder; 0 → generation disabled + guidance copy; 429 → error in the status line
const QUOTA_MAX = 5;

function renderQuota() {
  const el = $('quotaLine');
  if (!el) return;
  if (state.remaining === null) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (state.remaining > 0) {
    el.classList.remove('out');
    el.textContent = fmt(t('quotaFmt'), { n: state.remaining, max: QUOTA_MAX });
  } else {
    el.classList.add('out');
    el.textContent = fmt(t('quotaOut'), { max: QUOTA_MAX });
  }
}

async function fetchQuota() {
  try {
    const res = await fetch('api/quota');
    if (!res.ok) return;
    const data = await res.json();
    if (data && typeof data.remaining === 'number') {
      state.remaining = Math.max(0, data.remaining);
      renderQuota();
      if (state.remaining === 0) $('genBtn').disabled = true;
    }
  } catch {
    // fail-open: keep the quota line hidden, never block generation
  }
}

function setLang(lang) {
  state.lang = lang;
  state.dict = applyLang(lang);
  renderDynamic();
  renderThemeBtn();
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
  $('themeBtn').addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
}

// SPEC-441: when Node (node:test) imports this module it only uses the pure function (b64ToBytes); the browser wiring does not run
if (typeof document !== 'undefined') {
  setLang(detectLang());
  wire();
  fetchQuota();
}
