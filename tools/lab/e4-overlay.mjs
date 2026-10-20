// E4 — 视图层冒烟：点击 → 打开 → Esc → 关闭，外加三种「不该打开」的图。
//
// 为什么不装扩展跑：D6 的权限模型要求用户手势授权，自动化里点不到那个 Allow。
// 所以这里把真实的内容脚本注入一个普通页面，用 chrome API 桩顶住，
// 跑的是同一份 overlay.js / boot.js / judge()。装扩展前能挡掉 90% 的低级错误。
//
// 用法：先有一个带调试端口的 Chrome（CDP=http://127.0.0.1:9333），然后
//   node tools/lab/e4-overlay.mjs

import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { clean } from './clean-extensions.mjs';

const PORT = 8824;
const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const ROOT = new URL('../../', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 造图 ---------- */

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

function png(w, h, color) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x, y, w, h);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
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

const BIG = png(600, 400, (x, y) => [30 + (x % 200), 60 + (y % 150), 120]);
const SMALL = png(40, 40, () => [200, 200, 210]);

/* ---------- 页面 ---------- */

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>E4 overlay</title>
<style>
  body{margin:0;padding:24px;background:#0d0d0f;color:#ddd;font:13px ui-monospace,monospace}
  #big{width:240px;height:auto;display:block;margin-bottom:20px}
  #avatar{width:40px;height:40px;display:block;margin-bottom:20px}
  a#link{display:block;width:240px}
  a#link img{width:240px}
</style>
<img id="big" src="/img.png">
<img id="avatar" src="/avatar.png">
<a id="link" href="/article"><img id="linked" src="/img.png"></a>
<script>
window.chrome = {
  storage: {
    local: {
      get: (keys) => Promise.resolve({}),
      set: () => Promise.resolve(),
    },
    onChanged: { addListener: () => {} },
  },
  runtime: {
    lastError: null,
    sendMessage: (m, cb) => setTimeout(() => cb && cb(null), 0),
  },
};
window.__snap = null;
</script>
<script src="/js/core.js"></script>
<script src="/js/detect.js"></script>
<script src="/js/meta.js"></script>
<script src="/js/bytes.js"></script>
<script src="/js/yield.js"></script>
<script src="/js/overlay.js"></script>
<script src="/js/actions.js"></script>
<script src="/js/boot.js"></script>
<script>
(async () => {
  await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
  window.__snap = document.documentElement.outerHTML;
  window.__ready = true;
})();
</script>
`;

const server = http
  .createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/img.png' || url === '/avatar.png') {
      const buf = url === '/img.png' ? BIG : SMALL;
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length });
      return res.end(buf);
    }

    if (url.startsWith('/js/')) {
      const file = url.slice(4).replace(/[^a-z.]/gi, '');
      try {
        const js = readFileSync(ROOT + 'src/content/' + file);
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

async function j(path, init) {
  const res = await fetch(CDP + path, init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// 桩页面在 *://*/* 匹配内，任何残留实例都会和桩脚本互相让位。
await clean(CDP);

const target = await j(`/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`, { method: 'PUT' });
if (!target.webSocketDebuggerUrl) {
  console.error('开标签页失败：', target);
  process.exit(1);
}

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
  if (r?.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return { value: r?.result?.result?.value };
};

/* ---------- 等页面就绪 ---------- */

let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(150);
  const r = await evalx('!!window.__ready && !!window.Closer && Closer.state.ready');
  if (r.value === true) {
    ready = true;
    break;
  }
}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

if (!ready) {
  check('页面就绪（脚本加载 + 图片解码）', false, '脚本没跑起来，看 console');
} else {
  // 1. 点大图 → 打开
  await evalx(`(() => {
    const img = document.getElementById('big');
    const r = img.getBoundingClientRect();
    img.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    return Closer.overlay.isOpen();
  })()`);

  await sleep(420);

  const opened = await evalx(`(() => {
    const h = document.getElementById('closer');
    if (!h) return { open: false };
    const p = h.shadowRoot.querySelector('.photo');
    const cs = getComputedStyle(p);
    return {
      open: Closer.overlay.isOpen(),
      width: p.style.width,
      src: (p.src || '').endsWith('/img.png'),
      transform: cs.transform !== 'none',
      backdrop: h.shadowRoot.querySelector('.backdrop').classList.contains('in'),
      bg: getComputedStyle(h.shadowRoot.querySelector('.backdrop')).backgroundColor,
      dims: h.shadowRoot.querySelector('.dims').textContent,
    };
  })()`);

  const o = opened.value || {};
  check('点大图 → overlay 打开', o.open === true, `isOpen=${o.open} width=${o.width} src=${o.src}`);

  // 浏览器里若还装着 Closer（比如真机回归没卸载），它会往这个页面也注入一份，
  // 同一次点击上会有两个实例抢活，上面的断言会给出完全误导的结果。
  const hostCount = (await evalx("document.querySelectorAll('#closer').length")).value;
  check('环境干净：页面上只有一个 overlay', hostCount === 1, `找到 ${hostCount} 个 #closer`);
  check('照片按原始像素设宽（600px）', o.width === '600px', o.width);
  check('transform 已生效（动画结束）', o.transform === true);
  check('背板已淡入', o.backdrop === true);
  // 只查 opacity 会漏掉「类名挂错节点、背板其实是透明的」——页面会直接透出来
  check('背板不透明（页面不透出）', /^rgb/.test(o.bg || '') && o.bg !== 'rgba(0, 0, 0, 0)', o.bg);
  check('信息面板显示 600 × 400', o.dims === '600 × 400', o.dims);

  // 截图（可选）：视觉错位只有看图才知道，断言看不出来
  if (process.env.SHOT) {
    await send('Page.enable');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, 'base64'));
  }

  // 2. 面板开合
  const panelState = await evalx(`(() => {
    const sr = document.getElementById('closer').shadowRoot;
    const btn = sr.querySelector('.info');
    btn.click();
    const opened = !sr.querySelector('.panel').hidden && btn.getAttribute('aria-expanded') === 'true';
    btn.click();
    return { opened, closedAgain: sr.querySelector('.panel').hidden };
  })()`);
  check(
    'ⓘ 能开合并收回（aria-expanded 跟随）',
    panelState.value?.opened === true && panelState.value?.closedAgain === true
  );

  // 3. 缩放：滚轮放大
  const zoomed = await evalx(`(() => {
    const h = document.getElementById('closer');
    const p = h.shadowRoot.querySelector('.photo');
    const before = p.style.transform;
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
    return { changed: p.style.transform !== before };
  })()`);
  check('滚轮缩放改变了 transform', zoomed.value?.changed === true);

  // 3. Esc → 关闭，且页面 DOM 逐字节还原（宪法第三条的检验）
  const same = await evalx(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);
  await sleep(520);

  const closed = await evalx(`({
    gone: !document.getElementById('closer'),
    intact: document.documentElement.outerHTML === window.__snap,
    isOpen: Closer.overlay.isOpen(),
  })`);
  check('Esc 关闭后 host 已摘除', closed.value?.gone === true);
  check('关闭后页面 DOM 逐字节一致', closed.value?.intact === true);

  // 4. 头像不接管
  const avatar = await evalx(`(() => {
    const img = document.getElementById('avatar');
    const r = img.getBoundingClientRect();
    img.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    return Closer.judge(img);
  })()`);
  await sleep(200);
  const avatarOpen = await evalx(`!!document.getElementById('closer')`);
  check('40px 头像不接管', avatar.value === false && avatarOpen.value === false);

  // 5. 链接里的图不接管
  const linked = await evalx(`(() => {
    const img = document.getElementById('linked');
    const r = img.getBoundingClientRect();
    img.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    return Closer.judge(img);
  })()`);
  await sleep(200);
  const linkOpen = await evalx(`!!document.getElementById('closer')`);
  check('文章链接里的图不接管', linked.value === false && linkOpen.value === false);
}

ws.close();
await j(`/json/close/${target.id}`).catch(() => {});
server.close();

/* ---------- 报告 ---------- */

const pass = results.filter((r) => r.ok).length;
console.log('');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail && !r.ok ? `   ${r.detail}` : ''}`);
}
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
