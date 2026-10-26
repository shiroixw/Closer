// E2 — 图片自己动的时候，elementFromPoint 稳不稳
//
// 让位检测在 click 时取一次 hit 基线，下一帧再取一次比对。如果图正在动，
// 第二次取到的可能已经不是它了 → 误判成「页面动过」→ 我们让位 → 漏开。
//
// 这里用四种动效各采样 60 帧，统计「两次取值不是同一个元素」的比例。
// 比例就是漏开率。

import http from 'node:http';
import { execFile } from 'node:child_process';

const PORT = 8821;
import { CDP } from './browser.mjs'; // 默认 headless，不抢焦点；CDP=… 可覆盖

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>E2 hit drift</title>
<style>
  body { margin: 0; padding: 24px; background: #111; font: 13px/1.5 ui-monospace, monospace; color: #ddd; }
  .row { display: flex; gap: 16px; margin-bottom: 18px; }
  .cell { width: 200px; height: 150px; background: #1c1c1c; overflow: hidden; position: relative; flex: none; }
  .cell img { width: 180px; height: 120px; display: block; object-fit: cover; }
  .label { width: 200px; font-size: 12px; color: #888; flex: none; }
  #out { white-space: pre; margin-top: 12px; color: #7fd; }
  .bad { color: #f77; }

  /* d1 轮播：整体平移 400px，1.2s 循环 */
  @keyframes slide { from { transform: translateX(0); } to { transform: translateX(400px); } }
  #d1 img { animation: slide 1.2s linear infinite alternate; }

  /* d2 单边放大：只在 1.0→1.06 之间往复 */
  @keyframes pop { 0% { transform: scale(1); } 100% { transform: scale(1.06); } }
  #d2 img { animation: pop 0.4s ease-in-out infinite alternate; }

  /* d3 呼吸：无限缩放 */
  @keyframes breathe { 0%,100% { transform: scale(.96); } 50% { transform: scale(1.06); } }
  #d3 img { animation: breathe 2s ease-in-out infinite; }

  /* d4 静止对照 */
</style>
<div class="row"><div class="label">d1 轮播（平移 400px）</div><div class="label">d2 hover 放大</div><div class="label">d3 呼吸</div><div class="label">d4 静止</div></div>
<div class="row">
  <div class="cell" id="d1"><img src="photo.png" alt="d1"></div>
  <div class="cell" id="d2"><img src="photo.png" alt="d2"></div>
  <div class="cell" id="d3"><img src="photo.png" alt="d3"></div>
  <div class="cell" id="d4"><img src="photo.png" alt="d4"></div>
</div>
<div id="out">跑着呢…</div>
<script>
const raf = () => new Promise((r) => requestAnimationFrame(r));

// 逐帧采样：先取一次 hit，等一帧，再取一次
// inset = 采样点距图片左边缘的像素数，0 表示取中心
async function drift(img, frames, inset) {
  let miss = 0;
  let moved = 0;
  const steps = [];
  for (let i = 0; i < frames; i++) {
    const r = img.getBoundingClientRect();
    const x = Math.round(inset ? r.left + inset : r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const a = document.elementFromPoint(x, y);
    await raf();
    const b = document.elementFromPoint(x, y);
    if (a !== b) miss++;
    const r2 = img.getBoundingClientRect();
    steps.push(Math.round((r2.left - r.left) * 100) / 100);
    if (r2.left !== r.left || r2.top !== r.top) moved++;
  }
  const span = steps.length ? Math.max(...steps) - Math.min(...steps) : 0;
  return { miss, moved, frames, span };
}

async function run() {
  const frames = 60;
  const cases = ['d1', 'd2', 'd3', 'd4'];
  const out = {};

  for (const id of cases) {
    const img = document.querySelector('#' + id + ' img');
    out[id] = await drift(img, frames, 0);
    // 边缘点：距左边缘 6px，验证「点在图角上」时会不会因为图在动而脱靶
    out[id + 'e'] = await drift(img, frames, 6);
  }

  const lines = Object.entries(out).map(([id, r]) => {
    const pct = ((r.miss / r.frames) * 100).toFixed(0);
    return id.padEnd(4) + ' hit 不同 ' + String(r.miss).padStart(2) + '/' + r.frames +
      ' (' + pct.padStart(3) + '%)  帧间位移 ' + r.span.toFixed(1) + 'px  移动帧 ' + r.moved + '/' + r.frames;
  });
  document.getElementById('out').textContent = lines.join('\\n');
  window.__e2 = { done: true, cases: out };
}

run();
</script>`;

// 复用 E3 的 PNG 生成思路：这里直接用一张纯色小图，不够真实但足够定位
import zlib from 'node:zlib';
let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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
      raw[o] = 90;
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
const PNG = makePng(360, 240);

const server = http
  .createServer((req, res) => {
    if (req.url.startsWith('/photo.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length, 'cache-control': 'no-store' });
      return res.end(PNG);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  })
  .listen(PORT, '127.0.0.1');

const page = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(pathname, init) {
  const res = await fetch(CDP + pathname, init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const target = await j(`/json/new?${encodeURIComponent(page)}`, { method: 'PUT' });
if (!target.webSocketDebuggerUrl) {
  console.error('开标签页失败：', target);
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
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
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');

let result = null;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__e2 || null)', returnByValue: true });
  const raw = r?.result?.result?.value;
  if (raw && raw !== 'null') {
    result = JSON.parse(raw);
    break;
  }
}

ws.close();
await j(`/json/close/${target.id}`).catch(() => {});
server.close();

console.log(`\n页面 ${page}  （每格采样 60 帧，比对相邻两帧的命中元素）\n`);
if (!result) {
  console.log('没拿到结果。');
} else {
  const names = { d1: '轮播平移', d2: '单边放大', d3: '呼吸缩放', d4: '静止对照' };
  for (const [id, r] of Object.entries(result.cases)) {
    const pct = ((r.miss / r.frames) * 100).toFixed(0);
    const key = id.replace('e', '');
    const where = id.endsWith('e') ? '边缘 6px' : '中心点 ';
    const flag = r.miss > 0 ? '  ← 会误判' : '';
    console.log(
      `${key} ${names[key].padEnd(10)} ${where} hit 不同 ${String(r.miss).padStart(2)}/${r.frames} (${pct.padStart(3)}%)` +
        `  帧间位移 ${r.span.toFixed(1)}px  移动帧 ${r.moved}/${r.frames}${flag}`
    );
  }
}
process.exit(0);
