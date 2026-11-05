'use strict';

const ALL = { origins: ['*://*/*'] };
const PAUSED_KEY = 'closer:paused';
const TAKEOVER_KEY = 'closer:takeover';
const PREFS_KEY = 'closer:prefs';

const $ = (id) => document.getElementById(id);
const statusText = $('statusText');
const statusDot = document.querySelector('#status .dot');
const permRow = $('permRow');
const hostEl = $('host');
const modeHint = $('modeHint');

let host = '';
let paused = [];
let takeover = [];
let granted = false;

const strip = (h) => (h || '').replace(/^www\./i, '').toLowerCase();
const covers = (entry, h) => !!entry && !!h && (h === entry || h.endsWith('.' + entry));

function siteMode() {
  if (paused.some((e) => covers(e, host))) return 'paused';
  if (takeover.some((e) => covers(e, host))) return 'takeover';
  return 'auto';
}

async function activeHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return strip(new URL(tab.url).hostname);
  } catch {
    return '';
  }
}

function paintMode() {
  const m = siteMode();
  for (const b of document.querySelectorAll('#siteMode button')) {
    b.setAttribute('aria-pressed', String(b.dataset.m === m));
    b.disabled = !host;
  }
  modeHint.textContent = m === 'auto' ? t('modeAutoHint') : '';
}

function paint() {
  statusDot.className = granted ? 'dot on' : 'dot off';
  statusText.textContent = granted ? t('statusOn') : t('statusOff');
  permRow.hidden = granted;

  hostEl.textContent = host || t('thisPage');
  hostEl.title = host;
  paintMode();
}

async function load() {
  const got = await chrome.storage.local.get([PAUSED_KEY, TAKEOVER_KEY, PREFS_KEY]);
  paused = Array.isArray(got[PAUSED_KEY]) ? got[PAUSED_KEY] : [];
  takeover = Array.isArray(got[TAKEOVER_KEY]) ? got[TAKEOVER_KEY] : [];

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
  try {
    granted = await chrome.permissions.request(ALL);
  } catch {
    granted = false;
  }
  paint();
});

$('siteMode').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-m]');
  if (!b || !host) return;
  const next = b.dataset.m;
  paused = paused.filter((entry) => !covers(entry, host));
  takeover = takeover.filter((entry) => !covers(entry, host));
  if (next === 'paused') paused.push(host);
  else if (next === 'takeover') takeover.push(host);
  await chrome.storage.local.set({ [PAUSED_KEY]: paused, [TAKEOVER_KEY]: takeover });
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
