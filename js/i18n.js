// i18n.js — zh/en 全量文案字典 + 语言检测/持久化
// 无 DOM 依赖（document/localStorage/navigator 均带 guard），node 可单测

export const DICT = {
  zh: {
    seoTitle: 'botu — 角色图生成极简 Bot Icon · 免费在线机器人图标生成器',
    appTitle: 'botu',
    langBtn: 'EN',
    tagline: '任意角色图 → 极简 bot icon',
    subTagline: 'AI 重绘 · 发型、配色、小配饰都还在 · 约 3-4 分钟',
    dropTitle: '拖进来，或点击上传',
    dropHint: '可直接粘贴 · JPEG / PNG / WebP',
    dropActive: '松开即载入',
    beforeLabel: '原图',
    afterLabel: 'bot icon',
    idleHint: '点击「生成图标」开始',
    generate: '生成图标',
    regenerate: '再生成',
    download: '下载 PNG',
    newImage: '换一张',
    loadingNote: '约需 3-4 分钟，请留在本页',
    elapsedFmt: '已等待 {s} 秒',
    loadingHints: [
      '正在理解角色特征…',
      '发型和配色，一个都不少…',
      '把可爱浓缩成圆角方块…',
      '快好了，最后打磨中…',
    ],
    fileMetaFmt: '{w}×{h} · {kb} KB',
    errRead: '图片读不出来，换一张试试',
    errType: '仅支持 JPEG / PNG / WebP 图片',
    err400: '图片格式或参数有误（400）',
    err413: '图片太大（413），换张小一点的',
    err500: '服务暂不可用（500），请稍后再试',
    err502: '生成失败（502），请稍后重试',
    errNetwork: '网络异常，请检查连接后重试',
    errGeneric: '生成出错：{msg}',
    err429: '今日 {max} 次已用完，请明天再来',
    errTimeout: '生成超时，点「生成图标」重试',
    errJobFailed: '生成失败，点「生成图标」重试',
    errJobGone: '任务过期了，请重新上传',
    themeAriaToLight: '切换到浅色主题',
    themeAriaToDark: '切换到深色主题',
    quotaFmt: '今日剩余 {n}/{max} 次',
    quotaOut: '今日 {max} 次已用完 — 明天再来（UTC）',
    galleryTitle: '效果一览',
    gallerySub: '四组真实输出，未经修饰',
    cap1: '橘猫',
    cap2: '丸子头女孩',
    cap3: '企鹅',
    cap4: '机器人助手',
    footerNote: 'botu · AI 生成 · 免费，无需注册',
    seoFooter:
      'botu 是免费的在线 bot icon 生成器：上传角色图，AI 生成极简机器人风格图标，保留发型轮廓与标志配色，支持 PNG 下载。适合聊天机器人头像、Discord/Telegram bot 图标与品牌吉祥物。免费、无需注册。',
  },
  en: {
    seoTitle: 'botu — Bot Icon Generator · Character Image to Minimal Robot Icon, Free Online',
    appTitle: 'botu',
    langBtn: '中文',
    tagline: 'Any character image → minimal bot icon',
    subTagline: 'Redrawn by AI · hair, colors & little details all kept · ~3-4 min',
    dropTitle: 'Drop it here, or click to browse',
    dropHint: 'Paste works too · JPEG / PNG / WebP',
    dropActive: 'release to load',
    beforeLabel: 'before',
    afterLabel: 'bot icon',
    idleHint: 'click "generate icon" to start',
    generate: 'generate icon',
    regenerate: 'regenerate',
    download: 'download PNG',
    newImage: 'new image',
    loadingNote: 'takes ~3-4 min — please keep this tab open',
    elapsedFmt: 'elapsed {s}s',
    loadingHints: [
      'getting to know your character…',
      'keeping every curl & color…',
      'condensing the cuteness into rounded shapes…',
      'almost there, final polish…',
    ],
    fileMetaFmt: '{w}×{h} · {kb} KB',
    errRead: 'couldn\'t read that image — try another one',
    errType: 'only JPEG / PNG / WebP images are supported',
    err400: 'unsupported format or invalid input (400)',
    err413: 'image too large (413) — try a smaller one',
    err500: 'service unavailable (500) — please retry later',
    err502: 'generation failed (502) — please retry later',
    errNetwork: 'network hiccup — check your connection and retry',
    errGeneric: 'generation error: {msg}',
    err429: 'all {max} daily generations used — back tomorrow',
    errTimeout: 'generation timed out — hit "generate icon" to retry',
    errJobFailed: 'generation failed — hit "generate icon" to retry',
    errJobGone: 'job expired — please upload again',
    themeAriaToLight: 'switch to light theme',
    themeAriaToDark: 'switch to dark theme',
    quotaFmt: '{n}/{max} remaining today',
    quotaOut: 'all {max} used today — back tomorrow (UTC)',
    galleryTitle: 'see it in action',
    gallerySub: 'four real outputs, untouched',
    cap1: 'Orange tabby',
    cap2: 'Girl with bun',
    cap3: 'Penguin',
    cap4: 'Robot assistant',
    footerNote: 'botu · AI-generated · free, no signup',
    seoFooter:
      'botu is a free online bot icon generator: upload a character image and AI redraws it as a minimal robot icon, keeping the hairstyle silhouette, signature colors and key accessories. PNG download. Great for chatbot avatars, Discord/Telegram bot icons and brand mascots. Free, no signup.',
  },
};

export function detectLang() {
  try {
    const saved = localStorage.getItem('botu-lang');
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {}
  try {
    if ((navigator.language || '').toLowerCase().startsWith('zh')) return 'zh';
  } catch {}
  return 'en';
}

export function applyLang(lang) {
  const d = DICT[lang] || DICT.en;
  try {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.documentElement.dataset.lang = lang;
  } catch {}
  try {
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const v = d[el.dataset.i18n];
      if (typeof v === 'string') el.textContent = v;
    }
  } catch {}
  try {
    document.title = d.seoTitle;
  } catch {}
  try {
    localStorage.setItem('botu-lang', lang);
  } catch {}
  return d;
}
