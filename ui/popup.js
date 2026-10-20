'use strict';

// popup 跑在扩展页面，不是 content script，所以不共享 window.Closer。
// 只有两个 key，直接读，不引抽象层。

const ALL = { origins: ['*://*/*'] };
const PAUSED_KEY = 'closer:paused';
const PREFS_KEY = 'closer:prefs';

const $ = (id) => document.getElementById(id);
const statusText = $('statusText');
const statusDot = document.querySelector('#status .dot');
const permRow = $('permRow');
const hostEl = $('host');
const pauseBtn = $('pause');

let host = '';
let paused = [];
let granted = false;

const strip = (h) => (h || '').replace(/^www\./i, '').toLowerCase();
const covers = (entry, h) => !!entry && !!h && (h === entry || h.endsWith('.' + entry));

async function activeHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return strip(new URL(tab.url).hostname);
  } catch {
    return ''; // chrome:// 等页面没有可解析的 URL
  }
}

function paint() {
  statusDot.className = granted ? 'dot on' : 'dot off';
  statusText.textContent = granted ? t('statusOn') : t('statusOff');
  permRow.hidden = granted;

  const isPaused = paused.some((e) => covers(e, host));
  hostEl.textContent = host || t('thisPage');
  hostEl.title = host; // 窄窗里会被截断成省略号，完整站点名留在 tooltip 上
  pauseBtn.textContent = isPaused ? t('resume') : t('pause');
  pauseBtn.disabled = !host;
}

async function load() {
  const got = await chrome.storage.local.get([PAUSED_KEY, PREFS_KEY]);
  paused = Array.isArray(got[PAUSED_KEY]) ? got[PAUSED_KEY] : [];

  const prefs = got[PREFS_KEY] || {};
  for (const b of document.querySelectorAll('#backdrop button')) {
    b.setAttribute('aria-pressed', String((prefs.backdrop || 'dark') === b.dataset.v));
  }

  try {
    granted = await chrome.permissions.contains(ALL);
  } catch {
    granted = false;
  }

  host = await activeHost();
  paint();
}

$('perm').addEventListener('click', async () => {
  // 必须在用户手势里请求，否则 Chrome 直接拒绝
  try {
    granted = await chrome.permissions.request(ALL);
  } catch {
    granted = false;
  }
  paint();
});

pauseBtn.addEventListener('click', async () => {
  if (!host) return;
  const isPaused = paused.some((e) => covers(e, host));

  if (isPaused) paused = paused.filter((e) => !covers(e, host));
  else if (!paused.includes(host)) paused.push(host);

  await chrome.storage.local.set({ [PAUSED_KEY]: paused });
  paint();
});

$('backdrop').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;

  for (const other of document.querySelectorAll('#backdrop button')) {
    other.setAttribute('aria-pressed', String(other === b));
  }

  const got = await chrome.storage.local.get(PREFS_KEY);
  const prefs = { ...(got[PREFS_KEY] || {}), backdrop: b.dataset.v };
  await chrome.storage.local.set({ [PREFS_KEY]: prefs });
});

load();
