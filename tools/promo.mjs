// 商店物料：五张截图 + 两档宣传图，两种语言各一套。
//
// 为什么不手截：截图里的每一处都要一致且可重来——背板色、面板里的数值、界面语言、
// 页面上的那个站点名。手截一次可以，但改一行文案就要重截五张，而重截的人会漏掉其中一张。
// 所以这里把「页面 + 操作 + 说明文字」写成脚本：`node tools/promo.mjs` 一次出全套，
// 且每一张都是同一份源码在当前提交上的样子（宪法第五条：截图也应当是收据）。
//
// 三件事值得说清楚：
//
// 1. **界面语言怎么切。** chrome.i18n 跟的是 Chrome 的 UI 语言，macOS 上 `--lang` 不生效
//    （实测）。所以给每个语言集打一份临时副本，把目标语言的 messages.json 同时写进
//    en 与 zh_CN 两个目录——于是无论系统语言是什么，扩展都只说这一种。
// 2. **权限怎么绕。** 截图要看见 overlay，就得让 content script 注进去，而真实授权需要人手
//    点 Allow。副本里把 optional_host_permissions 提成声明式 host_permissions（与 e5/e9 同法）。
//    只影响这份临时副本，真实包不动。
// 3. **站点名怎么来的。** popup 与 ⓘ 面板都会显示当前站点，`127.0.0.1:8123` 出现在商店截图
//    上是噪音。所以桩页面挂在 `grano.studio`（`--host-resolver-rules` 指到本机），
//    走的是真实代码路径，没有任何一处文案是写死的。
//
// 尺寸：截图 1280×800、宣传图 440×280 与 1400×560 —— 商店只认这几个数，多一像素都会被拒。
// 所以内部一律按 2× 渲染再落回目标像素（文字锐利），最终 PNG 精确等于目标尺寸。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { resolveEntries } from './pack.mjs';

// 先改环境再 import：browser.mjs 在 import 时就启动浏览器了（顶层 await）
process.env.CLOSER_HOST_RULES ||= 'MAP grano.studio 127.0.0.1';
const { CDP, freePort, stageDir } = await import('./lab/browser.mjs'); // 车道：本进程独占的 headless，不抢焦点

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'store');
const CACHE = path.join(ROOT, '.temp/promo');
const IMG = path.join(CACHE, 'img');
const PAGE = path.join(CACHE, 'pages');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();
const BASE = `http://grano.studio:${PORT}`;

const LOCALES = {
  zh: {
    dir: 'zh_CN',
    nav: ['摄影', '笔记', '关于'],
    kicker: '北岸 · 第十四期',
    title: '在北岸的三天',
    byline: '图文 / 沈砚 · 12 分钟',
    cap: '灯塔下的潮线，退潮后两小时。',
    body: [
      '潮水退到第二道礁石的时候，光才真正落下来。渔民说这个季节的风从西南来，会把云压得很低，压在灯塔的肩上。',
      '我们在崖上走了三公里，捡到一枚被海水磨圆的绿色玻璃。它曾经是一个瓶子的肩膀，现在只剩下一小块弧。',
    ],
    captions: [
      ['点任意一张图，就地看清它', '不新开标签页，不打断阅读'],
      ['尺寸、比例、格式、体积', '一张图到底是什么，按 · 就说清楚'],
      ['透明背景一眼看见', '棋盘、浅色、深色，B 键切换'],
      ['全站默认开，按站点关', '工具栏里三件事：开关、背板、暂停'],
      ['滚轮缩放，拖拽平移', '以指针为锚，看得见细节'],
    ],
  },
  en: {
    dir: 'en',
    nav: ['Field notes', 'Photographs', 'About'],
    kicker: 'North coast · No. 14',
    title: 'Three days on the north coast',
    byline: 'Words & pictures — Mara Ellis · 12 min read',
    cap: 'The tide line below the lighthouse, two hours after low water.',
    body: [
      'The light only arrives after the sea has withdrawn past the second reef. The fishermen say the wind comes from the southwest this time of year, which presses the clouds down until they rest on the shoulder of the lighthouse.',
      'We walked three kilometres along the cliff and found a piece of green glass worn round by the water. It had been the shoulder of a bottle once; now it was a small arc and nothing else.',
    ],
    captions: [
      ['Click any image. See it at its real size.', 'No new tab. No lost place.'],
      ['Dimensions, ratio, format, file size', 'Press · and the image explains itself'],
      ['Transparency, visible', 'Checkerboard, light, dark — press B'],
      ['On everywhere. Off where you want.', 'Enable, backdrop, pause — from the toolbar'],
      ['Scroll to zoom. Drag to pan.', 'Anchored on the pointer'],
    ],
  },
};

/* ── 0. 素材：照片取自 Lorem Picsum（Unsplash 授权，可商用） ────── */

const PHOTOS = {
  hero: { id: 1018, w: 1600, h: 1000 },
  g1: { id: 1015, w: 900, h: 620 },
  g2: { id: 1036, w: 900, h: 620 },
  g3: { id: 1043, w: 900, h: 620 },
};

fs.mkdirSync(IMG, { recursive: true });
fs.mkdirSync(PAGE, { recursive: true });

for (const [name, p] of Object.entries(PHOTOS)) {
  const file = path.join(IMG, `${name}.jpg`);
  if (fs.existsSync(file) && fs.statSync(file).size > 10_000) continue;
  const url = `https://picsum.photos/id/${p.id}/${p.w}/${p.h}`;
  const res = await fetch(url).catch((e) => {
    throw new Error(`下载素材失败（${url}）：${e.message}\n这条脚本需要网络，第一次跑会把图缓存到 .temp/promo/img/`);
  });
  if (!res.ok) throw new Error(`下载素材失败（${url}）：HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/* ── 造一张带透明通道的图：棋盘背板那张截图需要它 ────────────── */

const CRC_T = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tag = Buffer.from(type, 'ascii');
  let c = 0xffffffff;
  for (const b of Buffer.concat([tag, data])) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, tag, data, crc]);
}

function rgbaPng(w, h, paint) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y, w, h);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 一枚「印章」：外圈渐变、中心留空、四角全透明。做成图而不是文字，
// 是因为棋盘那张要展示的是「图自己带透明」，说明文字证明不了这件事。
const STAMP = rgbaPng(1000, 640, (x, y, w, h) => {
  const dx = x - w / 2;
  const dy = y - h / 2;
  const d = Math.sqrt(dx * dx + dy * dy * 1.35);
  const ring = Math.abs(d - 250);
  if (ring > 46) return [0, 0, 0, 0];
  const t = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);
  return [
    Math.round(60 + 150 * t),
    Math.round(120 + 90 * (1 - t)),
    Math.round(200 - 60 * t),
    Math.round(255 * (1 - (ring / 46) * 0.22)),
  ];
});
fs.writeFileSync(path.join(IMG, 'stamp.png'), STAMP);

/* ── 1. 演示页面（走真实排版，不用截图软件拼） ─────────────── */

function article(loc) {
  const L = LOCALES[loc];
  return `<!doctype html><html lang="${loc}"><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:#fff; color:#18181b;
         font: 17px/1.75 -apple-system, "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", sans-serif; }
  nav { display:flex; align-items:center; gap:22px; padding:17px 40px; border-bottom:1px solid #e7e7ea; }
  nav b { font: 600 17px/1 ui-serif, Georgia, "Songti SC", serif; letter-spacing:.12em; }
  nav span { color:#a1a1aa; font-size:12.5px; letter-spacing:.06em; }
  nav i { flex:1; }
  nav a { color:#71717a; text-decoration:none; font-size:13px; }
  main { max-width:1060px; margin:0 auto; padding:38px 40px 70px; }
  .kicker { color:#a1a1aa; font-size:12.5px; letter-spacing:.14em; text-transform:uppercase; margin:0 0 12px; }
  h1 { font: 600 42px/1.16 ui-serif, Georgia, "Songti SC", serif; letter-spacing:-.01em; margin:0 0 14px; }
  .byline { color:#71717a; font-size:13px; margin:0 0 24px; }
  figure { margin:0 0 26px; }
  figure img { width:100%; display:block; border-radius:3px; background:#f4f4f5; }
  figcaption { color:#71717a; font-size:12.5px; margin-top:9px; }
  p { margin:0 0 18px; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin:30px 0 24px; }
  .grid img { width:100%; display:block; border-radius:3px; background:#f4f4f5; }
</style>
<nav><b>GRANO</b><span>${L.nav[0]}</span><i></i><a>${L.nav[1]}</a><a>${L.nav[2]}</a></nav>
<main>
  <p class="kicker">${L.kicker}</p>
  <h1>${L.title}</h1>
  <p class="byline">${L.byline}</p>
  <figure><img id="hero" src="/img/hero.jpg"><figcaption>${L.cap}</figcaption></figure>
  <p>${L.body[0]}</p>
  <p>${L.body[1]}</p>
  <div class="grid"><img src="/img/g1.jpg"><img src="/img/g2.jpg"><img src="/img/g3.jpg"></div>
</main>`;
}

function assetsPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<style>
  * { box-sizing:border-box; }
  body { margin:0; background:#fff; color:#18181b; font: 16px/1.7 -apple-system, "PingFang SC", sans-serif; }
  .wrap { padding:30px 40px; }
  .head { display:flex; align-items:center; gap:10px; border-bottom:1px solid #e7e7ea; padding-bottom:13px; margin-bottom:24px; }
  .head b { font: 600 15px/1 ui-serif, Georgia, serif; letter-spacing:.1em; }
  .head span { color:#a1a1aa; font-size:12.5px; }
  .row { display:flex; gap:32px; align-items:flex-start; }
  .asset { flex:1; border:1px solid #eee; border-radius:8px; padding:20px;
           background: repeating-conic-gradient(#fafafa 0% 25%, #fff 0% 50%) 50% / 18px 18px; }
  .asset img { width:100%; display:block; }
  .meta { width:270px; }
  .meta h2 { font: 600 19px/1.3 ui-serif, Georgia, serif; margin:0 0 10px; }
  .meta p { color:#71717a; font-size:13.5px; margin:0 0 10px; }
  .meta code { background:#f4f4f5; border-radius:4px; padding:1px 5px; font-size:12px; }
</style>
<div class="wrap">
  <div class="head"><b>ASSETS</b><span>stamp.png · 1000 × 640 · alpha</span></div>
  <div class="row">
    <div class="asset"><img id="art" src="/img/stamp.png"></div>
    <div class="meta">
      <h2>Brand stamp</h2>
      <p>Delivered as PNG with alpha. The ring is a gradient; everything else is empty.</p>
      <p>Use it on <code>--surface-1</code> or over photography.</p>
    </div>
  </div>
</div>`;
}

/* ── 2. 本地服务器 ────────────────────────────────────────── */

const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.html': 'text/html; charset=utf-8' };

const server = http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url.startsWith('/article/')) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(article(url.slice('/article/'.length)));
    }
    if (url === '/assets') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(assetsPage());
    }
    const file = url.startsWith('/img/')
      ? path.join(IMG, url.slice(5))
      : url.startsWith('/pages/')
        ? path.join(PAGE, url.slice(7))
        : null;
    if (file && fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404).end('no');
  })
  .listen(PORT, '127.0.0.1'); // 监听回环即可：域名由 --host-resolver-rules 指过来

/* ── 3. CDP 小工具 ────────────────────────────────────────── */

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
    if (slot) {
      waiting.delete(m.id);
      slot(m);
    }
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

const ev = async (page, expression) => {
  const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r?.result?.result?.value;
};

const clickAt = async (page, x, y) => {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

const key = async (page, k, code, vk) => {
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
};

const metrics = (page, width, height, deviceScaleFactor) =>
  page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });

const shoot = async (page) =>
  Buffer.from((await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })).result.data, 'base64');

async function goto(page, url, [w, h, dsf]) {
  await metrics(page, w, h, dsf);
  await page.send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    const ok = await ev(
      page,
      `document.readyState === 'complete' && [...document.images].every(i => i.complete && i.naturalWidth > 0)`
    );
    if (ok) break;
    await sleep(120);
  }
  await sleep(240); // 字体、圆角、阴影收尾
}

async function openTab(url) {
  const tab = await json(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const page = connect(tab.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  return { page, tab };
}

/* ── 4. 每个语言一份临时扩展（见文件头 1、2） ──────────────── */

const { entries, errors } = resolveEntries();
if (errors.length) {
  console.error('发布清单不成立，先跑 `node tools/pack.mjs --check`：\n  - ' + errors.join('\n  - '));
  process.exit(1);
}

async function loadExtension(loc) {
  const stage = stageDir(`ext-${loc}`);
  for (const rel of entries) {
    const dest = path.join(stage, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }

  const messages = fs.readFileSync(path.join(ROOT, `_locales/${LOCALES[loc].dir}/messages.json`));
  for (const dir of ['en', 'zh_CN']) fs.writeFileSync(path.join(stage, `_locales/${dir}/messages.json`), messages);

  const mf = path.join(stage, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  manifest.host_permissions = ['*://*/*']; // 声明式：截图要看见 overlay，人手点不到 Allow
  delete manifest.optional_host_permissions;
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));

  const ver = await json('/json/version');
  const browser = connect(ver.webSocketDebuggerUrl);
  await browser.ready;
  const loaded = await browser.send('Extensions.loadUnpacked', { path: stage });
  browser.ws.close();
  const id = loaded?.result?.id;
  if (!id) throw new Error('扩展加载失败：' + JSON.stringify(loaded));
  await sleep(800);
  return { id, stage };
}

/* ── 5. 五个场景（内层按 2× 截，画框里再落到 1×） ──────────── */

const RAW = [1216, 684, 2];
// 宣传图右边那块「眼睛格子」用的小视口：比例 1.43 与 252×176 对齐，
// 于是整张图放进去不用裁切，chrome（ⓘ 与三个动作）按比例更大，小尺寸下也认得出这是查看器。
const PEEK = [560, 392, 2];

const heroSpot = (page) =>
  ev(
    page,
    `(() => { const r = document.getElementById('hero').getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 260)) }; })()`
  );

async function shotOpen(page, loc) {
  await goto(page, `${BASE}/article/${loc}`, RAW);
  const spot = await heroSpot(page);
  await clickAt(page, spot.x, spot.y);
  await sleep(780); // FLIP + 背板淡入走完，chrome 还在（2.2 s 后才淡出）
  return shoot(page);
}

async function shotInfo(page, loc) {
  await goto(page, `${BASE}/article/${loc}`, RAW);
  const spot = await heroSpot(page);
  await clickAt(page, spot.x, spot.y);
  await sleep(1000); // 等体积那行从 service worker 回来
  const info = await ev(
    page,
    `(() => { const h = document.getElementById('closer');
       const b = h.shadowRoot.querySelector('.info'); const r = b.getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`
  );
  await clickAt(page, info.x, info.y);
  await sleep(420);
  return shoot(page);
}

async function shotChecker(page) {
  await goto(page, `${BASE}/assets`, RAW);
  // 点圆环上（图中间是透明的，但那不影响命中；这里点环是为了让截图里也看得见实体）
  const spot = await ev(
    page,
    `(() => { const r = document.getElementById('art').getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.11) }; })()`
  );
  await clickAt(page, spot.x, spot.y);
  await sleep(760);

  await cycleBackdrop(page, 'checker');
  const shot = await shoot(page);
  // 背板是**偏好**：按 B 会写进 chrome.storage.local，同一轮里后面几张截图会继承它。
  // 所以拍完立刻转回 dark，否则 05 与宣传图会莫名其妙变成棋盘档（曾经如此，白拍了一轮）。
  await cycleBackdrop(page, 'dark');
  return shot;
}

async function cycleBackdrop(page, want) {
  for (let i = 0; i < 4; i++) {
    const cls = await ev(page, `document.getElementById('closer')?.className || ''`);
    if (cls.includes(want)) return;
    await key(page, 'b', 'KeyB', 66);
    await sleep(260);
  }
  // 转不到就报错——不能截一张看起来还行的图交上去
  const cls = await ev(page, `document.getElementById('closer')?.className || ''`);
  throw new Error(`背板没转到 ${want}：${cls || '没有 #closer'}`);
}

async function shotPeek(page, loc) {
  await goto(page, `${BASE}/article/${loc}`, PEEK);
  // 小视口里 hero 还在首屏之外：先把它滚到视口中间，否则点的是视口外的坐标（什么都不会打开）
  await ev(page, `document.getElementById('hero').scrollIntoView({ block: 'center' })`);
  await sleep(320);
  const spot = await heroSpot(page);
  await clickAt(page, spot.x, spot.y);
  await sleep(780);
  return shoot(page);
}

async function shotZoom(page, loc) {
  await goto(page, `${BASE}/article/${loc}`, RAW);
  const spot = await heroSpot(page);
  await clickAt(page, spot.x, spot.y);
  await sleep(780);
  // 锚在图上那条路上缩到 3 倍左右：与 01 的差别要一眼看得见——01 是整图（有黑边），这里是被放大的局部
  const at = await ev(
    page,
    `(() => { const h = document.getElementById('closer');
       const im = h.shadowRoot.querySelector('.photo'); const r = im.getBoundingClientRect();
       return { x: Math.round(r.left + r.width * 0.42), y: Math.round(r.top + r.height * 0.76) }; })()`
  );
  for (let i = 0; i < 7; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: -150 });
    await sleep(140);
  }
  await sleep(420);
  return shoot(page);
}

// popup 的站点名来自 chrome.tabs.query 的活跃标签页：所以先把文章页拉到前台，
// 再让 popup 重新读一次——走的是真实代码路径，没有任何一处文案是编的。
async function shotPopup(page, loc, extId) {
  await goto(page, `${BASE}/article/${loc}`, RAW);
  const pageShot = await shoot(page);

  const popup = await openTab(`chrome-extension://${extId}/ui/popup.html`);
  await metrics(popup.page, 288, 240, 2);
  await sleep(500);

  await page.send('Page.bringToFront');
  await sleep(260);
  await ev(popup.page, 'load()');
  await sleep(400);

  const h = await ev(popup.page, 'Math.ceil(document.documentElement.scrollHeight)');
  await metrics(popup.page, 288, Math.max(180, h), 2);
  await sleep(320);
  const popupShot = await shoot(popup.page);

  popup.page.ws.close();
  await json(`/json/close/${popup.tab.id}`);
  return { pageShot, popupShot };
}

/* ── 6. 组装：说明文字 + 画框 ─────────────────────────────── */

const b64 = (buf) => buf.toString('base64');

function frame({ title, sub, shot, popup }) {
  return `<!doctype html><html><meta charset="utf-8">
<style>
  html, body { margin:0; width:1280px; height:800px; overflow:hidden; }
  body { background:
           radial-gradient(1200px 620px at 18% -8%, #1e1e26 0%, rgba(30,30,38,0) 62%),
           radial-gradient(900px 560px at 92% 108%, #16161c 0%, rgba(22,22,28,0) 60%),
           #0b0b0c;
         font-family:-apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
  .title { position:absolute; left:40px; top:27px; color:#fafafa; font-size:23px; font-weight:600; letter-spacing:-.01em; }
  .sub   { position:absolute; left:40px; top:60px; color:#8f8f97; font-size:14px; }
  .shot  { position:absolute; left:32px; top:96px; width:1216px; height:684px; border-radius:12px;
           overflow:hidden; border:1px solid rgba(255,255,255,.09);
           box-shadow:0 30px 70px rgba(0,0,0,.55); }
  .shot > img { width:100%; height:100%; display:block; }
  .popup { position:absolute; right:18px; top:12px; width:288px; border-radius:10px; overflow:hidden;
           border:1px solid rgba(0,0,0,.14); box-shadow:0 18px 44px rgba(0,0,0,.35); }
  .popup > img { width:100%; display:block; }
</style>
<div class="title">${title}</div>
<div class="sub">${sub}</div>
<div class="shot">
  <img src="data:image/png;base64,${b64(shot)}">
  ${popup ? `<div class="popup"><img src="data:image/png;base64,${b64(popup)}"></div>` : ''}
</div>`;
}

async function renderOnce(html, width, height, dsf) {
  const name = `c-${Math.random().toString(36).slice(2)}.html`;
  fs.writeFileSync(path.join(PAGE, name), html);
  const tab = await openTab('about:blank');
  await goto(tab.page, `${BASE}/pages/${name}`, [width, height, dsf]);
  const png = await shoot(tab.page);
  tab.page.ws.close();
  await json(`/json/close/${tab.tab.id}`);
  return png;
}

// 2× 排版 → 落回目标像素：文字比直接按 1× 排更锐利，而 PNG 精确等于商店要求的尺寸
async function render(html, { width, height }) {
  const hi = await renderOnce(html, width, height, 2);
  const down = `<!doctype html><style>html,body{margin:0;overflow:hidden}
    img{display:block;width:${width}px;height:${height}px}</style>
    <img src="data:image/png;base64,${b64(hi)}">`;
  return renderOnce(down, width, height, 1);
}

/* ── 7. 宣传图：440×280 与 1400×560 ───────────────────────── */

const ICON = fs.readFileSync(path.join(ROOT, 'icons/128.png'));

function tile(loc, shot) {
  const L = LOCALES[loc];
  return `<!doctype html><html><meta charset="utf-8">
<style>
  html, body { margin:0; width:440px; height:280px; overflow:hidden; }
  body { background: radial-gradient(520px 300px at 8% -6%, #242432 0%, rgba(36,36,50,0) 60%), #0b0b0c;
         font-family:-apple-system, "PingFang SC", "Helvetica Neue", sans-serif; color:#fafafa; }
  * { box-sizing:border-box; }
  .wrap { padding:28px 24px; width:236px; }
  .icon { width:42px; height:42px; border-radius:11px; display:block; }
  h1 { font-size:24px; margin:12px 0 6px; letter-spacing:-.02em; font-weight:600; }
  p  { font-size:12.5px; line-height:1.55; color:#a0a0aa; margin:0; }
  .peek { position:absolute; right:-42px; top:52px; width:252px; height:176px; border-radius:12px; overflow:hidden;
          border:1px solid rgba(255,255,255,.12); box-shadow:0 22px 46px rgba(0,0,0,.6); transform:rotate(2.4deg); }
  /* 截图比例与格子一致（560×392 → 252×176），整张放入，不裁切 */
  .peek img { width:100%; height:100%; display:block; }
</style>
<div class="wrap">
  <img class="icon" src="data:image/png;base64,${b64(ICON)}">
  <h1>Closer</h1>
  <p>${L.captions[0][0]}</p>
</div>
<div class="peek"><img src="data:image/png;base64,${b64(shot)}"></div>`;
}

function marquee(loc, shot) {
  const L = LOCALES[loc];
  return `<!doctype html><html><meta charset="utf-8">
<style>
  html, body { margin:0; width:1400px; height:560px; overflow:hidden; }
  body { background: radial-gradient(900px 520px at 8% -10%, #242432 0%, rgba(36,36,50,0) 60%),
                      radial-gradient(760px 520px at 100% 112%, #14141a 0%, rgba(20,20,26,0) 62%), #0b0b0c;
         font-family:-apple-system, "PingFang SC", "Helvetica Neue", sans-serif; color:#fafafa; }
  .left { position:absolute; left:70px; top:104px; width:520px; }
  .icon { width:72px; height:72px; border-radius:17px; }
  h1 { font-size:54px; margin:22px 0 12px; letter-spacing:-.03em; font-weight:600; }
  p  { font-size:18px; line-height:1.55; color:#a8a8b2; margin:0 0 24px; }
  ul { margin:0; padding:0; list-style:none; font-size:13.5px; color:#7d7d89; }
  li { margin-bottom:7px; }
  /* 宽高按截图本身的 1.778 走：换成就地裁切会把 1216×684 压扁，照片会变形 */
  .frame { position:absolute; right:-46px; top:36px; width:880px; height:495px; border-radius:14px; overflow:hidden;
           border:1px solid rgba(255,255,255,.1); box-shadow:0 40px 90px rgba(0,0,0,.6); transform:rotate(-1.2deg); }
  .frame img { width:100%; height:100%; display:block; }
</style>
<div class="left">
  <img class="icon" src="data:image/png;base64,${b64(ICON)}">
  <h1>Closer</h1>
  <p>${L.captions[0][0]}</p>
  <ul>
    <li>${L.captions[1][1]}</li>
    <li>${L.captions[4][1]}</li>
    <li>no tracking · no remote code · MIT</li>
  </ul>
</div>
<div class="frame"><img src="data:image/png;base64,${b64(shot)}"></div>`;
}

/* ── 8. 跑 ───────────────────────────────────────────────── */

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const langs = only ? [only] : ['zh', 'en'];
const written = [];

// 内层原图也留一份：排版看着不对时，要能分清「截图错了」还是「画框错了」
const raw = (name, buf) => {
  const dest = path.join(CACHE, 'raw', `${name}.png`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf;
};

const save = (rel, buf) => {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  written.push([rel, buf.length]);
};

const cap = (loc, i) => {
  const [title, sub] = LOCALES[loc].captions[i];
  return { title, sub };
};

for (const loc of langs) {
  const { id: extId, stage } = await loadExtension(loc);
  const tab = await openTab('about:blank');
  const page = tab.page;

  // 先把五个场景都拍下来，再统一组装：组装是纯渲染，跟浏览器里的状态无关，
  // 分开之后「改文案只重排、不改截图」这件事才成立
  const open = raw('open-' + loc, await shotOpen(page, loc));
  const info = raw('info-' + loc, await shotInfo(page, loc));
  const checker = raw('checker-' + loc, await shotChecker(page));
  const { pageShot, popupShot: popupRaw } = await shotPopup(page, loc, extId);
  const popupShot = raw('popup-' + loc, popupRaw);
  const zoom = raw('zoom-' + loc, await shotZoom(page, loc));
  const peek = raw('peek-' + loc, await shotPeek(page, loc));

  save(`screenshots/${loc}/01-open.png`, await render(frame({ ...cap(loc, 0), shot: open }), { width: 1280, height: 800 }));
  save(`screenshots/${loc}/02-info.png`, await render(frame({ ...cap(loc, 1), shot: info }), { width: 1280, height: 800 }));
  save(`screenshots/${loc}/03-checker.png`, await render(frame({ ...cap(loc, 2), shot: checker }), { width: 1280, height: 800 }));
  save(
    `screenshots/${loc}/04-popup.png`,
    await render(frame({ ...cap(loc, 3), shot: pageShot, popup: popupShot }), { width: 1280, height: 800 })
  );
  save(`screenshots/${loc}/05-zoom.png`, await render(frame({ ...cap(loc, 4), shot: zoom }), { width: 1280, height: 800 }));

  // 宣传图：贴一张「已经被放大过」的图，才看得出这是查看器而不是一张照片
  save(`promo/tile-440x280-${loc}.png`, await render(tile(loc, peek), { width: 440, height: 280 }));
  save(`promo/marquee-1400x560-${loc}.png`, await render(marquee(loc, info), { width: 1400, height: 560 }));

  page.ws.close();
  await json(`/json/close/${tab.tab.id}`);
  const b2 = connect((await json('/json/version')).webSocketDebuggerUrl);
  await b2.ready;
  await b2.send('Extensions.uninstall', { id: extId });
  b2.ws.close();
  fs.rmSync(stage, { recursive: true, force: true });
}

server.close();

console.log('');
for (const [rel, size] of written) console.log(`✓ store/${rel}  ${(size / 1024).toFixed(1)} KB`);
console.log(`\n${written.length} 个文件 → ${path.relative(ROOT, OUT)}/`);

// 必须显式退出：车道的 Chrome 是本进程的子进程，它的句柄会让事件循环不结束，
// 而收尾（杀掉 Chrome、删临时目录）挂在 `process.on('exit')` 上——不退出就等不到收尾。
// 少了这一行，脚本会把每个跑完的进程连同它的浏览器一起留在后台（实测挂了三个）。
process.exit(0);
