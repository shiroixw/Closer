// 清理调试 Chrome 里所有名为 Closer 的扩展。
//
// 为什么必须有这一步：e4 的桩页面在 `http://127.0.0.1` 上，落在扩展
// `*://*/*` 的匹配范围内。任何一个残留实例都会注入 content script，
// 和桩脚本抢同一次点击 —— 而且因为让位检测真的在工作，主世界的桩会
// 判定「页面动过了」主动让位，于是断言报出「overlay 没打开」，
// 而 width / transform / backdrop 全都正常。查这个假象花了两轮。
//
// 用法：
//   node tools/lab/clean-extensions.mjs        # 独立跑
//   import { clean } from './clean-extensions.mjs'   # e4/e5/e6 开头调用

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(pathname, init) {
  const res = await fetch(CDP + pathname, init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function clean(cdpBase = CDP, { quiet = false } = {}) {
  const say = (s) => {
    if (!quiet) console.log(s);
  };

  const ver = await json('/json/version');
  if (!ver.webSocketDebuggerUrl) {
    say('· 连不上调试端口，跳过扩展清理');
    return [];
  }

  // 1. 打开 chrome://extensions，它才有完整列表（休眠的 SW 不在 /json/list 里）
  const tab = await json(`/json/new?${encodeURIComponent('chrome://extensions/')}`, { method: 'PUT' });
  if (!tab.webSocketDebuggerUrl) {
    say('· 打不开 chrome://extensions，跳过清理');
    return [];
  }

  const page = new WebSocket(tab.webSocketDebuggerUrl);
  let seq = 0;
  const waiting = new Map();
  page.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++seq;
      waiting.set(i, r);
      page.send(JSON.stringify({ id: i, method, params }));
    });

  await new Promise((r) => page.addEventListener('open', r));
  await send('Runtime.enable');
  await sleep(1200); // WebUI 是异步渲染的，读早了会是空列表

  const raw = await send('Runtime.evaluate', {
    expression: `(() => {
      const mgr = document.querySelector('extensions-manager');
      const list = mgr && mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-item-list');
      if (!list || !list.shadowRoot) return '[]';
      return JSON.stringify([...list.shadowRoot.querySelectorAll('extensions-item')].map((i) => ({
        id: i.id,
        name: (i.shadowRoot.querySelector('#name')?.textContent || '').trim(),
      })));
    })()`,
    returnByValue: true,
  });

  page.close();
  await json(`/json/close/${tab.id}`).catch(() => {});

  let items = [];
  try {
    items = JSON.parse(raw?.result?.result?.value || '[]');
  } catch {
    items = [];
  }

  const targets = items.filter((x) => /^Closer\b/i.test(x.name));
  if (!targets.length) {
    say('· 浏览器里没有残留的 Closer 实例');
    return [];
  }

  // 2. 逐个卸载（必须走 browser 级连接）
  const browser = new WebSocket(ver.webSocketDebuggerUrl);
  let bseq = 0;
  const bwaiting = new Map();
  browser.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    bwaiting.get(m.id)?.(m);
    bwaiting.delete(m.id);
  });
  const bsend = (method, params = {}) =>
    new Promise((r) => {
      const i = ++bseq;
      bwaiting.set(i, r);
      browser.send(JSON.stringify({ id: i, method, params }));
    });
  await new Promise((r) => browser.addEventListener('open', r));

  const removed = [];
  for (const t of targets) {
    const res = await bsend('Extensions.uninstall', { id: t.id });
    if (!res.error) removed.push(t.id);
    else say(`  ✗ ${t.id.slice(0, 8)}… ${res.error.message}`);
  }
  browser.close();

  say(`· 清理了 ${removed.length} 个残留的 Closer 实例${removed.length ? '：' + removed.map((i) => i.slice(0, 8) + '…').join(' ') : ''}`);
  return removed;
}

// 直接跑
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await clean();
}
