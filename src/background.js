'use strict';

// Closer 的 service worker。只做三件事：
//   1. 维护动态注册的 content script（host 权限可选，所以不能写在 manifest 里）
//   2. 取字节。只有扩展上下文能绕过页面的 CORS，这是文件大小和复制能成立的前提
//   3. 首次安装时打开 welcome

const SCRIPT_ID = 'closer-content';
const LEGACY_BRIDGE_ID = 'closer-page-bridge';

// 加载顺序即执行顺序，不能调换：core 建命名空间，boot 最后接线。
const FILES = [
  'src/content/core.js',
  'src/content/detect.js',
  'src/content/yield.js',
  'src/content/meta.js',
  'src/content/bytes.js',
  'src/content/gallery.js',
  'src/content/overlay.js',
  'src/content/actions.js',
  'src/content/hint.js',
  'src/content/boot.js',
];

const ALL_ORIGINS = { origins: ['*://*/*'] };

const MAX_BYTES = 64 * 1024 * 1024;

async function granted() {
  try {
    return await chrome.permissions.contains(ALL_ORIGINS);
  } catch {
    return false;
  }
}

async function registered() {
  try {
    const list = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    return list.length > 0;
  } catch {
    return false;
  }
}

async function sync() {
  const has = await granted();

  try {
    await chrome.scripting
      .unregisterContentScripts({ ids: [SCRIPT_ID, LEGACY_BRIDGE_ID] })
      .catch(() => {});
  } catch {
    /* ignore */
  }

  if (!has) return;

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        matches: ['*://*/*'],
        js: FILES,
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  } catch (e) {
    console.warn('[closer] register failed', e);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await sync();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/welcome.html') });
  }
});

chrome.runtime.onStartup.addListener(sync);
chrome.permissions.onAdded.addListener(sync);
chrome.permissions.onRemoved.addListener(sync);

/* ---------- 字节通道 ---------- */

function toBase64(bytes) {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

async function readBytes(url, want) {
  let res;
  try {
    res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  } catch {
    return { ok: false, error: 'network' };
  }

  if (!res.ok) return { ok: false, error: 'status', status: res.status };

  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  const declared = Number(res.headers.get('content-length') || 0);

  if (want === 'meta') {
    if (declared > 0) return { ok: true, size: declared, mime };

    if (!res.body) return { ok: true, size: 0, mime };

    const reader = res.body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
    }
    return { ok: true, size, mime };
  }

  if (declared > MAX_BYTES) return { ok: true, size: declared, mime, tooBig: true };

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) {
    return { ok: true, size: bytes.byteLength, mime, tooBig: true };
  }
  return { ok: true, size: bytes.byteLength, mime, base64: toBase64(bytes) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'closer:bytes') {
    readBytes(msg.url, msg.want === 'full' ? 'full' : 'meta')
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'closer:status') {
    Promise.all([granted(), registered()]).then(([has, hasScript]) =>
      sendResponse({ granted: has, registered: hasScript })
    );
    return true;
  }

  if (msg.type === 'closer:sync') {
    sync().then(() => sendResponse({ ok: true }));
    return true;
  }
});

sync();
