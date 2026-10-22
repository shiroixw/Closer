// E10 — 站点自己的查看器开着时，点击里面的图不该被我们再接管一层。
//
// 报告里的形态：文章里点缩略图 → 站点弹出全屏遮罩（fixed + 原图居中 + 锁滚动），
// 再点遮罩里那张图 → 我们也弹一层，两张查看器叠着。
//
// 为什么让位检测没拦住：acted() 看的是「这一下点击有没有被页面消费」，是增量。
// 第二次点击时查看器早就开好了，点击前后 href / 全屏 / 命中点元素 / 滚动锁
// 四项一模一样，全部沉默——连站点自己的缩放在判据里都看不见，因为命中点
// 比的是元素身份，transform 不改变元素。
//
// 修法不是加阈值去猜「这像不像查看器」，而是让「页面接管了」这个观测有寿命：
// 页面出手的那一刻记下它多出来的那一层（Closer.state.shell），后续点击只要还
// 在那层里就继续让位；层被卸载即忘掉。所以下面每条断言都只问「叠没叠」。
//
// 六个场景，两个本地页：
//   plain    普通文章图，无处理器          → 我们开（环境 sanity）
//   static   站点查看器，点图无动作        → 第二次点击不接管
//   zoom     站点查看器，点图放大到 1.4    → 第二次点击不接管，站点缩放生效
//   zoomout  站点查看器，点图缩到 0.35     → 缩到再小也不接管（与尺寸无关）
//   sibling  遮罩与图并列（知乎形态）      → 缩小那一下不接管（cases 009）
//   shell    app 外壳（fixed 全屏）+ 小缩略图 → 照常打开（不整站失效）
//
// 页面用 http://127.0.0.1 提供：扩展的 matches 是 *://*/*，file:// 不在其中。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import zlib from 'node:zlib';
import { clean } from './clean-extensions.mjs';

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const PORT = 8832;
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

/* ---------- 页面 ---------- */

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>stacked viewer lab</title>
<style>
  body { margin: 0; padding: 30px; background: #fafafa; font: 13px system-ui; }
  .case { margin-bottom: 28px; }
  .case img { width: 420px; display: block; }
  /* 站点自己的查看器：fixed 全屏遮罩，图按原尺寸居中（真实站点几乎都长这样）。 */
  .viewer { position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,.93);
    display: grid; place-items: center; }
  .viewer img { max-width: 90vw; max-height: 85vh; width: auto; height: auto; }
  /* 知乎形态：遮罩与图都挂在 <body> 下，是兄弟而不是祖先；图不盖住视口，也不锁滚动。 */
  .sib-backdrop { position: fixed; inset: 0; z-index: 99998; background: rgba(14,15,15,.65); }
  .sib-photo { position: absolute; left: 50%; top: 50%; width: 620px; z-index: 99999;
    cursor: zoom-out; transform: translate(-50%,-50%) scale(1.4); transition: transform 300ms ease; }
  h3 { font-size: 13px; color: #666; margin: 0 0 6px; }
</style>

<div class="case"><h3>plain — 没有处理器</h3><img id="plain" src="/photo.png" alt="plain"></div>
<div class="case"><h3>static — 站点查看器，点图无动作</h3><img id="static" src="/photo.png" alt="static"></div>
<div class="case"><h3>zoom — 站点查看器，点图放大</h3><img id="zoom" src="/photo.png" alt="zoom"></div>
<div class="case"><h3>zoomout — 站点查看器，点图缩小</h3><img id="zoomout" src="/photo.png" alt="zoomout"></div>
<div class="case"><h3>sibling — 遮罩与图并列，图不盖住视口（知乎形态）</h3><img id="sib" src="/photo.png" alt="sib"></div>

<script>
function openViewer() {
  const d = document.createElement('div');
  d.className = 'viewer';
  const im = document.createElement('img');
  im.id = 'big';
  im.src = '/photo.png';
  d.appendChild(im);
  document.body.appendChild(d);
  document.body.style.overflow = 'hidden'; // 真实查看器几乎都会锁滚动
  return im;
}

// 站点自己的缩放：只改 transform，元素身份不变——命中点判据看不见它。
function zoomOn(im, to) {
  let z = 1;
  im.addEventListener('click', () => {
    z = z === 1 ? to : 1;
    im.style.transform = 'scale(' + z + ')';
  });
}

// 知乎形态：遮罩与图都挂在 <body> 下，是兄弟而不是祖先。两个细节照真实站点抄：
//   1. 遮罩不包着图 —— remember() 要求「覆盖 90% 视口的祖先」，在这里落空；
//   2. 改写 style 的那一下排在**我们判定之后**（同一个任务里后注册的 rAF）——
//      skin 判据因此总是晚一步，只剩 cursor: zoom-out 这份存量证据可用（cases 009）。
function openSiblingViewer() {
  const bd = document.createElement('div');
  bd.className = 'sib-backdrop';
  const im = document.createElement('img');
  im.className = 'sib-photo';
  im.src = '/photo.png';
  document.body.append(bd, im);
  im.addEventListener('click', () => {
    window.__sibShrink = true;
    requestAnimationFrame(() => {
      im.style.transform = 'translate(-50%,-50%) scale(1)';
      setTimeout(() => { bd.remove(); im.remove(); }, 300);
    });
  });
  return im;
}

document.getElementById('static').addEventListener('click', () => { openViewer(); });
document.getElementById('zoom').addEventListener('click', () => { zoomOn(openViewer(), 1.4); });
document.getElementById('zoomout').addEventListener('click', () => { zoomOn(openViewer(), 0.35); });
document.getElementById('sib').addEventListener('click', () => {
  // 知乎打开查看器时会把被点的缩略图设成 visibility:hidden。于是第一次放大走的是
  // skin 判据（不是 hit），而 skin 那条分支没有层可记 —— 桩页必须复刻这一点，
  // 否则 B2 测不出「skin 不落账」那个缺口，只会在真机上第一次缩小才翻车。
  document.getElementById('sib').style.visibility = 'hidden';
  openSiblingViewer();
});
</script>`;

// app 外壳：整站内容躺在一个 fixed 全屏容器里，图只是里面一个小缩略图。
// 只看「有没有 fixed 全屏祖先」会把这类站点整站关掉，所以它必须仍然打开。
const SHELL_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>app shell lab</title>
<style>
  body { margin: 0; }
  .shell { position: fixed; inset: 0; background: #fff; }
  .shell img { width: 150px; display: block; margin: 40px; }
</style>
<div class="shell"><img id="thumb" src="/photo.png" alt="thumb"></div>`;

const server = http
  .createServer((req, res) => {
    if (req.url.startsWith('/photo.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length, 'cache-control': 'no-store' });
      return res.end(PNG);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/shell') ? SHELL_PAGE : PAGE);
  })
  .listen(PORT, '127.0.0.1');

/* ---------- 装扩展 ---------- */

const stage = path.join(os.tmpdir(), 'closer-stacked');
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
  server.close();
  process.exit(1);
}
await sleep(900);

/* ---------- 跑场景 ---------- */

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

const pageUrl = `http://127.0.0.1:${PORT}/`;
const shellUrl = `http://127.0.0.1:${PORT}/shell`;
const tab = await json(`/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' });
const page = connect(tab.webSocketDebuggerUrl);
await page.ready;
await page.send('Runtime.enable');
await page.send('Page.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

const ev = async (expr) => {
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.result?.value;
};

async function go(url, ready) {
  await page.send('Page.navigate', { url });
  for (let i = 0; i < 40; i++) {
    if ((await ev(`document.readyState === 'complete' && ${ready}`)) === true) break;
    await sleep(100);
  }
  await sleep(350);
}

async function spotOf(selector) {
  const spot = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await sleep(120);
  return spot;
}

async function clickAt(spot) {
  if (!spot) return;
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
}

async function closeOurs() {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
}

const has = () => ev("!!document.getElementById('closer')");
const hasViewer = () => ev("!!document.querySelector('.viewer')");
const viewerScale = () => ev("document.querySelector('.viewer img')?.style.transform || ''");

/* --- plain：环境 sanity --- */

await go(pageUrl, "!!document.getElementById('plain')");
await clickAt(await spotOf('#plain'));
await sleep(600);
check('P1 普通文章图：我们打开', (await has()) === true);
await closeOurs();

/* --- 站点查看器：static / zoom / zoomout --- */

for (const [id, label, wantScale] of [
  ['static', 'S', ''],
  ['zoom', 'Z', 'scale(1.4)'],
  ['zoomout', 'O', 'scale(0.35)'],
]) {
  await go(pageUrl, "!!document.getElementById('plain')");

  // 第一次点击：站点自己开查看器，我们让位
  await clickAt(await spotOf('#' + id));
  await sleep(700);
  const theirViewer = await hasViewer();
  const oursAfterFirst = await has();
  check(`${label}1 站点查看器打开、我们让位（第一次点击）`, theirViewer === true && oursAfterFirst === false,
    `viewer=${theirViewer} ours=${oursAfterFirst}`);

  // 第二次点击：点在站点查看器里那张图上
  await clickAt(await spotOf('.viewer img'));
  await sleep(700);
  const ours = await has();
  const scale = await viewerScale();
  check(`${label}2 查看器里再点一次：不接管`, ours === false, `ours=${ours}`);
  if (wantScale) {
    check(`${label}3 站点自己的缩放仍然生效`, scale === wantScale, `transform=${scale || '-'}`);
  }

  if (id === 'static') {
    // 自愈：查看器关掉之后，我们应当恢复接管
    await ev("(() => { document.querySelector('.viewer')?.remove(); document.body.style.overflow = ''; })()");
    await sleep(200);
    await clickAt(await spotOf('#plain'));
    await sleep(600);
    check('S4 站点查看器关掉后：恢复打开（状态自愈）', (await has()) === true);
    await closeOurs();
  }
}

/* --- 兄弟遮罩：遮罩与图并列（知乎形态，cases 009） --- */

await go(pageUrl, "!!document.getElementById('sib')");
await ev('window.__sibShrink = false');
await clickAt(await spotOf('#sib'));
await sleep(700);
const sibViewer = await ev("!!document.querySelector('.sib-photo')");
const sibOurs = await has();
check('B1 兄弟遮罩的查看器：第一次点击我们让位', sibViewer === true && sibOurs === false,
  `viewer=${sibViewer} ours=${sibOurs}`);

// 缩小那一下：元素身份不变、style 也在我们判定之后才写，四判据 + skin 全哑。
// shell 同样记不下来（遮罩是兄弟），只剩 cursor: zoom-out 兜住这一下。
await clickAt(await spotOf('.sib-photo'));
await sleep(260);
check('B2 查看器里点一下（缩小）：不接管', (await has()) === false);

await sleep(700);
const shrunk = await ev('window.__sibShrink === true');
const gone = await ev("!document.querySelector('.sib-photo')");
check('B3 站点自己的缩小生效，查看器随后卸载', shrunk === true && gone === true, `shrunk=${shrunk} gone=${gone}`);
check('B4 缩小之后仍然不接管（没有迟到闪烁）', (await has()) === false);

await clickAt(await spotOf('#plain'));
await sleep(600);
check('B5 查看器关掉后：普通图照常打开（存量判据不整站失效）', (await has()) === true);
await closeOurs();

/* --- app 外壳：fixed 全屏容器里的小缩略图 --- */

await go(shellUrl, "!!document.getElementById('thumb')");
await clickAt(await spotOf('#thumb'));
await sleep(600);
check('A1 app 外壳里的缩略图：照常打开（不整站失效）', (await has()) === true);
await closeOurs();

/* ---------- 收尾 ---------- */

page.ws.close();
await json(`/json/close/${tab.id}`).catch(() => {});
const tabs = await json('/json/list');
for (const t of tabs || []) {
  if (t.url && t.url.includes(extId)) await json(`/json/close/${t.id}`).catch(() => {});
}
await uninstall(extId);
await clean(CDP, { quiet: true });
fs.rmSync(stage, { recursive: true, force: true });
server.close();

const pad = (s) => s + ' '.repeat(Math.max(0, 42 - [...s].length));
console.log(`\n叠层查看器回归 · ${pageUrl}\n扩展 ${extId}（临时副本）\n`);
let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? '✓' : '✗'} ${pad(c.name)} ${c.detail}`);
}
console.log(`\n${checks.length - bad}/${checks.length} 通过`);
process.exit(bad ? 1 : 0);
