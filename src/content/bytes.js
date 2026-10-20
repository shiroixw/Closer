'use strict';

var Closer = (window.Closer ||= {});

// 取字节。三方共用（面板要大小、复制要内容、保存要内容），所以只在这里发请求。
// 只缓存最近一条：用户一次只可能看一张图，做 LRU 是给自己找 bug。

const TIMEOUT = 8000;
const MAX_BYTES = 64 * 1024 * 1024;

let lastUrl = '';
let lastMeta = null; // Promise<{ size, mime } | null>

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// blob: / data: 在页面里同源可读，不必绕 service worker，省一次消息往返。
function localSize(url) {
  const m = /^data:[^;,]*;base64,/.exec(url);
  if (!m) return 0;
  const payload = url.slice(m[0].length);
  const pad = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - pad;
}

async function fetchLocal(url, want) {
  const res = await fetch(url);
  if (!res.ok) return null;

  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  const buf = new Uint8Array(await res.arrayBuffer());

  if (buf.byteLength > MAX_BYTES) return { size: buf.byteLength, mime, tooBig: true };
  if (want === 'full') return { buf, mime, size: buf.byteLength };
  return { size: buf.byteLength, mime };
}

function ask(url, want) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    // 超时即缺失（技术方案 5.4）：宁可少一行数字，不让面板永远转圈。
    const timer = setTimeout(() => done(null), TIMEOUT);

    try {
      chrome.runtime.sendMessage({ type: 'closer:bytes', url, want }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) return done(null);
        if (want === 'full') {
          if (res.tooBig) return done({ size: res.size, mime: res.mime, tooBig: true });
          return done({ buf: base64ToBytes(res.base64), mime: res.mime, size: res.size });
        }
        done({ size: res.size || 0, mime: res.mime || '' });
      });
    } catch {
      done(null); // 扩展上下文失效（更新/重载）
    }
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * want='meta' → { size, mime } | null
 * want='full' → { buf, mime, size, tooBig? } | null
 * 失败就是 null，不抛错：调用方据此「整行不显示」或「报 Copy failed」。
 */
Closer.bytes = async function (url, want = 'meta') {
  if (!url) return null;

  const isLocal = url.startsWith('blob:') || url.startsWith('data:');

  if (isLocal) {
    if (want === 'meta' && url.startsWith('data:')) {
      const size = localSize(url);
      if (size) return { size, mime: '' };
    }
    try {
      return await fetchLocal(url, want);
    } catch {
      return null;
    }
  }

  if (want === 'meta') {
    if (url === lastUrl && lastMeta) return lastMeta;
    lastUrl = url;
    lastMeta = ask(url, 'meta');
    return lastMeta;
  }

  return ask(url, 'full');
};

// 页面性能条目优先：命中缓存时它比一次网络探测快一个数量级，且免费。
// 拿不到（跨域无 Timing-Allow-Origin 时 encodedBodySize 会被清零）再走 SW。
Closer.bytesFromTiming = function (url) {
  try {
    const entries = performance.getEntriesByName(url, 'resource');
    const e = entries[entries.length - 1];
    const n = e?.encodedBodySize || e?.transferSize;
    if (n > 0) return { size: n, mime: '' };
  } catch {
    /* 忽略 */
  }
  return null;
};
