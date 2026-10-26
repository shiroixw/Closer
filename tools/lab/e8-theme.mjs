// E8 — 背景主题的回归。
//
// 用真实的未打包扩展，把 prefs.backdrop 分别设成 dark / light / checker，
// 各开一次 overlay，读出 host 的 class 与 backdrop 的 computed background。
// 断言的是「看到的那块底色」，不是「有没有设类名」——两者能分家，正是当初
// 背板透明那个 bug 的形态。
//
// 页面用本地桩，不依赖外网站点：真实站点上图片解码与否取决于网络，
// 而这个测试要回答的是主题，不是网络。想对着真实站点诊断就设 TARGET。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import zlib from 'node:zlib';
import { clean } from './clean-extensions.mjs';

import { CDP } from './browser.mjs'; // 默认 headless，不抢焦点；CDP=… 可覆盖
const PORT = 8833;
const ROOT = path.resolve(import.meta.dirname, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 造图（与 e7 同一套最小 PNG 编码器） ---------- */

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
      raw[o] = 70 + (x % 90);
      raw[o + 1] = 110;
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

const IMG = png(600, 450);

// 四张图：decoded() 要求超过三张解码，也顺带证明「一张看腻了换一张」的场景成立
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>theme</title>
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

const STUB_URL = `http://127.0.0.1:${PORT}/`;

const stage = path.join(os.tmpdir(), 'closer-theme');
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
manifest.host_permissions = ['*://*/*'];
delete manifest.optional_host_permissions;
fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));

async function json(p, init) {
  const res = await fetch(CDP + p, init);
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
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

/* 用扩展自己的 popup 页面改偏好——那是唯一能直接摸到 storage 的地方 */
const setPrefs = async (prefs) => {
  const tab = await json(`/json/new?${encodeURIComponent(`chrome-extension://${extId}/ui/popup.html`)}`, { method: 'PUT' });
  const p = connect(tab.webSocketDebuggerUrl);
  await p.ready;
  await p.send('Runtime.enable');
  await p.send('Runtime.evaluate', {
    expression: `chrome.storage.local.set({ 'closer:prefs': ${JSON.stringify(prefs)} })`,
    awaitPromise: true,
  });
  p.ws.close();
  await json(`/json/close/${tab.id}`);
};

const url = process.env.TARGET || STUB_URL;
const tab = await json(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
const page = connect(tab.webSocketDebuggerUrl);
await page.ready;
await page.send('Runtime.enable');
await page.send('Page.enable');
// 固定视口：本测试靠点击命中几何，窗口一旦被缩小，600×450 的图放不下、
// pickOnce 会把它全部过滤掉，然后报「页面里没有可点的图」。
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

const evaluate = async (expression) => {
  const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description };
  return r?.result?.result?.value;
};

// 等「已解码」而不是「已存在」：懒加载页面上 images.length 早就够了，
// naturalWidth 还是 0，这时候点下去什么都不会发生。
const decoded = () =>
  evaluate(`(() => {
    if (document.readyState !== 'complete') return false;
    return Array.from(document.images).filter((i) => i.naturalWidth > 0).length > 3;
  })()`);

for (let i = 0; i < 40; i++) {
  if ((await decoded()) === true) break;
  await sleep(250);
}
await sleep(500);

const clickAt = async (x, y) => {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

const pick = async () => {
  for (let i = 0; i < 30; i++) {
    const spot = await pickOnce();
    if (spot) return spot;
    await sleep(300);
  }
  return null;
};

const pickOnce = () =>
  evaluate(`(() => {
    const all = Array.from(document.images);
    for (const im of all) {
      if (im.naturalWidth < 400 || im.naturalHeight < 400) continue;
      if (im.closest('a')) continue;
      im.scrollIntoView({ block: 'center' });
      const r = im.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) continue;
      // scrollIntoView 不保证在同一个任务里落地；落在视口外就下一轮再说，
      // 否则会朝一个空位置派发 click，然后报「overlay 没打开」。
      if (r.top < 8 || r.bottom > innerHeight - 8) continue;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), nw: im.naturalWidth, nh: im.naturalHeight };
    }
    return null;
  })()`);

const inspect = () =>
  evaluate(`(() => {
    const host = document.getElementById('closer');
    if (!host) return null;
    const sr = host.shadowRoot;
    const bd = sr.querySelector('.backdrop');
    const cs = getComputedStyle(bd);
    const bar = sr.querySelector('.act.close');
    const bcs = getComputedStyle(bar);
    return {
      hostClass: host.className,
      bg: cs.backgroundColor,
      img: cs.backgroundImage.slice(0, 40),
      opacity: cs.opacity,
      barBg: bcs.backgroundColor,
      barColor: bcs.color,
      rect: (() => { const r = bd.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    };
  })()`);

const report = [];
const check = (name, ok, detail) => report.push({ name, ok: !!ok, detail });

// 「浅色」是半透明浅黑，不是白：纯白背板在暗环境里刺眼，也把页面整个埋掉
const LIGHT_BG = 'rgba(24, 24, 27, 0.55)';

const THEMES = (process.env.ONLY || 'dark,light,checker').split(',');
for (const want of THEMES) {
  await setPrefs({ backdrop: want });
  await sleep(250);
  await page.send('Page.bringToFront'); // setPrefs 开的 popup 页把标签页挤到后台，后台不解码懒加载图
  await page.send('Page.reload');
  await sleep(1200);
  for (let i = 0; i < 40; i++) {
    if ((await decoded()) === true) break;
    await sleep(250);
  }
  await sleep(400);

  const spot = await pick();
  if (!spot) {
    const stat = await evaluate("JSON.stringify({ total: document.images.length, decoded: Array.from(document.images).filter(i => i.naturalWidth > 0).length, ready: document.readyState, url: location.href.slice(0, 80) })");
    check(`${want}: 找到候选图`, false, '页面里没有可点的图 ' + stat);
    continue;
  }
  await clickAt(spot.x, spot.y);
  await sleep(500);

  const st = await inspect();
  if (!st) {
    check(`${want}: overlay 打开`, false, '没有 #closer');
    continue;
  }

  const expect = { dark: 'rgb(11, 11, 12)', light: LIGHT_BG, checker: 'rgb(255, 255, 255)' }[want];
  check(`${want}: host 类名`, st.hostClass === want, `class="${st.hostClass}"`);
  check(`${want}: 背板底色`, st.bg === expect, `实际 ${st.bg}，期望 ${expect}`);
  check(`${want}: 背板铺满`, st.rect[0] === (await evaluate('innerWidth')) && st.rect[1] === (await evaluate('innerHeight')), `${st.rect}`);

  // 面板配色必须跟着主题走：按钮在浅色档翻成白底深字，卡片还是黑的，就是两套语言
  const panel = await evaluate(`(() => {
    const sr = document.getElementById('closer').shadowRoot;
    sr.querySelector('.info').click();
    const p = sr.querySelector('.panel');
    const cs = getComputedStyle(p);
    return {
      open: !p.hidden,
      bg: cs.backgroundColor,
      color: cs.color,
      sub: getComputedStyle(sr.querySelector('.ratio')).color,
    };
  })()`);
  const PANEL = {
    dark: { bg: 'rgba(24, 24, 27, 0.86)', color: 'rgb(245, 245, 245)', sub: 'rgb(161, 161, 170)' },
    light: { bg: 'rgba(255, 255, 255, 0.92)', color: 'rgb(24, 24, 27)', sub: 'rgb(82, 82, 91)' },
    checker: { bg: 'rgba(24, 24, 27, 0.86)', color: 'rgb(245, 245, 245)', sub: 'rgb(161, 161, 170)' },
  }[want];
  check(`${want}: ⓘ 面板能展开`, panel?.open === true);
  check(`${want}: 面板底色跟着主题`, panel?.bg === PANEL.bg, `实际 ${panel?.bg}，期望 ${PANEL.bg}`);
  check(
    `${want}: 面板文字跟着主题`,
    panel?.color === PANEL.color && panel?.sub === PANEL.sub,
    `${panel?.color} / ${panel?.sub}`
  );

  const esc = async () => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  };
  await esc(); // 先收面板
  await sleep(200);
  check(`${want}: Esc 先收面板、overlay 还在`, (await evaluate("!!document.getElementById('closer')")) === true);
  await esc(); // 再关 overlay
  await sleep(450);
  check(`${want}: Esc 后已关闭`, (await evaluate("!document.getElementById('closer')")) === true);
}

/* 再验一次「换主题不重启页面」的路径：B 键循环 */
await setPrefs({ backdrop: 'dark' });
await page.send('Page.bringToFront');
await page.send('Page.reload');
await sleep(1200);
for (let i = 0; i < 40; i++) {
  if ((await decoded()) === true) break;
  await sleep(250);
}
await sleep(400);
const spot = await pick();
if (spot) {
  await clickAt(spot.x, spot.y);
  await sleep(500);
  const before = await inspect();
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66 });
  await sleep(250);
  const after = await inspect();
  check('B 键：dark → light', after?.bg === LIGHT_BG, `${before?.bg} → ${after?.bg}`);
}

page.ws.close();
await json(`/json/close/${tab.id}`);
await browser.ready;
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
