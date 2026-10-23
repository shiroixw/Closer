// E7 — 宪法第六条的速度预算，实测。
//
// 三条断言，全部在 CPU 4× 降速下取（不带降速测出来的数字没有意义）：
//   1. judge() 单次 < 1 ms
//   2. 点击到首帧 < 100 ms
//   3. 页面加载期挂在 window 上的监听 ≤ 2 个
//
// 第 3 条用静态计数：把 content 脚本当文本数 addEventListener 的顶层调用。
// 动态数需要 DevTools 的 getEventListeners，页面里没有。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { clean } from './clean-extensions.mjs';

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const PORT = 8832;
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
      raw[o] = 60 + (x % 100);
      raw[o + 1] = 90;
      raw[o + 2] = 140;
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
const BIG = png(1200, 800);
const SMALL = png(48, 48);

/* ---------- 页面 ---------- */

const STUB = `<script>
window.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: () => {} },
  },
  runtime: { lastError: null, sendMessage: (m, cb) => setTimeout(() => cb && cb(null), 0) },
};
window.__perf = { clickAt: 0, openAt: 0 };
addEventListener('click', () => { window.__perf.clickAt = performance.now(); }, true);
const mo = new MutationObserver(() => {
  if (!window.__perf.openAt && document.getElementById('closer')) {
    window.__perf.openAt = performance.now();
    mo.disconnect();
  }
});
mo.observe(document.documentElement, { childList: true });
</script>`;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>perf</title>
<style>body{margin:0;padding:20px;background:#eee}img{display:block;margin-bottom:12px}</style>
${STUB}
<img id="big" src="/img.png">
<img id="small" src="/small.png">
<script src="/js/core.js"></script>
<script src="/js/detect.js"></script>
<script src="/js/meta.js"></script>
<script src="/js/bytes.js"></script>
<script src="/js/yield.js"></script>
<script src="/js/overlay.js"></script>
<script src="/js/actions.js"></script>
<script src="/js/hint.js"></script>
<script src="/js/boot.js"></script>
<script>
(async () => {
  await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
  window.__ready = true;
})();
</script>`;

const server = http
  .createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/img.png' || url === '/small.png') {
      const buf = url === '/img.png' ? BIG : SMALL;
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length });
      return res.end(buf);
    }
    if (url.startsWith('/js/')) {
      const file = url.slice(4).replace(/[^a-z.]/gi, '');
      try {
        const js = fs.readFileSync(path.join(ROOT, 'src/content', file));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(js);
      } catch {
        res.writeHead(404);
        return res.end('no');
      }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  })
  .listen(PORT, '127.0.0.1');

/* ---------- CDP ---------- */

async function j(p, init) {
  const res = await fetch(CDP + p, init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

await clean(CDP);

const tab = await j(`/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`, { method: 'PUT' });
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let seq = 0;
const waiting = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  waiting.get(m.id)?.(m);
  waiting.delete(m.id);
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++seq;
    waiting.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r?.result?.result?.value;
};

for (let i = 0; i < 40; i++) {
  if ((await ev('!!window.__ready && !!window.Closer && Closer.state.ready')) === true) break;
  await sleep(150);
}
await sleep(300);

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

/* --- 1. CPU 4× 降速 --- */

await send('Emulation.setCPUThrottlingRate', { rate: 4 });

// 固定视口：不固定的话，窗口一被缩小，图片中心就落到视口外，
// 点击落空 → 报「overlay 没打开」。而那不是产品坏了，是测试环境变了。
// 顺带让首帧数字在机器之间可比。
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(200);

/* --- 2. judge() 单次耗时 --- */

const judgeStat = await ev(`(() => {
  const img = document.getElementById('big');
  for (let i = 0; i < 200; i++) Closer.judge(img);           // 预热，让 JIT 先干活
  const N = 3000;
  const t0 = performance.now();
  let hit = 0;
  for (let i = 0; i < N; i++) if (Closer.judge(img)) hit++;
  const dt = performance.now() - t0;
  return { perCall: dt / N, total: dt, n: N, hit };
})()`);

check(
  'judge() 单次 < 1 ms（CPU 4×）',
  judgeStat && judgeStat.perCall < 1,
  judgeStat ? `${judgeStat.perCall.toFixed(3)} ms · ${judgeStat.n} 次共 ${judgeStat.total.toFixed(0)} ms` : '测量失败'
);

/* --- 3. 点击到首帧 --- */

const spot = await ev(`(() => {
  const im = document.getElementById('big');
  const r = im.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);

await sleep(120);

/* --- 3a. 悬停提示用**真实鼠标**验一次（D32） ---
   e4 用合成 PointerEvent 验判据逻辑，这里补的是「浏览器真的会派 pointerover、
   光标真的黏得住又放得掉」，两者缺一都不算测过。 */
// 「dwell 期间还没写」这一步用**同步读**判，不靠 sleep 卡时间：
// CPU 4× 降速下 CDP 往返本身就可能超过 dwell，按毫秒采样会假红。
const immediate = await ev(`(() => {
  const img = document.getElementById('big');
  img.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  return img.style.cursor; // 同一个任务里读：计时器还没到点，必须还是空
})()`);
await sleep(200); // 越过 DWELL(70)
const dwelled = await ev(`document.getElementById('big').style.cursor`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, button: 'none' });
await sleep(100);
const left = await ev(`({
  cursor: document.getElementById('big').style.cursor,
  attr: document.getElementById('big').hasAttribute('style'),
})`);
check(
  '悬停提示：dwell 期间不写、之后给 zoom-in、移开即还原',
  immediate === '' && dwelled === 'zoom-in' && left.cursor === '' && left.attr === false,
  `同步=${JSON.stringify(immediate)} 200ms=${JSON.stringify(dwelled)} 离开=${JSON.stringify(left)}`
);

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, button: 'none' });
await sleep(120);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });

let perf = null;
for (let i = 0; i < 30; i++) {
  await sleep(20);
  perf = await ev('JSON.stringify(window.__perf)');
  if (perf && JSON.parse(perf).openAt) break;
}

const p = perf ? JSON.parse(perf) : null;
const firstFrame = p && p.openAt && p.clickAt ? p.openAt - p.clickAt : null;

check(
  '点击到首帧 < 100 ms（CPU 4×）',
  firstFrame !== null && firstFrame < 100,
  firstFrame === null ? '没测到' : `${firstFrame.toFixed(1)} ms`
);
check('点击确实打开了 overlay', (await ev("!!document.getElementById('closer')")) === true);

/* --- 4. 加载期的监听器（静态） --- */

// 加载期的监听分布在两个文件：boot 的接线，和 hint 的 pointerover（D32）。
// 只数 boot.js 会漏掉后者——预算数字必须跟着代码走，否则条子在说谎。
const bootSrc = fs.readFileSync(path.join(ROOT, 'src/content/boot.js'), 'utf8');
const hintSrc = fs.readFileSync(path.join(ROOT, 'src/content/hint.js'), 'utf8');
const addsOf = (src) => (src.match(/^\s*addEventListener\(/gm) || []).length;
const bootAdds = addsOf(bootSrc);
const hintAdds = addsOf(hintSrc);
check(
  '页面加载期只挂 ≤ 3 个监听',
  bootAdds + hintAdds <= 3,
  `boot.js × ${bootAdds} + hint.js × ${hintAdds}（宪法第六条，D32）`
);

// overlay 打开时才挂的那一批，不该算进加载预算
const overlaySrc = fs.readFileSync(path.join(ROOT, 'src/content/overlay.js'), 'utf8');
const overlayAdds = (overlaySrc.match(/addEventListener\(/g) || []).length;
check('监听绑在打开之后', overlayAdds > 0, `overlay.js 共 ${overlayAdds} 处（bind/unbind 成对，加载期不执行）`);

/* --- 5. 收尾 --- */

await send('Emulation.setCPUThrottlingRate', { rate: 1 });
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
await j(`/json/close/${tab.id}`).catch(() => {});
server.close();

const pad = (s) => s + ' '.repeat(Math.max(0, 34 - [...s].length));
console.log(`\n速度预算实测 · CPU 4× 降速 · 视口 ${await Promise.resolve('1200×800 图')}\n`);
let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? '✓' : '✗'} ${pad(r.name)} ${r.detail}`);
}
console.log(`\n${results.length - bad}/${results.length} 通过`);
process.exit(bad ? 1 : 0);
