// E11 — 上架物本身装得上。
//
// 前面十条测的都是仓库根（临时副本 + 声明式 host 权限）。而真正上传到商店的，是
// `tools/pack.mjs` 那 24 个文件。清单只证明「文件齐」，装一次才证明「齐得够用」——
// 少一个 `ui/i18n.js`、少一种语言包、少一个被 `<link>` 引用的 css，
// 都不会让 `pack --check` 失败（它是从引用推的），但会让扩展在用户机器上少一块。
//
// 所以这里不复制仓库，只复制清单；然后问 Chrome 四件事：
//   G1 Chrome 收下这个包
//   G2 welcome 与 popup 都渲染出文案（_locales / ui/i18n.js / ui.css 一个不缺）
//   G3 未授权时不注册任何 content script（D6：装完什么都不做）
//   G4 打开这两个页面的全程没有一条 error 级日志（少文件通常就报在这里）
//
// 用法：node tools/lab/e11-package.mjs（默认 headless 车道，见 browser.mjs）

import fs from 'node:fs';
import path from 'node:path';
import { resolveEntries } from '../pack.mjs';
import { CDP, stageDir } from './browser.mjs'; // 车道：本进程独占的 headless 与私有暂存目录

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 只把「要发布的那一段」铺到暂存目录 ---------- */

const { entries, errors } = resolveEntries();
if (errors.length) {
  console.error('发布清单不成立，先修它：\n  - ' + errors.join('\n  - '));
  process.exit(1);
}

const stage = stageDir('packed');
for (const rel of entries) {
  const dest = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(path.resolve(import.meta.dirname, '../..'), rel), dest);
}

/* ---------- CDP ---------- */

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
  const notes = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      notes.push(m.params.entry.text || m.params.entry.url || 'log error');
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails;
      notes.push(d?.exception?.description || d?.text || 'exception');
    }
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
  return { ws, send, ready, notes };
}

const report = [];
const check = (name, ok, detail) => report.push({ name, ok: !!ok, detail });

/* ---------- G1 装 ---------- */

const ver = await json('/json/version');
const browser = connect(ver.webSocketDebuggerUrl);
await browser.ready;
const loaded = await browser.send('Extensions.loadUnpacked', { path: stage });
const extId = loaded?.result?.id;
browser.ws.close();
check('G1 打包产物被 Chrome 接受', !!extId, extId ? `${entries.length} 个文件 → ${extId}` : JSON.stringify(loaded));
if (!extId) {
  for (const r of report) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  process.exit(1);
}
await sleep(900);

/* ---------- 打开两个扩展页，边看边收 error ---------- */

async function openPage(rel) {
  const tab = await json('/json/new?about:blank', { method: 'PUT' });
  const page = connect(tab.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `chrome-extension://${extId}/${rel}` });
  await sleep(700);
  return { page, tab };
}

const evalIn = async (page, expression) => {
  const r = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return r?.result?.result?.value;
};

const welcome = await openPage('ui/welcome.html');
const welcomeText = await evalIn(
  welcome.page,
  `({
     perm: document.querySelector('#perm')?.textContent?.trim() || '',
     intro: document.querySelector('[data-i18n="welcomeIntro"]')?.textContent?.trim() || '',
     yield: document.querySelector('[data-i18n="welcomeYield"]')?.textContent?.trim() || '',
     appName: chrome.i18n.getMessage('appName') || '',
     css: getComputedStyle(document.body).maxWidth
   })`
);

check(
  'G2a welcome 渲染出文案（语言包 + i18n.js + css 都在）',
  welcomeText?.perm?.length > 0 &&
    welcomeText?.intro?.length > 0 &&
    // 让位说明是纯文案：漏 key 时 getMessage 只返回 key 名，页面上不会报错，只会露出一行 welcomeYield
    welcomeText?.yield?.length > 0 &&
    welcomeText?.yield !== 'welcomeYield' &&
    welcomeText?.appName?.length > 0 &&
    welcomeText?.perm !== 'allowAll' &&
    welcomeText?.css !== 'none',
  welcomeText
    ? `按钮「${welcomeText.perm}」· 让位说明 ${welcomeText.yield.length} 字 · 名称「${welcomeText.appName}」· body max-width ${welcomeText.css}`
    : '页面没响应'
);

const popup = await openPage('ui/popup.html');
const popupText = await evalIn(
  popup.page,
  `({
     status: document.querySelector('#statusText')?.textContent?.trim() || '',
     backdrops: document.querySelectorAll('#backdrop button').length,
     statusBrush: document.querySelectorAll('[data-v]').length
   })`
);

check(
  'G2b popup 渲染出状态与三档背板',
  popupText?.status?.length > 0 && popupText?.backdrops === 3,
  popupText ? `状态「${popupText.status}」· 背板 ${popupText.backdrops} 个` : '页面没响应'
);

/* ---------- G3 未授权 = 什么都不做（D6） ---------- */

const state = await evalIn(
  welcome.page,
  `Promise.all([
     chrome.permissions.contains({ origins: ['*://*/*'] }),
     chrome.scripting.getRegisteredContentScripts()
   ]).then(([granted, scripts]) => ({ granted, scripts: scripts.length }))`
);

check(
  'G3 未授权时不注册 content script',
  state && state.granted === false && state.scripts === 0,
  state ? `granted=${state.granted} · 注册 ${state.scripts} 个` : '查询失败'
);

/* ---------- G4 没有 error 级日志 ---------- */

const noise = [...welcome.page.notes, ...popup.page.notes].filter(
  // favicon 的 404 是扩展页的正常现象，与打包无关
  (n) => !/favicon/i.test(n)
);
check('G4 两个页面全程无 error 级日志', noise.length === 0, noise.slice(0, 3).join(' | ') || '干净');

/* ---------- 收尾 ---------- */

welcome.page.ws.close();
popup.page.ws.close();
await json(`/json/close/${welcome.tab.id}`);
await json(`/json/close/${popup.tab.id}`);
const b2 = connect((await json('/json/version')).webSocketDebuggerUrl);
await b2.ready;
await b2.send('Extensions.uninstall', { id: extId });
b2.ws.close();
fs.rmSync(stage, { recursive: true, force: true });

console.log('');
for (const r of report) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
}
const failed = report.filter((r) => !r.ok).length;
console.log(`\n${report.length - failed}/${report.length} 通过`);
process.exit(failed ? 1 : 0);
