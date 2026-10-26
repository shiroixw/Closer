// E4 — 视图层冒烟：点击 → 打开 → Esc → 关闭，外加三种「不该打开」的图。
//
// 为什么不装扩展跑：D6 的权限模型要求用户手势授权，自动化里点不到那个 Allow。
// 所以这里把真实的内容脚本注入一个普通页面，用 chrome API 桩顶住，
// 跑的是同一份 overlay.js / boot.js / judge()。装扩展前能挡掉 90% 的低级错误。
//
// 用法：node tools/lab/e4-overlay.mjs（默认 headless，见 browser.mjs；CDP=… 可改连有界面的实例）

import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { clean } from './clean-extensions.mjs';

import { CDP, freePort } from './browser.mjs'; // 车道：本进程独占的 headless + 空闲端口
const PORT = await freePort(); // 并行跑时各用各的端口
// 同 check-manifest：URL.pathname 在 Windows 上是 /D:/...，拼出来是 D:\D:\...
const ROOT = resolve(import.meta.dirname, '../..');
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
  /* 图库常见形态：图上盖一层透明的悬停装饰，点击落在装饰上 */
  #frame{position:relative;width:240px}
  #frame img{width:240px;display:block}
  #shade{position:absolute;inset:0}
  /* 页面自己声明了手势的图：悬停提示必须让开（D32） */
  #own{width:240px;display:block;margin-bottom:20px;cursor:zoom-in}
  /* 2026-10-23 的真实事故复刻：页面对 div 声明颜色与宽度，会盖掉 :host 里的东西
     （外层树的普通声明优先于 shadow 树的 :host 声明）。宿主必须靠 inline 顶住。 */
  div{color:#111;max-width:300px;margin:0 auto}
  /* 同一形态换成 Web Component 实现：命中栈里只剩 host */
  #shadow-frame{display:block;width:240px}
</style>
<img id="big" src="/img.png">
<img id="avatar" src="/avatar.png">
<a id="link" href="/article"><img id="linked" src="/img.png"></a>
<div id="frame"><img id="covered" src="/img.png"><div id="shade"></div></div>
<img id="own" src="/img.png">
<div id="shadow-frame"></div>
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

// 同一形态的 Web Component 版：图与遮罩都在 shadow tree 里，外部只看得见 host
(() => {
  const sr = document.getElementById('shadow-frame').attachShadow({ mode: 'open' });
  sr.innerHTML = '<style>.f{position:relative;width:240px}img{display:block;width:240px}.s{position:absolute;inset:0}</style>';
  const frame = document.createElement('div');
  frame.className = 'f';
  const img = document.createElement('img');
  img.src = '/img.png';
  const shade = document.createElement('div');
  shade.className = 's';
  shade.id = 'shadow-shade';
  frame.append(img, shade);
  sr.append(frame);
})();
</script>
<script src="/js/core.js"></script>
<script src="/js/detect.js"></script>
<script src="/js/meta.js"></script>
<script src="/js/bytes.js"></script>
<script src="/js/yield.js"></script>
<script src="/js/overlay.js"></script>
<script src="/js/actions.js"></script>
<script src="/js/hint.js"></script>
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
      // 页面 div{color:#111} 不能把宿主的调色板劫走（2026-10-23 事故）
      chromeColor: getComputedStyle(h.shadowRoot.querySelector('.info')).color,
      dimsColor: getComputedStyle(h.shadowRoot.querySelector('.dims')).color,
      hostPos: getComputedStyle(h).position,
      hostFull: Math.round(h.getBoundingClientRect().width) === Math.round(innerWidth),
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
  // 页面有 div{color:#111}：只靠 :host 声明会被外层树的普通声明盖掉（真实事故）
  check('图标文字不被页面 div{color} 劫持', o.chromeColor === 'rgb(245, 245, 245)', o.chromeColor);
  check('ⓘ 面板数字同样不被劫持', o.dimsColor === 'rgb(245, 245, 245)', o.dimsColor);
  check('宿主仍是全屏 fixed（页面规则没压窄它）', o.hostPos === 'fixed' && o.hostFull === true, `pos=${o.hostPos} full=${o.hostFull}`);

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

  // 3b. 悬停提示：只在「真能点开」的图上给原生 zoom-in（D32）。
  //     用合成 PointerEvent 而不是 CDP 鼠标：判据只看 target 与 judge()，
  //     不需要真的命中测试，也就不必把元素滚进视口。
  const hover = (id) =>
    evalx(`(() => {
      document.getElementById('${id}').dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
      );
      return true;
    })()`);

  await hover('big'); // 没有 dwell：下一次求值时它已经写好了
  const hintOn = await evalx(`document.getElementById('big').style.cursor`);
  check('悬停即给原生 zoom-in（无延时）', hintOn.value === 'zoom-in', String(hintOn.value));

  await hover('own');
  const hintOff = await evalx(`({
    cursor: document.getElementById('big').style.cursor,
    attr: document.getElementById('big').hasAttribute('style'),
    own: document.getElementById('own').style.cursor,
    intact: document.documentElement.outerHTML === window.__snap,
  })`);
  const h = hintOff.value || {};
  check('离开后光标还原，且不留 style 属性', h.cursor === '' && h.attr === false, JSON.stringify(h));
  check('页面自己声明了 cursor 的图不碰', h.own === '', `own.style.cursor=${h.own}`);
  check('提示撤销后 DOM 仍逐字节一致', h.intact === true);

  await hover('avatar');
  const hintAvatar = await evalx(`document.getElementById('avatar').style.cursor`);
  check('判不过的图（40px 头像）不给手势', hintAvatar.value === '', String(hintAvatar.value));

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

  // 6. 透明装饰盖着图：点击落在装饰上，仍要认出下面那张图（真实站点 cases 004）
  const picked = await evalx(`(() => {
    const shade = document.getElementById('shade');
    shade.scrollIntoView({ block: 'center' }); // 视口外的点，elementsFromPoint 返回空
    const r = shade.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const img = Closer.pick(shade, x, y);
    shade.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y,
    }));
    return {
      shadeRect: [Math.round(r.width), Math.round(r.height)],
      stack: document.elementsFromPoint(x, y).map((n) => n.tagName + (n.id ? '#' + n.id : '')),
      pick: img && img.id,
      judge: img ? Closer.judge(img) : null,
    };
  })()`);
  await sleep(360);
  const covered = await evalx(`(() => {
    const h = document.getElementById('closer');
    if (!h) return { open: false };
    return { open: Closer.overlay.isOpen(), src: (h.shadowRoot.querySelector('.photo').src || '').endsWith('/img.png') };
  })()`);
  const c = covered.value || {};
  check(
    '透明遮罩盖着的图，点遮罩也能打开',
    c.open === true && c.src === true,
    `${JSON.stringify(picked.value)} ${JSON.stringify(c)}`
  );

  await evalx(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(480);

  // 7. 同一形态的 Web Component 版：图与遮罩都在 shadow tree 里。
  //    elementFromPoint 只返回 host，必须下钻才看得见那张图。
  const inner = await evalx(`(() => {
    const host = document.getElementById('shadow-frame');
    const shade = host.shadowRoot.getElementById('shadow-shade');
    host.scrollIntoView({ block: 'center' });
    const r = shade.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const img = Closer.pick(shade, x, y);
    shade.dispatchEvent(new MouseEvent('click', {
      bubbles: true, composed: true, cancelable: true, button: 0, clientX: x, clientY: y,
    }));
    return {
      stack: document.elementsFromPoint(x, y).map((n) => n.tagName + (n.id ? '#' + n.id : '')),
      pick: img ? img.tagName : null,
      judge: img ? Closer.judge(img) : null,
    };
  })()`);
  await sleep(360);
  const shadowOpen = await evalx(`(() => {
    const h = document.getElementById('closer');
    if (!h) return { open: false };
    return { open: Closer.overlay.isOpen(), src: (h.shadowRoot.querySelector('.photo').src || '').endsWith('/img.png') };
  })()`);
  const s = shadowOpen.value || {};
  check(
    'shadow tree 里的遮罩：下钻后也能打开',
    s.open === true && s.src === true,
    `${JSON.stringify(inner.value)} ${JSON.stringify(s)}`
  );

  await evalx(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(480);

  // 8. 版面的底（真实站点 cases 012，bilibili 页头）：全宽横幅 <img> + 一层视差 <img>，
  //    上面压着装着 logo 链接、铺满横幅的内容层。点内容层空白处，pick() 能按命中点找回图，
  //    但那是页头的底，不是被装饰盖住的那张图——不接管。z-index 全是 auto/0，负 z-index（D33）兜不住。
  //    inline 写死尺寸：桩页面的 `div{max-width:300px}` 会把普通 div 压窄。
  const bleed = await evalx(`(() => {
    const b = document.createElement('div');
    b.id = 'bleed';
    b.style.cssText = 'position:fixed;left:0;top:0;width:100vw;max-width:none;height:150px;margin:0;z-index:0';
    b.innerHTML =
      '<img id="bleed-img" src="/img.png" style="position:absolute;inset:0;width:100%;height:150px;object-fit:cover">' +
      '<div style="position:absolute;inset:0;max-width:none;margin:0"><img id="bleed-layer" src="/img.png" style="width:130vw;height:150px;margin-left:-15vw;object-fit:cover"></div>' +
      '<div id="bleed-inner" style="position:relative;width:100%;max-width:none;height:150px;margin:0"><a href="/" style="position:absolute;left:20px;top:40px">logo</a></div>';
    document.body.appendChild(b);
    return 1;
  })()`);
  void bleed;
  await sleep(300);
  const banner = await evalx(`(() => {
    const inner = document.getElementById('bleed-inner');
    const x = Math.round(innerWidth / 2), y = 100;
    const img = Closer.pick(inner, x, y);
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    const under = document.elementsFromPoint(x, y).find((n) => n instanceof HTMLImageElement);
    return {
      stack: document.elementsFromPoint(x, y).slice(0, 4).map((n) => n.tagName + (n.id ? '#' + n.id : '')),
      pick: img ? img.id : null,
      underJudge: under ? Closer.judge(under) : null, // 判断器本身放行，挡住它的只能是 pick()
    };
  })()`);
  await sleep(360);
  const bannerOpen = await evalx(`!!document.getElementById('closer')`);
  const bv = banner.value || {};
  check(
    '版面的底（全宽横幅上压着内容层）：点内容层不接管',
    bv.pick === null && bv.underJudge === true && bannerOpen.value === false,
    `${JSON.stringify(bv)} open=${bannerOpen.value}`
  );
  await evalx(`document.getElementById('bleed').remove()`);

  // 9. 快捷键：· 开详情；Ctrl/⌘ + C 复制、Ctrl/⌘ + S 下载（后两个必须先吃掉浏览器原生行为）。
  //    剪贴板与下载在 headless 里既不稳定也不可观测，所以把落地函数换成桩：
  //    这里验的是「键 → 动作 → 提示」这条接线，以及 defaultPrevented。
  await evalx(`(() => {
    const img = document.getElementById('big');
    const r = img.getBoundingClientRect();
    img.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    Closer.bytes = async () => ({ buf: new ArrayBuffer(8), mime: 'image/png' });
    Closer.copyImage = async () => 'image';
    Closer.saveImage = async () => {};
    return Closer.overlay.isOpen();
  })()`);
  await sleep(420);

  // 桩页面没有 chrome.i18n，Closer.t 按 core.js 的约定退回 key 本身，
  // 所以这里比的正是 key 名：copyDone / saveDone 只可能由成功路径写出来。
  const hotkeys = await evalx(`(async () => {
    const sr = document.getElementById('closer').shadowRoot;
    const panel = sr.querySelector('.panel');
    const toast = sr.querySelector('.toast');
    const fire = (init) => {
      const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const settle = () => new Promise((r) => setTimeout(r, 60));

    const dot = fire({ key: '·' });
    const dotOpen = !panel.hidden;
    fire({ key: '·' });
    const dotClosed = panel.hidden;

    const copyPrevented = fire({ key: 'c', ctrlKey: true });
    await settle();
    const copy = { toast: toast.textContent, on: toast.classList.contains('on') };

    const savePrevented = fire({ key: 's', ctrlKey: true });
    await settle();
    const save = { toast: toast.textContent, on: toast.classList.contains('on') };

    return { dot, dotOpen, dotClosed, copyPrevented, copy, savePrevented, save, stillOpen: Closer.overlay.isOpen() };
  })()`);

  const hk = hotkeys.value || {};
  check('· 键打开详情面板（页面拿不到这个键）', hk.dot === true && hk.dotOpen === true, JSON.stringify(hk));
  check('· 键再按一次收起面板', hk.dotClosed === true);
  check(
    'Ctrl+C 被吃掉，并提示「已复制」',
    hk.copyPrevented === true && hk.copy?.toast === 'copyDone' && hk.copy?.on === true,
    `${JSON.stringify(hk.copy)} prevented=${hk.copyPrevented}`
  );
  check(
    'Ctrl+S 被吃掉，并提示已开始下载',
    hk.savePrevented === true && hk.save?.toast === 'saveDone' && hk.save?.on === true,
    `${JSON.stringify(hk.save)} prevented=${hk.savePrevented}`
  );
  check('快捷键不关闭 overlay', hk.stillOpen === true);

  await evalx(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(480);
  const afterKeys = await evalx(`({
    gone: !document.getElementById('closer'),
    intact: document.documentElement.outerHTML === window.__snap,
  })`);
  check('快捷键验完，Esc 关闭且 DOM 仍逐字节一致', afterKeys.value?.gone === true && afterKeys.value?.intact === true);
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
