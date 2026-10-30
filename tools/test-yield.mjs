// shelled() 的单元测试：「这张图此刻该不该交给页面」。纯读当前状态，所以不需要浏览器。
// 每条边界至少一个反例——不能失败的测试没有意义。
//
// 重点是第三件事 onTopLayer（cases 014 / D43）：命中栈里图之下有没有一层页面自己的
// fixed 全屏层、层之下还有没有页面内容。用例按真实页面结构复刻，名字里写着它来自哪一页。

import fs from 'node:fs';
import vm from 'node:vm';

const SRC = new URL('../src/content/yield.js', import.meta.url);
const src = fs.readFileSync(SRC, 'utf8');

// 视口固定 1000 × 800。body / html 必须与命中栈里的是同一个对象：实现按身份认「走到头了」。
const VIEW = { w: 1000, h: 800 };
const box = (w, h) => () => ({ width: w, height: h, left: 0, top: 0 });
const BODY = { getBoundingClientRect: box(VIEW.w, VIEW.h), contains: () => true };
const HTML = { getBoundingClientRect: box(VIEW.w, VIEW.h), contains: () => true };

const ctx = {
  window: {},
  innerWidth: VIEW.w,
  innerHeight: VIEW.h,
  document: {
    body: BODY,
    documentElement: HTML,
    fullscreenElement: null,
    elementsFromPoint: () => ctx.__stack,
  },
  // 只有 position 被读到；未声明时与浏览器一致，是 static
  getComputedStyle: (n) => ({ position: n?.__pos || 'static' }),
  __stack: [],
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const Closer = ctx.window.Closer;
Closer.state = { host: null, unseen: false };

// 命中栈里的一层。fixed 与尺寸决定它是不是「盖满视口的固定层」；kids 是子节点数
// （空装饰判据）；wraps 是它包着的节点（祖先关系）。
function layer({ fixed = false, size = [VIEW.w, VIEW.h], kids = 1, wraps = [] } = {}) {
  const node = {
    __pos: fixed ? 'fixed' : 'static',
    childElementCount: kids,
    getBoundingClientRect: box(size[0], size[1]),
    contains: (n) => n === node || wraps.includes(n),
  };
  return node;
}
const content = () => layer({ size: [800, 600] }); // 被压着的页面内容

// 一张图，以及它中心点的命中栈（自上而下，图自己在最上面）。
// inStack:false 用来构造「图不在栈里」。
function scene(below, { inStack = true } = {}) {
  const img = { getBoundingClientRect: () => ({ width: 400, height: 300, left: 300, top: 250 }) };
  return { img, stack: inStack ? [img, ...below] : below };
}

const cases = [
  // ---- 会交给页面的 ----
  ['站点自带查看器：fixed 全屏层压在页面内容上（cases 006）', scene([layer({ fixed: true }), content(), BODY, HTML]), true],
  [
    '腾讯文档：遮罩 z=-5 与图是兄弟，图外夹一层 89% 宽的静态包装（cases 014）',
    scene([layer({ size: [890, 700] }), layer({ fixed: true }), layer({ kids: 3 }), BODY, HTML]),
    true,
  ],
  [
    'HxBuddy：对话框挂在 app 根容器里，根容器之下才是页面内容（cases 014）',
    (() => {
      const dialog = layer({ fixed: true });
      return scene([dialog, layer({ wraps: [dialog] }), content(), BODY, HTML]);
    })(),
    true,
  ],
  ['知乎：fixed 遮罩与图并列挂在 body 下（cases 009）', scene([layer({ fixed: true, kids: 0 }), content(), BODY, HTML]), true],

  // ---- 不该交给页面的（每一条都是一种「整站失效」或误伤） ----
  ['普通文章图：下面只有正文与 body', scene([content(), BODY, HTML]), false],
  ['app 外壳：fixed 全屏，图在里面，外壳之下只有 body', scene([layer({ fixed: true }), BODY, HTML]), false],
  [
    '对话框挂在 app 根容器里，但根容器之下什么都没有（整页就是这个容器）',
    (() => {
      const dialog = layer({ fixed: true });
      return scene([dialog, layer({ wraps: [dialog] }), BODY, HTML]);
    })(),
    false,
  ],
  ['外壳之下垫着一层空的 fixed 全屏装饰（视差底 / 渐变）', scene([layer({ fixed: true }), layer({ fixed: true, kids: 0 }), BODY, HTML]), false],
  ['fixed 层只盖了视口的 80%（侧栏 / 抽屉，不算接管屏幕）', scene([layer({ fixed: true, size: [800, 640] }), content(), BODY, HTML]), false],
  ['盖满视口但不是 fixed（普通流里的大块容器）', scene([layer(), content(), BODY, HTML]), false],
  ['图不在命中栈里（被遮住、在视口外）：判不出就不猜', scene([layer({ fixed: true }), content(), BODY, HTML], { inStack: false }), false],
];

let pass = 0;
const fails = [];
const results = [];

function run(name, want, fn) {
  let got;
  try {
    got = fn();
  } catch (e) {
    got = `抛错 ${e.message}`;
  }
  if (got === want) pass++;
  else fails.push(`${name}：期望 ${want}，得到 ${got}`);
  results.push([name, want, got === want]);
}

for (const [name, { img, stack }, want] of cases) {
  run(name, want, () => {
    ctx.__stack = stack;
    return Closer.shelled(img);
  });
}

// 另外两件事：此刻我们根本没法展示。它们先于命中栈判定，栈里有什么都不影响。
const plain = scene([content(), BODY, HTML]);
run('全屏中：交给页面（我们开了也看不见）', true, () => {
  ctx.__stack = plain.stack;
  ctx.document.fullscreenElement = {};
  try {
    return Closer.shelled(plain.img);
  } finally {
    ctx.document.fullscreenElement = null;
  }
});
run('本页打开过却看不见自己（cases 013）：交给页面', true, () => {
  ctx.__stack = plain.stack;
  Closer.state.unseen = true;
  try {
    return Closer.shelled(plain.img);
  } finally {
    Closer.state.unseen = false;
  }
});

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length));
for (const [name, want, ok] of results) {
  const bad = fails.find((f) => f.startsWith(name + '：'));
  console.log(`${ok ? '✓' : '✗'} ${pad(name, 30)} ${ok ? '→ ' + want : bad.slice(name.length + 1)}`);
}

console.log(`\n${pass}/${results.length} 通过`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log('  ' + f);
}
process.exit(fails.length ? 1 : 0);
