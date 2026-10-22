// E5 — 真机回归。不是桩环境，是真正的未打包扩展 + 真实网页。
//
// 桩测（e4-overlay）验证的是「代码逻辑对不对」，这一层验证的是
// 「扩展在真实权限、真实 content script、真实网络下能不能活」。
//
// 做法：把仓库复制到临时目录，把 host 权限改成声明式（自动化没法点授权弹窗），
// 再用 CDP 的 Extensions.loadUnpacked 装进去。源码不动。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { clean } from './clean-extensions.mjs';

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const TARGET = process.env.TARGET || 'https://www.ruanyifeng.com/blog/2026/10/weekly-issue-415.html';
const ROOT = path.resolve(import.meta.dirname, '../..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 准备测试副本 ---------- */

// 固定路径是刻意的：unpacked 扩展的 id 由路径决定，用 mkdtemp 每跑一次
// 就多一个永久残留的扩展实例（曾堆到 8 个，把 e4 的桩测试搞挂了）。
const stage = path.join(os.tmpdir(), 'closer-live');
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

const manifestPath = path.join(stage, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = ['*://*/*'];
delete manifest.optional_host_permissions;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

/* ---------- CDP ---------- */

async function json(pathname, init) {
  const res = await fetch(CDP + pathname, init);
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
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  return { ws, send, ready };
}

/* ---------- 加载扩展 ---------- */

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
  console.error('扩展加载失败：', JSON.stringify(loaded));
  process.exit(1);
}

// 给 service worker 时间去注册 content script
await sleep(900);

/* ---------- 打开被测页面 ---------- */

const tab = await json(`/json/new?${encodeURIComponent(TARGET)}`, { method: 'PUT' });
if (!tab.webSocketDebuggerUrl) {
  console.error('开标签页失败：', tab);
  process.exit(1);
}

const page = connect(tab.webSocketDebuggerUrl);
await page.ready;
await page.send('Runtime.enable');
await page.send('Page.enable');
// 钉住视口：本测试断言的是几何（适应后是否溢出、居中），
// 窗口尺寸在测试期间会变，不钉住就会出现「图片右边超出 9px」这种与环境有关的假红。
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

const evaluate = async (expression, userGesture = false) => {
  const r = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture,
  });
  if (r?.result?.exceptionDetails) {
    return { __error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
  }
  return r?.result?.result?.value;
};

// 等页面基本就绪
for (let i = 0; i < 40; i++) {
  const ready = await evaluate("document.readyState === 'complete' && document.images.length > 5");
  if (ready === true) break;
  await sleep(250);
}
await sleep(400);

/* ---------- 断言 ---------- */

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

const hasOverlay = () => evaluate("!!document.getElementById('closer')");

const overlayState = () =>
  evaluate(`(() => {
    const host = document.getElementById('closer');
    if (!host) return null;
    const sr = host.shadowRoot;
    const photo = sr.querySelector('.photo');
    const panel = sr.querySelector('.panel');
    const rect = photo.getBoundingClientRect();
    return {
      transform: photo.style.transform,
      width: photo.style.width,
      height: photo.style.height,
      src: photo.getAttribute('src'),
      panelHidden: panel.hidden,
      dims: sr.querySelector('.dims').textContent,
      shown: sr.querySelector('.shown').hidden ? '' : sr.querySelector('.shown').textContent,
      ratio: sr.querySelector('.ratio').textContent,
      size: sr.querySelector('.size').hidden ? '' : sr.querySelector('.size').textContent,
      pause: sr.querySelector('.pause').textContent,
      photoRect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      vw: innerWidth,
      vh: innerHeight,
    };
  })()`);

async function clickAt(x, y, clickCount = 1) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
}

async function key(k, code, vk) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

async function wheel(x, y, deltaY) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
}

/** 找一张「够大、不在链接里」的图，返回它的屏幕坐标 */
async function pickImage(minSide = 400) {
  const shot = await evaluate(`(() => {
    const all = Array.from(document.images);
    for (let i = 0; i < all.length; i++) {
      const im = all[i];
      if (im.naturalWidth < ${minSide} || im.naturalHeight < ${minSide}) continue;
      if (im.closest('a')) continue;
      im.scrollIntoView({ block: 'center' });
      const r = im.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) continue;
      return {
        found: {
          index: i,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          nw: im.naturalWidth,
          nh: im.naturalHeight,
          drawn: { w: Math.round(r.width), h: Math.round(r.height) },
          src: (im.currentSrc || im.src || '').split('/').pop().slice(0, 40),
        },
        total: all.length,
        decoded: all.filter((x) => x.naturalWidth > 0).length,
      };
    }
    return {
      found: null,
      total: all.length,
      decoded: all.filter((x) => x.naturalWidth > 0).length,
      ready: document.readyState,
      vw: innerWidth,
      vh: innerHeight,
    };
  })()`);

  if (!shot || shot.__error) {
    console.error('探测图片失败：', shot);
    return null;
  }
  if (!shot.found) {
    console.error('页面图片统计：', JSON.stringify(shot));
    return null;
  }
  return shot.found;
}

async function pickSmallImage() {
  return evaluate(`(() => {
    for (let i = document.images.length - 1; i >= 0; i--) {
      const im = document.images[i];
      if (im.naturalWidth && im.naturalWidth < 200 && im.naturalHeight < 200) {
        im.scrollIntoView({ block: 'center' });
        const r = im.getBoundingClientRect();
        if (r.width < 20) continue;
        return {
          index: i,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          nw: im.naturalWidth,
          nh: im.naturalHeight,
        };
      }
    }
    return null;
  })()`);
}

/* --- A. 注入与不打扰 --- */

const domBefore = await evaluate('document.documentElement.outerHTML.length');
// 不拿整页长度当判据：真实站点上第三方脚本随时会改 DOM
// （实测评论区被挂了 style="!important"，凭空多 19 字符，却和我们无关）。
// 判据指向我们自己的责任范围；「逐字节还原」由 e4 在可控桩页面验。
const RESIDUE = `(() => {
  const de = document.documentElement;
  return JSON.stringify({
    cls: de.getAttribute('class'),
    style: de.getAttribute('style'),
    htmlKids: de.children.length,
  });
})()`;
const residueBefore = await evaluate(RESIDUE);

check('A1 未点击时不注入任何节点', (await hasOverlay()) === false);

// 点正文段落：不该有任何反应
const para = await evaluate(`(() => {
  const p = document.querySelector('p');
  if (!p) return null;
  p.scrollIntoView({ block: 'center' });
  const r = p.getBoundingClientRect();
  return { x: Math.round(r.left + 20), y: Math.round(r.top + 10) };
})()`);
if (para) {
  await clickAt(para.x, para.y);
  await sleep(250);
}
check('A2 点正文什么都不发生', (await hasOverlay()) === false);

// 点小图（二维码一类）：judge 该否掉
const small = await pickSmallImage();
if (small) {
  await clickAt(small.x, small.y);
  await sleep(300);
  check(`A3 点 ${small.nw}×${small.nh} 小图不打开`, (await hasOverlay()) === false, `#${small.index}`);
} else {
  check('A3 点小图不打开', true, '页面没有小图，跳过');
}

/* --- B. 打开 --- */

const pick = await pickImage();
if (!pick) {
  console.error('页面上没有可用的测试图，退出');
  process.exit(1);
}

await sleep(150);
const t0 = Date.now();
await clickAt(pick.x, pick.y);

let opened = false;
for (let i = 0; i < 20; i++) {
  if (await hasOverlay()) {
    opened = true;
    break;
  }
  await sleep(16);
}
const openMs = Date.now() - t0;

check(`B1 点 ${pick.nw}×${pick.nh} 的图打开 overlay`, opened, `${openMs} ms`);
check('B2 点击到出现 < 100 ms', openMs < 100, `${openMs} ms`);

await sleep(320); // 等 FLIP 动画结束
const st = await overlayState();

if (st) {
  check('B3 图片元素尺寸等于原图', st.width === `${pick.nw}px` && st.height === `${pick.nh}px`, `${st.width} × ${st.height}`);
  check('B4 transform 已应用', /scale\(/.test(st.transform || ''), st.transform);

  const m = /scale\(([\d.]+)\)/.exec(st.transform || '');
  const s = m ? Number(m[1]) : 0;
  const fit = Math.min((st.vw * 0.94) / pick.nw, (st.vh * 0.94) / pick.nh, 4);
  check('B5 初始为适应屏幕', Math.abs(s - fit) < 0.02, `s=${s.toFixed(3)} fit=${fit.toFixed(3)}`);

  // 适应后不越界
  const r = st.photoRect;
  check(
    'B6 适应后完整在视口内',
    r.x >= -1 && r.y >= -1 && r.x + r.w <= st.vw + 1 && r.y + r.h <= st.vh + 1,
    `${r.w}×${r.h} @ ${r.x},${r.y} / ${st.vw}×${st.vh}`
  );

  check('B7 面板默认收起', st.panelHidden === true);
  check('B8 面板尺寸行正确', st.dims === `${pick.nw} × ${pick.nh}`, st.dims);

  /* --- C. 面板与动作 --- */

  await evaluate("document.getElementById('closer').shadowRoot.querySelector('.info').click()");
  await sleep(220);
  const panelState = await overlayState();
  check('C1 ⓘ 能展开面板', panelState.panelHidden === false);
  check('C2 面板比例行有内容', !!panelState.ratio, panelState.ratio);
  check('C3 面板格式行', /[A-Z]{2,5}/.test(panelState.size || ''), panelState.size || '（空）');

  // 体积是异步来的（先试 performance 条目，再走 SW）。轮询等它到位，
  // 顺便量出「面板先少一行、稍后补上」的延迟——这是真实的体验成本。
  let sizeText = panelState.size || '';
  let waited = 0;
  for (let i = 0; i < 30; i++) {
    if (/\d\s?(B|KB|MB)$/.test(sizeText.trim())) break;
    await sleep(100);
    waited += 100;
    sizeText = (await overlayState())?.size || '';
  }
  check('C5 面板体积行最终有数字', /\d\s?(B|KB|MB)$/.test(sizeText.trim()), `${sizeText || '（空）'} · 等 ${waited} ms`);
  // 文案跟着浏览器语言走（D29），所以判据是「站点名出现在按钮上」，而不是某个英文原句
  check('C4 面板里的暂停按钮认得出当前站点', /127\.0\.0\.1/.test(panelState.pause || ''), panelState.pause);

  await evaluate("document.getElementById('closer').shadowRoot.querySelector('.info').click()");
  await sleep(150);

  /* --- D. 缩放 --- */

  const before = Number(/scale\(([\d.]+)\)/.exec((await overlayState()).transform)[1]);
  await wheel(pick.x, pick.y, -240);
  await sleep(120);
  const afterWheel = Number(/scale\(([\d.]+)\)/.exec((await overlayState()).transform)[1]);
  check('D1 滚轮向上放大', afterWheel > before, `${before.toFixed(3)} → ${afterWheel.toFixed(3)}`);

  await wheel(pick.x, pick.y, 240);
  await sleep(120);
  const afterBack = Number(/scale\(([\d.]+)\)/.exec((await overlayState()).transform)[1]);
  check('D2 滚轮向下缩小', afterBack < afterWheel, `${afterWheel.toFixed(3)} → ${afterBack.toFixed(3)}`);

  await key('0', 'Digit0', 48);
  await sleep(260);
  const afterZero = await overlayState();
  const s0 = Number(/scale\(([\d.]+)\)/.exec(afterZero.transform)[1]);
  check('D3 按 0 回到适应', Math.abs(s0 - fit) < 0.02, `s=${s0.toFixed(3)}`);

  await key('1', 'Digit1', 49);
  await sleep(260);
  const afterOne = await overlayState();
  const s1 = Number(/scale\(([\d.]+)\)/.exec(afterOne.transform)[1]);
  check('D4 按 1 回到 100%', Math.abs(s1 - 1) < 0.02, `s=${s1.toFixed(3)}`);

  /* --- E. 旋转 --- */

  await key('r', 'KeyR', 82);
  await sleep(260);
  const rotated = await overlayState();
  check('E1 按 R 旋转 90°', /rotate\(90deg\)/.test(rotated.transform), rotated.transform);

  const rr = rotated.photoRect;
  check(
    'E2 旋转后不溢出视口',
    rr.x >= -1 && rr.y >= -1 && rr.x + rr.w <= rotated.vw + 1 && rr.y + rr.h <= rotated.vh + 1,
    `${rr.w}×${rr.h} @ ${rr.x},${rr.y}`
  );

  /* --- F. 关闭与页面还原 --- */

  await key('Escape', 'Escape', 27);
  await sleep(400);

  check('F1 Esc 关闭 overlay', (await hasOverlay()) === false);

  const residueAfter = await evaluate(RESIDUE);
  const domAfter = await evaluate('document.documentElement.outerHTML.length');

  check('F2 关闭后没有 Closer 的残留', residueAfter === residueBefore, residueAfter === residueBefore ? 'html 属性与子节点数未变' : `${residueBefore} → ${residueAfter}`);
  check('F2b 关闭后整页长度没有明显增长', domAfter - domBefore < 200, `${domBefore} → ${domAfter}（站点自身可能微增）`);
}

/* ---------- 收尾 ---------- */

page.ws.close();
await json(`/json/close/${tab.id}`).catch(() => {});

// 关掉 onInstalled 自动打开的 welcome 页
const tabs = await json('/json/list');
for (const t of tabs || []) {
  if (t.url && t.url.includes(extId)) await json(`/json/close/${t.id}`).catch(() => {});
}

if (process.env.KEEP === '1') {
  console.log('\n保留测试环境：', stage, '（扩展未卸载）');
} else {
  await uninstall(extId);
  fs.rmSync(stage, { recursive: true, force: true });
}

/* ---------- 报告 ---------- */

const name = (s) => s + ' '.repeat(Math.max(0, 30 - [...s].length));
console.log(`\n真机回归 · ${TARGET}\n扩展 ${extId}（临时副本，源码未改）\n`);

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? '✓' : '✗'} ${name(c.name)} ${c.detail}`);
}
console.log(`\n${checks.length - bad}/${checks.length} 通过`);
if (bad) {
  console.log('\n失败项：');
  for (const c of checks.filter((x) => !x.ok)) console.log(`  ✗ ${c.name} — ${c.detail}`);
}
process.exit(bad ? 1 : 0);
