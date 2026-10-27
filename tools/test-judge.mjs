// judge() 的单元测试。纯函数，所以不需要浏览器。
// 每条规则至少一个反例——不能失败的测试没有意义。

import fs from 'node:fs';
import vm from 'node:vm';

const SRC = new URL('../src/content/detect.js', import.meta.url);
const src = fs.readFileSync(SRC, 'utf8');

// judge() 现在会摸 getComputedStyle（cursor 与 zIndex 两个判据），桩里给一个只看
// __cursor / __z 的假实现。zIndex 缺省给 'auto'，和浏览器对未声明的元素一致。
const ctx = {
  window: {},
  document: { body: {}, documentElement: {} },
  getComputedStyle: (n) => ({ cursor: n?.__cursor || 'auto', zIndex: n?.__z ?? 'auto' }),
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const judge = ctx.window.Closer.judge;

// 桩：closest 只认「这个节点身上挂了哪些选择器片段」。
// 真实选择器按逗号拆开后，正好都是这些片段。
// href 给出时，closest('a') 返回一个能被 getAttribute 读到的锚点。
// parents 是自近而远的祖先，用来构造 cursor:pointer 的继承链（clickBox）
// 与负 z-index 的背景层（behind）。
function img({ nw = 800, nh = 600, w = 400, h = 300, closest = [], href, cursor = 'auto', z, parents = [] } = {}) {
  const set = new Set(closest);
  const anchor = href === undefined ? null : { getAttribute: (n) => (n === 'href' ? href : null) };
  const node = {
    naturalWidth: nw,
    naturalHeight: nh,
    __cursor: cursor,
    __z: z,
    parentElement: parents.reduce((down, p) => ({ __cursor: p.cursor || 'auto', __z: p.z, parentElement: down }), null),
    getBoundingClientRect: () => ({ width: w, height: h }),
    closest(selector) {
      if (!selector) return null;
      const parts = selector.split(',').map((s) => s.trim());
      if (anchor && parts.includes('a')) return anchor;
      for (const part of parts) {
        if (set.has(part)) return node;
      }
      return null;
    },
  };
  return node;
}

const cases = [
  ['正常的大图', img(), true],
  ['尚未解码（懒加载占位）', img({ nw: 0, nh: 0 }), false],
  ['渲染尺寸 30×30（头像）', img({ w: 30, h: 30 }), false],
  ['原始 150×150（二维码）', img({ nw: 150, nh: 150 }), false],
  ['原始 1000×40（横幅）', img({ nw: 1000, nh: 40, w: 1000, h: 40 }), false],
  ['[data-closer-ignore]', img({ closest: ['[data-closer-ignore]'] }), false],
  ['按钮里的图', img({ closest: ['button'] }), false],
  ['role=button 里的图', img({ closest: ['[role="button"]'] }), false],
  ['页头 60px 高的 logo', img({ w: 400, h: 60, closest: ['header'] }), false],
  ['页头里的大图', img({ w: 400, h: 300, closest: ['header'] }), true],
  ['a[download] 里的图', img({ closest: ['a[download]'] }), false],
  ['商品链接里的图', img({ closest: ['a'], href: '/product/1234' }), false],
  ['链接指向图片本身', img({ closest: ['a'], href: '/assets/photo.webp' }), true],
  ['data-lightbox 图集', img({ closest: ['[data-lightbox]'] }), false],
  ['rel=lightbox 链接', img({ closest: ['a[rel~="lightbox"]'] }), false],
  ['已打开的对话框里', img({ closest: ['dialog[open]'] }), false],
  ['裸锚点 a[href="#"]', img({ closest: ['a'], href: '#' }), true],
  ['无 href 的 a', img({ closest: ['a'], href: '' }), false],
  ['图片直链带查询串', img({ closest: ['a'], href: '/assets/photo.JPG?w=800' }), true],
  // 卡片：H5 活动页把整块做成 section + JS 事件委托，点击后只改自己的文字/class，
  // 让位检测完全看不见。图片本身 pointer 是继承来的，声明的边界在父容器上。
  ['配置卡片的横幅图（cursor 继承自容器）', img({ cursor: 'pointer', parents: [{ cursor: 'pointer' }] }), false],
  ['图片自己声明 cursor:pointer', img({ cursor: 'pointer' }), false],
  ['普通正文图', img({ cursor: 'auto' }), true],
  // km 调查页：正文图挂 `cursor: url(cursor_zoom.cur), pointer`，点击是 window.open 开新标签页，
  // 页面上再没有别的痕迹（无 <a>、无 role、无 onclick）。兜底写 pointer，语义仍是「点我」（D34）。
  ['自定义光标 + pointer 兜底（km）', img({ cursor: 'url("https://km.example.com/img/cursor_zoom.cur"), pointer' }), false],
  ['自定义光标带热点坐标，兜底 pointer', img({ cursor: 'url("hand.cur") 4 4, pointer' }), false],
  ['自定义光标在容器上，图靠继承', img({ cursor: 'url("zoom.cur"), pointer', parents: [{ cursor: 'url("zoom.cur"), pointer' }] }), false],
  ['自定义光标多段兜底（url, url, pointer）', img({ cursor: 'url("a.cur"), url("b.cur"), pointer' }), false],
  ['单值自定义光标（没有兜底，不算表态）', img({ cursor: 'url("only.cur")' }), true],
  ['光标兜底 auto，URL 里带 pointer（不能按子串判）', img({ cursor: 'url("/img/pointer.cur"), auto' }), true],
  ['自定义光标兜底 auto（可能只是皮肤，不算表态）', img({ cursor: 'url("skin.cur"), auto' }), true],
  // 正方形小图：二维码、头像。门槛 600，代价是正方形插画被一起跳过（D25）。
  ['250×250 二维码', img({ nw: 250, nh: 250, w: 250, h: 250 }), false],
  ['400×400 头像', img({ nw: 400, nh: 400, w: 300, h: 300 }), false],
  ['599×599（仍然算小正方形）', img({ nw: 599, nh: 599, w: 300, h: 300 }), false],
  ['600×600 不小了，照常打开', img({ nw: 600, nh: 600, w: 400, h: 400 }), true],
  ['800×800 正方形大图（可能是作品）', img({ nw: 800, nh: 800, w: 400, h: 400 }), true],
  // 背景层：页面用 <img> 当版面的底（salesforce 的 blade 背景），内容压在上面。
  // 负 z-index 是作者自己说的「我是底」；0 与 auto 都不是，内容图也会用它们抬层（D33）。
  ['图自己声明 z-index:-1', img({ z: -1 }), false],
  ['父容器声明 z-index:-1（背景层 wrapper）', img({ parents: [{ z: -1 }] }), false],
  ['祖先声明 z-index:-1（图自己是 auto）', img({ parents: [{}, { z: -1 }] }), false],
  ['祖先声明 z-index:0（抬进自己的层，不是背景）', img({ parents: [{ z: 0 }] }), true],
];

let pass = 0;
const fails = [];

for (const [name, node, want] of cases) {
  let got;
  try {
    got = judge(node);
  } catch (e) {
    got = `抛错 ${e.message}`;
  }
  if (got === want) {
    pass++;
  } else {
    fails.push(`${name}：期望 ${want}，得到 ${got}`);
  }
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length));
for (const [name, , want] of cases) {
  const bad = fails.find((f) => f.startsWith(name + '：'));
  console.log(`${bad ? '✗' : '✓'} ${pad(name, 26)} ${bad ? bad.split('：')[1] : '→ ' + want}`);
}

console.log(`\n${pass}/${cases.length} 通过`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log('  ' + f);
}
process.exit(fails.length ? 1 : 0);
