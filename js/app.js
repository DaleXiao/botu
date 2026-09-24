// app.js — T-730 站点接线：上传 → 压缩 → 预览 → 生成 → 结果/下载
// SPEC-433 W3: 生成改异步 job 流 — POST 拿 job_id 后每 3s 轮询 /api/result，上限 6min
// loading 态：转圈 + 已等待秒数 + 轮换文案；结果框用内联 SVG 占位，done 才渲染 <img>（W3'，任何状态无空 src）
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
  resultUrl: null, // SPEC-441: 当前结果 blob URL（重建/换一张/再生成前 revoke，防泄漏）
  busy: false,
  remaining: null,
  timer: null,
  hintTimer: null,
  startedAt: 0,
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
    ? tt('themeAriaToLight', 'switch to light theme')
    : tt('themeAriaToDark', 'switch to dark theme');
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

// SPEC-433 W3': 图均动态渲染 — 初始 DOM 不放空 src <img>；占位用内联 SVG bot 脸（随主题 currentColor）
function renderBefore(url) {
  const box = $('beforeBox');
  box.textContent = '';
  const img = document.createElement('img');
  img.alt = 'before';
  img.src = url;
  box.appendChild(img);
}

// SPEC-444 F2: resultPh 占位 SVG 模板常量（与 index.html 内联 markup 逐字一致，test/ui-trio.test.mjs pin 住）
// 根因：SVGElement 无 hidden IDL 属性 —— $('resultPh').hidden = true 只产生 expando 属性、不反射 attribute，
// SPEC-442 的 [hidden]{display:none!important} 永不命中 → done 态占位符击穿。改物理 remove/重建，CSS :has(img) 兜底双保险。
const RESULT_PH_SVG = '<svg class="ph" id="resultPh" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9.25" stroke="currentColor" stroke-width="1.2"/><rect x="8" y="9" width="2.5" height="5.5" rx="1.25" fill="currentColor"/><rect x="13.5" y="9" width="2.5" height="5.5" rx="1.25" fill="currentColor"/></svg>';

function clearResult() {
  // SPEC-441: 统一在此 revoke 上一个结果 blob URL — resetBtn/再生成(generate→clearResult)/重建(showResult→clearResult) 三路共用
  if (state.resultUrl) {
    URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = null;
  }
  const box = $('resultBox');
  const old = box.querySelector('img');
  if (old) old.remove();
  // SPEC-444 F2: 占位不存在则用常量重建并 prepend（与 index.html 初始态一致：resultBox 首子节点为 SVG）
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
  // SPEC-444 F2: done 态零占位符 — 物理移除（hidden 赋值对 SVGElement 无效，见 RESULT_PH_SVG 注释）
  const ph = $('resultPh');
  if (ph) ph.remove();
}

// SPEC-433 W3: 3s 轮询 /api/result，预算 6min；网络抖动/5xx 视为瞬时继续轮，404/error/超时给可重试提示
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
      continue; // 瞬时网络抖动：不中断轮询
    }
    if (res.status === 404) {
      showError(t('errJobGone'));
      return;
    }
    if (!res.ok) continue; // 5xx（含 KV 异常）：瞬时，继续轮
    if (data && data.state === 'done' && typeof data.image_base64 === 'string') {
      renderDone(data);
      return;
    }
    if (data && data.state === 'error') {
      showError(t('errJobFailed'));
      return;
    }
    // pending → 继续；进度态（spinner/秒数/轮换文案）由 loadingBox 承担
  }
  showError(t('errTimeout'));
}

// SPEC-441 / T-741: base64 → blob URL — a[download] 对 data: URL 的下载在 Safari/部分浏览器不生效，统一改 blob
// b64ToBytes 为纯函数（不触 DOM/URL），具名导出供 node:test 直测（test/download.test.mjs）
export function b64ToBytes(b64) {
  if (typeof b64 !== 'string') throw new TypeError('b64ToBytes: expected base64 string');
  const bin = atob(b64); // 非法 base64 → DOMException(InvalidCharacterError)
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
  state.resultUrl = url; // showResult→clearResult 已 revoke 旧值，此处登记新 objectURL
  const dl = $('dlBtn');
  dl.href = url;
  dl.hidden = false;
  $('regenBtn').hidden = false;
  if (typeof data.remaining === 'number') {
    state.remaining = Math.max(0, data.remaining); // 服务端权威余额
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
    updateElapsed();
    $('loadingMsg').textContent = state.dict.loadingHints[state.hintIdx] || '';
  }
  renderQuota();
}

// --- quota (SPEC-431 W6): 每 IP 日限 5 次 — GET api/quota 显剩余；0 → 禁用生成 + 引导文案；429 → 状态行报错
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
    // fail-open：quota 行保持隐藏，不阻断生成
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

// SPEC-441: Node(node:test) 导入本模块只取纯函数（b64ToBytes），不执行浏览器接线
if (typeof document !== 'undefined') {
  setLang(detectLang());
  wire();
  fetchQuota();
}
