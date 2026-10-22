// E9 — 偏好的跨上下文联动。
//
// 两个问题，都在真扩展 + 真授权下问：
//   1. popup 里换背板，已经打开的那张图是否立刻换（而不是等下次点击）
//   2. 已授权时 popup 还会不会挂着「Needs site access」（[hidden] 被 .row 盖掉那次）
//
// 通道必须是真的：点 popup 的按钮 → chrome.storage → content script 的 onChanged。
// 直接 evaluate 改 storage 会跳过按钮，直接改 DOM 会跳过整个通道。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import zlib from 'node:zlib';
import { clean } from './clean-extensions.mjs';

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const PORT = 8834;
const ROOT = path.resolve(import.meta.dirname, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 造图 ---------- */

let T = null;
function crc32(buf) {
  if (!T) {
    T = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      T[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([len, tag, data, crc]);
}
function png(w, h) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = 80 + (x % 90);
      raw[o + 1] = 120;
      raw[o + 2] = 160;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const IMG = png(600, 450);
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>prefs</title>
<style>body{margin:0;padding:8px;background:#fff}img{display:block;margin:8px 0}</style>
${'<img src="/img.png">'.repeat(4)}`;

const server = http
  .createServer((req, res) => {
    if (req.url.split('?')[0] === '/img.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': IMG.length });
      return res.end(IMG);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  })
  .listen(PORT, '127.0.0.1');

/* ---------- 临时扩展副本 ---------- */

const stage = path.join(os.tmpdir(), 'closer-prefs');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const SKIP = new Set(['.git', '.workbuddy', 'tools', 'docs', 'node_modules']);
fs.cpSync(ROOT, stage, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src);
    if (!rel) return true;
    return !SKIP.has(rel.split(path.sep)[0]);
  },
});
const mf = path.join(stage, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
manifest.host_permissions = ['*://*/*']; // 提权到声明式，popup 一开就是「已授权」
delete manifest.optional_host_permissions;
fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));

async function json(p, init) {
  const res = await fetch(CDP + p, init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const slot = waiting.get(m.id);
    waiting.delete(m.id);
    if (slot) slot(m);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  return { ws, send, ready };
}

const report = [];
const check = (name, ok, detail) => report.push({ name, ok: !!ok, detail });

/* ---------- 装扩展 ---------- */

await clean(CDP);
const ver = await json('/json/version');
const browser = connect(ver.webSocketDebuggerUrl);
await browser.ready;
const loaded = await browser.send('Extensions.loadUnpacked', { path: stage });
const extId = loaded?.result?.id;
browser.ws.close();
if (!extId) {
  console.error('扩展加载失败：', JSON.stringify(loaded));
  process.exit(1);
}
await sleep(900);

const open = async (url) => {
  const tab = await json(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const c = connect(tab.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  c.id = tab.id;
  c.ev = async (expression) => {
    const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description };
    return r?.result?.result?.value;
  };
  return c;
};

const page = await open(`http://127.0.0.1:${PORT}/`);
// 理由同 e7/e8：点击命中的是几何，视口必须先钉住
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
for (let i = 0; i < 40; i++) {
  if ((await page.ev("document.readyState === 'complete' && Array.from(document.images).filter(i => i.naturalWidth > 0).length > 3")) === true) break;
  await sleep(250);
}
await sleep(300);

const popup = await open(`chrome-extension://${extId}/ui/popup.html`);
await sleep(600);

/* ---------- 1. 已授权时 popup 不该挂着「Needs site access」 ---------- */

const permRow = await popup.ev(`(() => {
  const row = document.getElementById('permRow');
  return { hidden: row.hidden, display: getComputedStyle(row).display, status: document.getElementById('statusText').textContent };
})()`);

check(
  '已授权：权限行不可见',
  permRow && permRow.hidden === true && permRow.display === 'none',
  permRow ? `hidden=${permRow.hidden} display=${permRow.display} · ${permRow.status}` : '读不到 permRow'
);

/* ---------- 1b. 超长站点名不许把按钮挤成两行 ---------- */
// popup 被当成标签页打开时，activeHost() 拿到的是 32 位扩展 id，正好是最长的单 token。
// 修之前：站点名的 min-content 撑住 flex 项不肯变窄，按钮被挤到一个字宽，中文逐字折行。
const rowFit = await popup.ev(`(() => {
  const btn = document.getElementById('pause');
  const host = document.getElementById('host');
  const b = btn.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  const r = btn.closest('.row').getBoundingClientRect();
  return {
    btnH: Math.round(b.height),
    btnRight: Math.round(b.right),
    btnLeft: Math.round(b.left),
    hostRight: Math.round(h.right),
    rowRight: Math.round(r.right),
    host: host.textContent,
  };
})()`);

check(
  '长站点名：暂停按钮仍是单行',
  rowFit && rowFit.btnH <= 34, // 单行 ≈ 31px（12px 字号 + 5+5 内边距 + 2 边框），两行会到 ~49
  rowFit ? `高 ${rowFit.btnH}px · ${rowFit.host}` : '读不到 pause 按钮'
);
check(
  '长站点名：按钮不出框、站点名让位',
  rowFit && rowFit.btnRight <= rowFit.rowRight + 1 && rowFit.hostRight <= rowFit.btnLeft,
  rowFit ? `按钮右 ${rowFit.btnRight} / 行右 ${rowFit.rowRight} · 站点名右 ${rowFit.hostRight} / 按钮左 ${rowFit.btnLeft}` : '读不到几何'
);

/* ---------- 2. 打开一张图，默认 dark ---------- */

const spot = await page.ev(`(() => {
  const im = document.querySelector('img');
  im.scrollIntoView({ block: 'center' });
  const r = im.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);

const clickAt = async (x, y) => {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

const backdrop = () =>
  page.ev(`(() => {
    const host = document.getElementById('closer');
    if (!host) return null;
    const bd = host.shadowRoot.querySelector('.backdrop');
    return { cls: host.className, bg: getComputedStyle(bd).backgroundColor };
  })()`);

await page.send('Page.bringToFront');
await clickAt(spot.x, spot.y);
await sleep(600);

const dark = await backdrop();
check('打开后默认 dark', dark?.bg === 'rgb(11, 11, 12)', dark ? `${dark.cls} · ${dark.bg}` : '没有 #closer');

/* ---------- 2b. 窄视口下仍然居中 ---------- */

// .photo 的布局尺寸是原图像素，比视口大时 inset:0+margin:auto 会退化成 left:0，
// 大图偏右下、右侧被裁。这条断言锁住「居中与元素尺寸无关」。
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 500,
  height: 300,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(400);

const narrow = await page.ev(`(() => {
  const host = document.getElementById('closer');
  const im = host.shadowRoot.querySelector('.photo');
  const r = im.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top), vw: innerWidth, vh: innerHeight };
})()`);

check(
  '窄视口(500×300)下居中且不溢出',
  narrow && narrow.x >= 0 && narrow.y >= 0 && narrow.x + narrow.w <= narrow.vw && narrow.y + narrow.h <= narrow.vh,
  narrow ? `${narrow.w}×${narrow.h} @ ${narrow.x},${narrow.y} / ${narrow.vw}×${narrow.vh}` : '读不到 .photo'
);

await page.send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(300);

/* ---------- 3. 在 popup 里点按钮换背板，已打开的 overlay 必须立刻变 ---------- */

// light 是半透明浅黑，不是白：纯白背板在暗环境里刺眼，也把页面整个埋掉
const EXPECT = { light: 'rgba(24, 24, 27, 0.55)', checker: 'rgb(255, 255, 255)', dark: 'rgb(11, 11, 12)' };

for (const want of ['light', 'checker']) {
  // 真的点那个按钮：走 popup.js 的 click → storage.set → content 的 onChanged
  const clicked = await popup.ev(`(() => {
    const b = document.querySelector('#backdrop button[data-v="${want}"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) {
    check(`popup 里点到 ${want}`, false, '找不到按钮');
    continue;
  }

  await page.send('Page.bringToFront');
  let now = null;
  for (let i = 0; i < 20; i++) {
    await sleep(80);
    now = await backdrop();
    if (now?.bg === EXPECT[want]) break;
  }
  check(`已打开的背板立刻变成 ${want}`, now?.bg === EXPECT[want], now ? `${now.cls} · ${now.bg}` : '没有 #closer');
}

/* ---------- 4. 关掉再打开，偏好仍然生效 ---------- */

const esc = async () => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
};

await page.send('Page.bringToFront');
await esc();

// 轮询而不是固定等一下：退场动画 260ms + teardown 兜底 400ms，
// 连跑多个测试时机器一忙，固定 sleep 就会假红（曾经如此）。
const gone = async () => {
  for (let i = 0; i < 30; i++) {
    if ((await page.ev("!document.getElementById('closer')")) === true) return true;
    await sleep(50);
  }
  return false;
};
check('Esc 关闭后 host 已摘除', (await gone()) === true);

await clickAt(spot.x, spot.y);
await sleep(600);
const reopened = await backdrop();
check('重新打开仍是 checker', reopened?.bg === EXPECT.checker, reopened ? `${reopened.cls} · ${reopened.bg}` : '没有 #closer');

await esc();
await sleep(450);

/* ---------- 收尾 ---------- */

page.ws.close();
popup.ws.close();
await json(`/json/close/${page.id}`);
await json(`/json/close/${popup.id}`);
const b2 = connect((await json('/json/version')).webSocketDebuggerUrl);
await b2.ready;
await b2.send('Extensions.uninstall', { id: extId });
b2.ws.close();
server.close();
fs.rmSync(stage, { recursive: true, force: true });

console.log('');
for (const r of report) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
}
const failed = report.filter((r) => !r.ok).length;
console.log(`\n${report.length - failed}/${report.length} 通过`);
process.exit(failed ? 1 : 0);

