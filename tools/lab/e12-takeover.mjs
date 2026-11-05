// E12 — 站点接管态（plan §8.1 T1–T9）。桩页面 + 可变 storage。

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { clean } from './clean-extensions.mjs';
import { CDP, freePort } from './browser.mjs';

const PORT = await freePort();
const ROOT = resolve(import.meta.dirname, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([len, tag, data, crc]);
}
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      raw[p++] = 60 + (x % 80);
      raw[p++] = 90 + (y % 60);
      raw[p++] = 140;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const IMG = png(600, 400);

const store = { 'closer:paused': [], 'closer:takeover': ['127.0.0.1'], 'closer:prefs': { backdrop: 'dark' } };

const SCRIPTS = `
<script>
window.__store = ${JSON.stringify(store)};
window.chrome = {
  storage: {
    local: {
      get: (keys) => {
        const out = {};
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) if (window.__store[k] !== undefined) out[k] = window.__store[k];
        return Promise.resolve(out);
      },
      set: (obj) => { Object.assign(window.__store, obj); return Promise.resolve(); },
    },
    onChanged: { addListener: () => {} },
  },
  runtime: { sendMessage: (m, cb) => setTimeout(() => cb && cb(null), 0) },
  i18n: { getMessage: (k, s) => k, getUILanguage: () => 'en' },
};
</script>
<script src="/js/core.js"></script>
<script src="/js/detect.js"></script>
<script src="/js/yield.js"></script>
<script src="/js/meta.js"></script>
<script src="/js/bytes.js"></script>
<script src="/js/gallery.js"></script>
<script src="/js/overlay.js"></script>
<script src="/js/actions.js"></script>
<script src="/js/hint.js"></script>
<script src="/js/page-bridge.js"></script>
<script src="/js/boot.js"></script>
`;

const PAGE = `<!doctype html><meta charset=utf-8>
<style>
body{margin:0;padding:24px}
img{width:240px;display:block}
.viewer{position:fixed;inset:0;z-index:99999;background:#000;display:grid;place-items:center}
</style>
<img id="thumb" src="/img.png">
<img id="wiki" src="/img.png" style="width:240px">
<a id="wikilink" href="/wiki/File:Sample.jpg"><img id="wikiin" src="/img.png" style="width:240px;cursor:pointer"></a>
<img id="s2" src="/img.png" style="width:240px">
<div id="gal"><img class="g" src="/img.png"><img class="g" src="/img.png"><img class="g" src="/img.png"></div>
<script>
document.getElementById('thumb').addEventListener('click',()=>{
  const d=document.createElement('div'); d.className='viewer';
  d.innerHTML='<img class="t-image-viewer" src="/img.png">'; document.body.appendChild(d);
});
document.getElementById('thumb').addEventListener('pointerdown',()=>{
  const d=document.createElement('div'); d.className='viewer';
  d.innerHTML='<img src="/img.png">'; document.body.appendChild(d);
});
window.__pageZoom = 0;
document.getElementById('thumb').addEventListener('click',()=>{ window.__pageZoom++; document.getElementById('thumb').style.transform='scale(3)'; });
document.getElementById('wikiin').addEventListener('click',()=>{
  const d=document.createElement('div'); d.className='viewer mw-viewer';
  d.innerHTML='<img src="/img.png">'; document.body.appendChild(d);
});
</script>
${SCRIPTS}
<script>
(async()=>{await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));
await Closer.load(); window.__ready=true;})();
</script>`;

const server = http
  .createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/img.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': IMG.length });
      return res.end(IMG);
    }
    if (url.startsWith('/js/')) {
      const file = url.slice(4).replace(/[^a-z.]/gi, '');
      try {
        const js = readFileSync(join(ROOT, 'src/content', file));
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

await clean(CDP);
const target = await fetch(`${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`, { method: 'PUT' }).then((r) =>
  r.json()
);
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
const evalx = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.result?.value;
};

for (let i = 0; i < 40 && !(await evalx('window.__ready')); i++) await sleep(120);

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const click = (id) =>
  evalx(`(() => {
    const img = document.getElementById('${id}');
    const r = img.getBoundingClientRect();
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0,
      clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
  })()`);

// T1/T2 — 接管态：我们开、页面查看器不出
await click('thumb');
await sleep(450);
const t12 = await evalx(`({
  open: Closer.overlay.isOpen(),
  viewers: document.querySelectorAll('.t-image-viewer,.viewer').length,
  takeover: Closer.isTakeover(),
})`);
check('T1 接管态页面 click 查看器未挂出', t12?.viewers === 0, JSON.stringify(t12));
check('T2 接管态 overlay 打开', t12?.open === true, JSON.stringify(t12));
check('T2b 接管态站点 click 缩放未执行', (await evalx('window.__pageZoom')) === 0, String(await evalx('window.__pageZoom')));

// T10 — 维基 File: 缩略图（judge 9/12 误杀）接管态应开
await evalx(`Closer.overlay?.close?.(true,true); document.getElementById('closer')?.remove(); document.querySelectorAll('.viewer').forEach(n=>n.remove()); window.__pageZoom=0`);
await evalx(`window.__store['closer:takeover']=['127.0.0.1']; Closer.state.takeover=true`);
await evalx(`(() => {
  const img=document.getElementById('wikiin'); const r=img.getBoundingClientRect();
  img.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
})()`);
await sleep(450);
const t10 = await evalx(`({ open: Closer.overlay.isOpen(), mw: document.querySelectorAll('.mw-viewer').length })`);
check('T10 维基 File 链缩略图接管态我们开', t10?.open === true && t10?.mw === 0, JSON.stringify(t10));

// T5 — Esc 后模式不变
await evalx(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(400);
const t5 = await evalx(`({ mode: Closer.isTakeover(), store: window.__store['closer:takeover'] })`);
check('T5 Esc 后接管态不变', t5?.mode === true && t5?.store?.includes('127.0.0.1'), JSON.stringify(t5));

// T7 — Alt 强制开，模式不变
await evalx(`Closer.state.takeover = false; window.__store['closer:takeover']=[]`);
await click('thumb');
await sleep(30);
await evalx(`(() => {
  const img=document.getElementById('thumb'); const r=img.getBoundingClientRect();
  img.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,altKey:true,
    clientX:r.left+r.width/2, clientY:r.top+r.height/2}));
})()`);
await sleep(400);
const t7 = await evalx(`({ open: Closer.overlay.isOpen(), takeover: window.__store['closer:takeover'] })`);
check('T7 Alt 点击强制开且不改模式', t7?.open === true && t7?.takeover?.length === 0, JSON.stringify(t7));
await evalx(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(400);

// T8 — 自动态快速关闭询问 vs 接管态不问
await evalx(`Closer.overlay?.close?.(true, true); document.getElementById('closer')?.remove(); window.__store['closer:takeover']=[]; Closer.state.takeover=false; Closer.state.pausePromptedHere=false; Closer.state.unseen=false`);
await evalx(`(() => {
  const img = document.getElementById('s2');
  const r = img.getBoundingClientRect();
  img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0,
    clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
})()`);
await sleep(200);
await evalx(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
await sleep(80);
const autoPrompt = await evalx(`(() => {
  if (!Closer.overlay.isOpen()) return { open: false };
  return { open: true, panel: !document.getElementById('closer').shadowRoot.querySelector('.panel').hidden, mode: Closer.siteMode() };
})()`);
check('T8 自动态快速 Esc 出现暂停询问', autoPrompt?.panel === true && autoPrompt?.mode === 'auto', JSON.stringify(autoPrompt));
await evalx(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
await sleep(400);

await evalx(`window.__store['closer:takeover']=['127.0.0.1']; Closer.state.takeover=true; Closer.state.pausePromptedHere=false`);
await click('thumb');
await sleep(450);
const openedAt = await evalx('performance.now()');
await evalx(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(50);
const takePrompt = await evalx(`Closer.overlay.isOpen()`);
check('T8 接管态快速 Esc 不询问', takePrompt === false, String(takePrompt));
void openedAt;

// T9 — unseen 在接管态仍退场
await evalx(`document.getElementById('closer')?.remove(); Closer.state.unseen=false; Closer.state.takeover=true; window.__store['closer:takeover']=['127.0.0.1']`);
await evalx(`(() => {
  window.__hider = new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes)
      if (n.nodeType === 1) n.style.setProperty('display', 'none', 'important');
  });
  window.__hider.observe(document.documentElement, { childList: true });
})()`);
await click('thumb');
await sleep(280);
const t9 = await evalx(`({ unseen: Closer.state.unseen, open: Closer.overlay.isOpen() })`);
check('T9 接管态仍 respect unseen', t9?.unseen === true && t9?.open === false, JSON.stringify(t9));
await evalx(`window.__hider?.disconnect()`);

// T6 — 交还页面
await evalx(`document.querySelectorAll('.viewer').forEach((n)=>n.remove()); window.__store['closer:takeover']=['127.0.0.1']; Closer.state.takeover=true; Closer.state.unseen=false`);
await click('thumb');
await sleep(450);
await evalx(`Closer.handBackHere()`);
await sleep(100);
const t6 = await evalx(`({ takeover: Closer.isTakeover(), store: window.__store['closer:takeover'] })`);
check('T6 交还页面 → 自动', t6?.takeover === false && t6?.store?.length === 0, JSON.stringify(t6));

// T3 — pointerdown 双开快退
await evalx(`window.__store['closer:takeover']=['127.0.0.1']; Closer.state.takeover=true`);
const t3 = await evalx(`(async()=>{
  const img=document.getElementById('thumb'); const r=img.getBoundingClientRect();
  const t0=performance.now();
  img.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
  img.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
  await new Promise(r=>setTimeout(r,120));
  return { open: Closer.overlay.isOpen(), dt: performance.now()-t0 };
})()`);
check('T3 pointerdown 挂载后 100ms 内退场', t3?.open === false && t3?.dt < 200, JSON.stringify(t3));

// T4 — 连续失败降级
await evalx(`window.__store['closer:takeover']=['127.0.0.1']; Closer.state.takeover=true; Closer.state.takeoverFails=0`);
for (let n = 0; n < 2; n++) {
  await click('thumb');
  await sleep(30);
  await evalx(`Closer.noteTakeoverFail()`);
}
const t4 = await evalx(`({ takeover: window.__store['closer:takeover'], toast: document.getElementById('closer')?.shadowRoot?.querySelector('.toast')?.textContent })`);
check('T4 两次失败降级为自动', t4?.takeover?.length === 0, JSON.stringify(t4));

ws.close();
await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
server.close();

const pass = results.filter((r) => r.ok).length;
console.log('');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail && !r.ok ? `   ${r.detail}` : ''}`);
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
