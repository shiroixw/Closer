// 测试用的浏览器与本地资源。所有 lab 脚本都从这里拿 CDP 地址、端口、暂存目录。
//
// 两个约束，都来自真实踩坑：
//
// 1. 不抢焦点。9333 是 chrome-devtools MCP 的 solo Chrome，有界面、带登录态，是作者
//    日常在用的浏览器。往里面 `/json/new`、`Page.bringToFront`，macOS 会把窗口拽到前台，
//    跑一轮 smoke 输入焦点和桌面焦点被抢十几次。所以一律用 headless。
//
// 2. 可以并行。同一台机器上常有几个 agent 在不同工作树里同时改、同时测。共享一个浏览器时，
//    A 的 `clean()` 会卸掉 B 刚装上的扩展，B 的断言随之报「overlay 没打开」——查起来
//    和真 bug 一模一样。桩服务器写死端口、扩展暂存目录写死路径，也是同一类冲突。
//
// 所以：**每个测试进程独占一条「车道」**——
//   - 自己的 headless Chrome：`--remote-debugging-port=0` 让系统分端口，读 DevToolsActivePort；
//     冷启动实测 ~330 ms，比共享实例省下的 `clean()`（要等 chrome://extensions 渲染 1.2 s）还便宜
//   - 自己的临时目录：profile 与扩展暂存副本都在里面，进程退出即删
//   - 桩服务器用 `freePort()` 拿空闲端口
// 进程被 SIGKILL 时来不及收尾：下一个启动的车道会按 owner.json 清扫孤儿（owner 进程已死的
// 车道连同它的 Chrome 一起收掉）。手动清扫：`node tools/lab/browser.mjs sweep`。
//
// 要看着跑（调试某个用例）时显式给 `CDP=http://127.0.0.1:9333`：这时不起车道浏览器，
// 但端口与暂存目录仍然隔离。
//
// 用法：
//   import { CDP, OWNED, freePort, stageDir } from './browser.mjs'; // 顶层 await：import 完浏览器已就绪

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CLOSER_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PREFIX = 'closer-lane-';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 进程在，只是不是我们的
  }
}

function kill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* 已经没了 */
  }
}

/** 收掉 owner 已死的车道：它的 Chrome 与临时目录。返回收掉的个数。 */
export function sweep() {
  let n = 0;
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = path.join(os.tmpdir(), name);
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
    } catch {
      // 没有 owner.json：要么正在创建（几十毫秒内），要么是坏掉的残骸。按修改时间放 1 分钟
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs < 60_000) continue;
      } catch {
        continue;
      }
    }
    if (owner && alive(owner.pid)) continue;
    if (owner?.chrome) kill(owner.chrome);
    fs.rmSync(dir, { recursive: true, force: true });
    n++;
  }
  return n;
}

/**
 * 一个此刻空闲的本地端口。
 * 拿到后立即释放、再由调用方 listen：中间有极小的窗口可能被别人抢走，但系统分配临时端口
 * 是轮转的，刚释放的端口不会马上再发出去。换来的是各脚本只需改一行 `const PORT = …`。
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/* ---------- 车道 ---------- */

const main = !!process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
const cmd = main ? process.argv[2] || 'sweep' : null;

// 作为命令行跑时由命令自己清扫（否则这里的静默清扫会把结果吃掉，报出「清扫了 0 条」）
if (!cmd) sweep();

const LANE = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
const owner = { pid: process.pid, chrome: null, cwd: process.cwd(), script: process.argv[1] || '' };
const writeOwner = () => fs.writeFileSync(path.join(LANE, 'owner.json'), JSON.stringify(owner));
writeOwner();

/** 车道里的一个干净目录（扩展暂存副本之类）。随车道一起删。 */
export function stageDir(name) {
  const dir = path.join(LANE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let chrome = null;

function teardown() {
  if (chrome) kill(chrome.pid);
  chrome = null;
  try {
    fs.rmSync(LANE, { recursive: true, force: true });
  } catch {
    /* Chrome 还在写盘时可能删不干净，留给下一次 sweep */
  }
}
process.on('exit', teardown);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => process.exit(130));
}

/**
 * 真机站点会认 `HeadlessChrome` 这个 UA 拒绝服务（salesforce 就是），换成普通 Chrome 的写法。
 * 这不是反爬对抗，只是别被一眼认出来。
 */
function userAgent() {
  const major = (process.env.CLOSER_CHROME_MAJOR || '').trim();
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major || '156'}.0.0.0 Safari/537.36`;
}

async function launch() {
  if (!fs.existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}（可用 CLOSER_CHROME 指定）`);

  const profile = path.join(LANE, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0', // 系统分端口，写进 profile/DevToolsActivePort
      `--user-data-dir=${profile}`,
      '--enable-unsafe-extension-debugging', // Extensions.loadUnpacked 需要它
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      '--window-size=1280,900',
      // 界面语言：chrome.i18n 跟的是 Chrome 的 UI 语言，不是 navigator.language。
      // 测 D29 的两套文案、生成商店物料的两套截图都要它（默认跟随系统，macOS 上中文）。
      ...(process.env.CLOSER_LANG ? [`--lang=${process.env.CLOSER_LANG}`] : []),
      // 让本地桩站点挂一个像真域名的名字（例：MAP grano.studio 127.0.0.1）。
      // 商店截图里 popup / 面板会显示站点名，`127.0.0.1:8123` 出现在截图上是噪音。
      ...(process.env.CLOSER_HOST_RULES ? [`--host-resolver-rules=${process.env.CLOSER_HOST_RULES}`] : []),
      `--user-agent=${userAgent()}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  owner.chrome = chrome.pid;
  writeOwner();

  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
      if (port) {
        const base = `http://127.0.0.1:${port}`;
        const res = await fetch(base + '/json/version', { signal: AbortSignal.timeout(800) }).catch(() => null);
        if (res?.ok) return base;
      }
    } catch {
      /* 文件还没写出来 */
    }
    await sleep(50);
  }
  throw new Error('headless Chrome 没起来（5 s 内没有 DevToolsActivePort）');
}

/** 这个浏览器是不是本进程独占的（是：里面不可能有别人的扩展，`clean()` 可以跳过）。 */
export const OWNED = !process.env.CDP && !cmd;
// 显式给了 CDP 就尊重它（看着跑的调试场景）；否则起本进程独占的 headless。
export const CDP = process.env.CDP || (cmd ? null : await launch());

if (cmd === 'sweep') console.log(`清扫了 ${sweep()} 条孤儿车道`);
else if (cmd) console.log(`未知命令：${cmd}（可用 sweep）`);
