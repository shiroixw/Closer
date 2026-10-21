// E6 — 让位检测的真机回归。
//
// E1 验的是「判据对不对」，E5 验的是「扩展能不能活」，这一层验的是
// 「真扩展 + 真 content script 下，我们会不会跟站点抢活」。
//
// 三个受控场景，一个本地页：
//   plain  没有任何处理器     → 我们开
//   sync   点击同步挂查看器   → 我们让位，一个节点都不加
//   late   800ms 后才挂查看器 → 我们先开，1200ms 内自己关掉
//
// 页面用 http://127.0.0.1 提供：扩展的 matches 是 *://*/*，file:// 不在其中。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import zlib from 'node:zlib';
import { clean } from './clean-extensions.mjs';

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const PORT = 8831;
const ROOT = path.resolve(import.meta.dirname, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 造图 ---------- */

let CRC = null;
function crc32(buf) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = 60 + (x % 120);
      raw[o + 1] = 90 + (y % 90);
      raw[o + 2] = 150;
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
const PNG = makePng(900, 700);
const SQUARE = makePng(300, 300); // 二维码 / 头像的典型尺寸

/* ---------- 页面 ---------- */

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>yield lab</title>
<style>
  body { margin: 0; padding: 30px; background: #fafafa; font: 13px system-ui; }
  .case { margin-bottom: 28px; }
  /* 正文图不声明 cursor：真实站点里「可点」通常来自外层 <a> 或容器的事件委托，
     不是给 <img> 自己设 pointer。给了 pointer 就等于声明「这块是交互区域」，
     新判据会直接让我们让位（见下面 card 用例）。 */
  .case img { width: 420px; display: block; }
  /* 声明成可点区域的卡片：新判据要拦住它 */
  .case.clickable img { cursor: pointer; }
  .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.92); z-index: 99999;
    display: grid; place-items: center; }
  .lightbox img { width: 80vw; height: 80vh; object-fit: contain; }
  h3 { font-size: 13px; color: #666; margin: 0 0 6px; }
</style>

<div class="case"><h3>plain — 没有任何处理器</h3><img id="plain" src="/photo.png" alt="plain"></div>
<div class="case"><h3>sync — 点击同步挂查看器</h3><img id="sync" src="/photo.png" alt="sync"></div>
<div class="case"><h3>late — 800ms 后才挂查看器</h3><img id="late" src="/photo.png" alt="late"></div>
<div class="case clickable"><h3>card — 图片被声明成可点区域</h3><img id="card" src="/photo.png" alt="card"></div>
<div class="case"><h3>square — 正方形小图（二维码 / 头像）</h3><img id="square" src="/square.png" alt="square"></div>

<script>
function viewer() {
  const d = document.createElement('div');
  d.className = 'lightbox';
  const im = document.createElement('img');
  im.id = 'big';
  im.src = '/photo.png';
  d.appendChild(im);
  document.body.appendChild(d);
  return d;
}

document.getElementById('sync').addEventListener('click', () => { viewer(); });
document.getElementById('late').addEventListener('click', () => { setTimeout(viewer, 800); });
</script>`;

const server = http
  .createServer((req, res) => {
    const img = req.url.startsWith('/square.png') ? SQUARE : req.url.startsWith('/photo.png') ? PNG : null;
    if (img) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': img.length, 'cache-control': 'no-store' });
      return res.end(img);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  })
  .listen(PORT, '127.0.0.1');

/* ---------- 装扩展 ---------- */

// 固定路径是刻意的：unpacked 扩展的 id 由路径决定，用 mkdtemp 每跑一次
// 就多一个永久残留的扩展实例（曾堆到 8 个，把 e4 的桩测试搞挂了）。
const stage = path.join(os.tmpdir(), 'closer-yield');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const SKIP = new Set(['.git', '.workbuddy', 'tools', 'docs', 'node_modules']);
fs.cpSync(ROOT, stage, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src);
    return !rel || !SKIP.has(rel.split(path.sep)[0]);
  },
});
const mp = path.join(stage, 'manifest.json');
const mf = JSON.parse(fs.readFileSync(mp, 'utf8'));
mf.host_permissions = ['*://*/*'];
delete mf.optional_host_permissions;
fs.writeFileSync(mp, JSON.stringify(mf, null, 2));

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
    const msg = JSON.parse(ev.data);
    const slot = waiting.get(msg.id);
    if (slot) {
      waiting.delete(msg.id);
      slot(msg);
    }
  });
  return {
    ws,
    ready: new Promise((r) => ws.addEventListener('open', r)),
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++seq;
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      }),
  };
}

await clean(CDP);

/** 卸载临时扩展。不卸就会一直堆在 profile 里，污染后续的桩测试。 */
async function uninstall(extensionId) {
  if (!extensionId) return;
  try {
    const v = await json('/json/version');
    const b = connect(v.webSocketDebuggerUrl);
    await b.ready;
    await b.send('Extensions.uninstall', { id: extensionId });
    b.ws.close();
  } catch {
    /* 已经没了就算了 */
  }
}

const version = await json('/json/version');
const browser = connect(version.webSocketDebuggerUrl);
await browser.ready;
const loaded = await browser.send('Extensions.loadUnpacked', { path: stage });
const extId = loaded?.result?.id;
browser.ws.close();

if (!extId) {
  console.error('扩展加载失败', JSON.stringify(loaded));
  process.exit(1);
}
await sleep(900);

/* ---------- 跑场景 ---------- */

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

const pageUrl = `http://127.0.0.1:${PORT}/`;
const tab = await json(`/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' });
const page = connect(tab.webSocketDebuggerUrl);
await page.ready;
await page.send('Runtime.enable');
await page.send('Page.enable');

const ev = async (expr) => {
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.result?.value;
};

async function reload() {
  await page.send('Page.navigate', { url: pageUrl });
  for (let i = 0; i < 40; i++) {
    if ((await ev("document.readyState === 'complete' && !!document.getElementById('plain')")) === true) break;
    await sleep(100);
  }
  await sleep(350);
}

/** 点某个 id 的图，返回它在屏幕上的位置 */
async function clickImage(id) {
  const spot = await ev(`(() => {
    const im = document.getElementById('${id}');
    im.scrollIntoView({ block: 'center' });
    const r = im.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await sleep(120);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
  return spot;
}

const has = () => ev("!!document.getElementById('closer')");
const hasLightbox = () => ev("!!document.querySelector('.lightbox')");

/* --- plain --- */

await reload();
await clickImage('plain');
await sleep(600);
const plainOpen = await has();
check('P1 无处理器的图：我们打开', plainOpen === true);
check('P2 页面没有被我们改动（无 lightbox）', (await hasLightbox()) === false);

// 收尾，避免影响下一个场景
await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(400);

/* --- sync --- */

await reload();
await clickImage('sync');
await sleep(500);
const syncOurs = await has();
const syncTheirs = await hasLightbox();
check('S1 站点自己的查看器开了', syncTheirs === true);
check('S2 我们让位，没有叠加', syncOurs === false);

// 第二次点击：点在站点查看器里的图上。
// 这一刻四项判据全部沉默（页面早就动手完了），只能靠「上一次接管的那一层」兜住。
await clickImage('big');
await sleep(600);
check('S3 查看器里再点一次：仍然不接管（cases 006）', (await has()) === false);

/* --- late --- */

await reload();
await clickImage('late');
await sleep(120); // 此时页面的 800ms 定时器还没到
const lateEarly = await has();
await sleep(1500); // 越过 600/1200 两次迟到检查
const lateAfter = await has();
const lateTheirs = await hasLightbox();

check('L1 页面还没动手时我们先打开', lateEarly === true);
check('L2 站点慢挂查看器后，我们自己关掉', lateAfter === false);
check('L3 站点查看器保留', lateTheirs === true);

// 慢半拍接管也是接管：这时候再点它，同样不该叠加
await clickImage('big');
await sleep(600);
check('L4 慢挂的查看器里再点一次：不接管', (await has()) === false);

/* --- card：图片被声明成可点区域 --- */

await reload();
await clickImage('card');
await sleep(600);
const cardOurs = await has();
check('C1 cursor:pointer 声明的可点区域：不接管', cardOurs === false);
check('C2 也没有给页面留下任何东西', (await hasLightbox()) === false);

/* --- square：正方形小图（二维码 / 头像） --- */

await reload();
await clickImage('square');
await sleep(600);
check('Q1 正方形小图不被接管', (await has()) === false);

/* ---------- 收尾 ---------- */

page.ws.close();
await json(`/json/close/${tab.id}`).catch(() => {});
const tabs = await json('/json/list');
for (const t of tabs || []) {
  if (t.url && t.url.includes(extId)) await json(`/json/close/${t.id}`).catch(() => {});
}
await clean(CDP, { quiet: true });
fs.rmSync(stage, { recursive: true, force: true });
server.close();

const pad = (s) => s + ' '.repeat(Math.max(0, 34 - [...s].length));
console.log(`\n让位检测真机回归 · ${pageUrl}\n扩展 ${extId}（临时副本）\n`);
let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? '✓' : '✗'} ${pad(c.name)} ${c.detail}`);
}
console.log(`\n${checks.length - bad}/${checks.length} 通过`);
process.exit(bad ? 1 : 0);
