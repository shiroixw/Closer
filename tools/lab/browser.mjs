// 测试用的浏览器。所有 lab 脚本都从这里拿 CDP 地址，不再各自写死 9333。
//
// 为什么不用 9333：那是 chrome-devtools MCP 的 solo Chrome，有界面、带登录态，
// 是作者日常在用的浏览器。测试往里面 `/json/new` 开标签页、开 chrome://extensions、
// `Page.bringToFront`，macOS 会把那个窗口拽到前台——跑一轮 smoke，输入焦点和
// 桌面焦点被抢十几次，人什么都干不了。
//
// 所以默认起一个**专用的 headless Chrome**：独立端口、独立的一次性 profile、
// 没有窗口，抢不到任何焦点。进程常驻（下一个测试文件直接复用，省掉每次 1 s 冷启动），
// 用 `node tools/lab/browser.mjs stop` 收掉。
//
// 要看着跑（调试某个用例）时显式给 `CDP=http://127.0.0.1:9333`，这才连有界面的实例。
//
// 用法：
//   import { CDP } from './browser.mjs';   // 顶层 await：import 完成时浏览器已就绪
//   node tools/lab/browser.mjs start|stop|status

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.CLOSER_HEADLESS_PORT || 9444);
const PROFILE = path.join(os.tmpdir(), 'closer-headless-profile');
const CHROME =
  process.env.CLOSER_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(base) {
  try {
    const res = await fetch(base + '/json/version', { signal: AbortSignal.timeout(800) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * 真机站点会认 `HeadlessChrome` 这个 UA 拒绝服务（salesforce 就是），
 * 换成普通 Chrome 的写法；其余指纹不管，这不是反爬对抗，只是别被一眼认出来。
 */
function userAgent() {
  try {
    const out = execFileSync(CHROME, ['--version'], { encoding: 'utf8' }); // "Google Chrome 156.0.8078.48"
    const major = (out.match(/(\d+)\./) || [])[1] || '130';
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  } catch {
    return null;
  }
}

async function start() {
  if (await up(HEADLESS)) return HEADLESS;
  if (!fs.existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}（可用 CLOSER_CHROME 指定）`);

  fs.mkdirSync(PROFILE, { recursive: true });
  const ua = userAgent();
  const args = [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging', // Extensions.loadUnpacked 需要它
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--window-size=1280,900',
    ...(ua ? [`--user-agent=${ua}`] : []),
    'about:blank',
  ];
  // detached + unref：测试脚本退出后它继续活着，给下一个测试文件复用
  const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 60; i++) {
    if (await up(HEADLESS)) return HEADLESS;
    await sleep(150);
  }
  throw new Error(`headless Chrome 没起来（${HEADLESS}）`);
}

async function stop() {
  const v = await up(HEADLESS);
  if (!v) return false;
  await new Promise((resolve) => {
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
    ws.addEventListener('close', resolve);
    ws.addEventListener('error', resolve);
    setTimeout(resolve, 2000);
  });
  return true;
}

const main = !!process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
const cmd = main ? process.argv[2] || 'status' : null;

// 显式给了 CDP 就尊重它（看着跑的调试场景）；否则一律走 headless。
// 作为命令行跑 stop / status 时不拉起浏览器。
export const CDP = process.env.CDP || (cmd === 'stop' || cmd === 'status' ? HEADLESS : await start());

if (cmd === 'stop') console.log((await stop()) ? `已停止 ${HEADLESS}` : `没在跑 ${HEADLESS}`);
else if (cmd === 'start') console.log(`就绪 ${CDP}`);
else if (cmd === 'status') console.log((await up(HEADLESS)) ? `up   ${HEADLESS}` : `down ${HEADLESS}`);
