// E3 — 跨域图片经 blob 中转后，canvas 是否还被污染
//
// 起两个端口：8811 放页面，8812 放图片。端口不同即不同源。
// 页面里跑两条链路：
//   A  <img src=跨域>  → drawImage → toBlob     期望失败（污染）
//   B  fetch → ArrayBuffer → Blob → objectURL   期望成功（不污染）
//
// B 的 fetch 在页面上需要 CORS 头，这是有意加的：扩宿主权限恰好替代了 CORS，
// 我们要验的是「拿到字节之后」的链路，不是「怎么拿到字节」。

import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const PAGE_PORT = 8811;
const IMG_PORT = 8812;
const CDP = process.env.CDP || 'http://127.0.0.1:9333';

/* ---------- 造一张 320×240 的真 PNG ---------- */

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
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = (x * 255) / w;
      raw[o + 1] = (y * 255) / h;
      raw[o + 2] = 128;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = makePng(320, 240);

/* ---------- 页面 ---------- */

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>E3 canvas pollution</title>
<style>body{font:13px/1.6 ui-monospace,monospace;padding:24px;background:#111;color:#ddd}
td{padding:4px 12px 4px 0;vertical-align:top}b{color:#7fd}
.fire{color:#f77}</style>
<h3>E3 — canvas 污染实验</h3>
<table id="out"><tr><td>跑着呢…</td></tr></table>
<img id="probe" alt="" style="width:80px;border:1px solid #333">
<script>
const IMG = 'http://127.0.0.1:${IMG_PORT}/photo.png';
const rows = [];
const tds = (...cells) => '<tr>' + cells.map((c) => '<td>' + c + '</td>').join('') + '</tr>';

function canvasOf(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { c, ctx };
}

async function load(src) {
  const im = new Image();
  im.src = src;
  await im.decode();
  return im;
}

function sizeOf(blob) {
  return blob ? blob.size + ' B' : 'null';
}

async function run() {
  // A — 页面上直接引用跨域图，不带 crossOrigin
  try {
    const im = await load(IMG);
    const { c, ctx } = canvasOf(im);
    const px = [...ctx.getImageData(0, 0, 1, 1).data];
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    rows.push(['A 直连跨域', '未污染', 'toBlob ' + sizeOf(png) + ' · 首像素 ' + px.join(',')]);
  } catch (e) {
    rows.push(['A 直连跨域', '被污染', '<span class="fire">' + e.name + '</span> ' + e.message.slice(0, 70)]);
  }

  // B — 取字节，自己造 Blob，再走 objectURL（模拟 SW 把 ArrayBuffer 交给 content script）
  try {
    const res = await fetch(IMG);
    const buf = await res.arrayBuffer();
    const blob = new Blob([buf], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const im = await load(url);
    const { c, ctx } = canvasOf(im);
    const px = [...ctx.getImageData(0, 0, 1, 1).data];
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    rows.push([
      'B blob 中转',
      '未污染',
      '取到 ' + buf.byteLength + ' B → toBlob ' + sizeOf(png) + ' · 首像素 ' + px.join(','),
    ]);
    URL.revokeObjectURL(url);
  } catch (e) {
    rows.push(['B blob 中转', '失败', '<span class="fire">' + e.name + '</span> ' + e.message.slice(0, 70)]);
  }

  // C — blob URL 能不能被页面 fetch（间接说明它和页面同源）
  try {
    const probe = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(probe);
    const r = await fetch(url);
    const got = (await r.arrayBuffer()).byteLength;
    rows.push(['C blob 可回读', got === 3 ? '同源' : '异常', 'fetch(blob:) → ' + got + ' B']);
    URL.revokeObjectURL(url);
  } catch (e) {
    rows.push(['C blob 可回读', '异常', e.name + ' ' + e.message.slice(0, 60)]);
  }

  document.getElementById('out').innerHTML = rows.map((r) => tds(...r)).join('');
  window.__e3 = {
    done: true,
    origin: location.origin,
    dpr: devicePixelRatio,
    rows,
  };
}

run().catch((e) => {
  window.__e3 = { done: true, error: e.name + ': ' + e.message, origin: location.origin };
});
</script>`;

/* ---------- 服务 ---------- */

const servers = [
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    })
    .listen(PAGE_PORT, '127.0.0.1'),

  http
    .createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': PNG.length,
        'access-control-allow-origin': '*', // 模拟扩展的 host 权限
        'cache-control': 'no-store',
      });
      res.end(PNG);
    })
    .listen(IMG_PORT, '127.0.0.1'),
];

const page = `http://127.0.0.1:${PAGE_PORT}/`;

/* ---------- 用 CDP 打开并取结果 ---------- */

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
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const r = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__e3 || null)',
    returnByValue: true,
  });
  const raw = r?.result?.result?.value;
  if (raw && raw !== 'null') {
    result = JSON.parse(raw);
    break;
  }
}

ws.close();
await j(`/json/close/${target.id}`).catch(() => {});

console.log(`\n页面 ${page}   （图片源 http://127.0.0.1:${IMG_PORT}/photo.png）\n`);
if (!result) {
  console.log('没拿到结果——页面可能没跑完。手工打开上面那个地址看一眼。');
} else if (result.error) {
  console.log('脚本报错：', result.error);
} else {
  for (const [name, verdict, detail] of result.rows) {
    console.log(`${name.padEnd(12)} ${String(verdict).padEnd(8)} ${detail}`);
  }
  const a = result.rows[0]?.[1];
  const b = result.rows[1]?.[1];
  console.log(`\n结论：直连 ${a} · 中转 ${b}`);
  if (a === '被污染' && b === '未污染') {
    console.log('→ blob 中转确实解除了污染，「复制图片本身」可以做。');
  } else if (a === '未污染') {
    console.log('→ 直连都没被污染，说明这个跨域对照没造成功，实验无效。');
  }
}

for (const s of servers) s.close();
process.exit(0);
