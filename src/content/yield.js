'use strict';

var Closer = (window.Closer ||= {});

// 让位检测：我们不抢，我们排队。
//
// 判断器只问「这张图值不值得看」（元素与祖先链，O1 / D10）；页面此刻在做什么，归这里。
// 这里有两类信号，回答两个不同的问题，不要混在一起：
//   · 增量（snapshot / acted）：页面对「这一下点击」做了什么。
//     点击那一刻拍一张快照，下一帧再拍一张，比出页面有没有自己动手。
//     就地放大、整卡 JS 事件只能这样看——页面动手之前，屏幕上什么都看不出来。
//   · 电平（shelled → onTopLayer）：图此刻是不是站在页面自己的顶层上。
//     站点自带查看器开着时，之后每一次点击都落在它里面，这只能读此刻的屏幕，
//     不能靠「看见页面开它」去记——打开它的那一下常常根本没经过我们（cases 014）。
//   曾经这里有一整套「记住页面开出来的那一层」的机制（state.shell / yielded / remember），
//   006 / 008 / 009 一路补丁都在给它打；改成读电平之后它没有活可干，整段删除（D43）。

function scrollLocked() {
  // 会触发样式重算，所以放在所有判据的最后。
  const de = document.documentElement;
  if (!de) return false;
  if (getComputedStyle(de).overflowY === 'hidden') return true;
  const body = document.body;
  return !!body && getComputedStyle(body).overflowY === 'hidden';
}

// overlay 自己的节点不算「页面动了」，否则一打开就会把自己判成入侵者。
Closer.isOurs = function (node) {
  const host = Closer.state.host;
  return !!node && !!host && (node === host || host.contains(node));
};

/**
 * 一个元素「自己的外观」：style 与 class 两个属性拼成一个签名。
 *
 * 为什么需要它：Pexels 的照片页点一下，会把 transform: scale(3) 写回
 * 同一个 <img>，就地放大（cursor 由 zoom-in 变 zoom-out）。而 href 没变、
 * fullscreen 没变、命中点还是那个元素、滚动也没锁——四个判据全部沉默，
 * 于是我们照样打开，两层缩放叠在一起，关掉之后页面还停在放大状态（cases 007）。
 *
 * 比属性、不比几何：hover 缩放走样式表，不写属性，所以不会误伤；
 * 而「点击之后站点改写了这个元素」是一个不会在别的页面上随便成立的信号。
 */
function skinOf(el) {
  return (el.getAttribute('style') || '') + '\n' + (el.getAttribute('class') || '');
}

/**
 * 被点的那张图，加上紧邻的几层容器。
 *
 * 为什么不是只看 <img>：同一个放大镜换一种写法——把 class 加在包着图的
 * 容器上、让 CSS 去缩放里面的图——图自己的属性一个字都没变，一样会漏。
 * 这层容器就是「图片所在的盒子」，它被改写，几乎只可能是页面认领了这次点击。
 *
 * 为什么到 body 为止，且只认五层：body / html 上的 class 常年被菜单、
 * 主题、弹窗改写，那不是这次点击的证据；而真正的放大盒不会离图那么远。
 */
function skinChain(el) {
  const UP = 5; // 局部常量：顶层 const 会和其它 content 文件的声明撞车
  const out = [{ el, skin: skinOf(el) }];

  let n = el.parentElement;
  for (let i = 0; i < UP && n; i++, n = n.parentElement) {
    if (n === document.body || n === document.documentElement) break;
    out.push({ el: n, skin: skinOf(n) });
  }
  return out;
}

function skinChanged(chain) {
  for (const it of chain) if (skinOf(it.el) !== it.skin) return true;
  return false;
}

/**
 * 记基线。必须在 click 处理器里同步调用。
 * hit 存的是元素引用，不是「是不是那张图」——
 * 卡片布局里图上方常年盖着链接或遮罩，按「是不是图」判会永远误判。
 */
Closer.snapshot = function (x, y, img) {
  return {
    href: location.href,
    fs: !!document.fullscreenElement,
    locked: scrollLocked(),
    hit: document.elementFromPoint(x, y),
    skin: img ? skinChain(img) : null,
    x,
    y,
  };
};

/**
 * 页面有没有自己动手。返回命中的判据名，没有则空串。
 * 顺序按代价排：字符串比较 → 属性读取 → 布局 → 样式重算。
 */
Closer.acted = function (b) {
  if (location.href !== b.href) return 'href';
  // 站点就地放大的形态：元素没换、位置没动，只有它自己（或它的盒子）被改写了（cases 007）。
  if (b.skin && skinChanged(b.skin)) return 'skin';
  if (!!document.fullscreenElement !== b.fs) return 'fullscreen';

  const now = document.elementFromPoint(b.x, b.y);
  if (now !== b.hit && !Closer.isOurs(now)) return 'hit';

  if (scrollLocked() !== b.locked) return 'scroll';
  return '';
};

/**
 * 这张图此刻该不该交给页面：页面正以它自己的方式展示着它，或者我们根本没法展示。
 *
 * 点击与悬停光标都经过这里（都在 judge() 之后），所以两边口径一致：不开，也不给 zoom-in。
 * 三件事都是**此刻的状态**，读一次就知道，不依赖我们刚才看见过什么。
 */
Closer.shelled = function (img) {
  if (document.fullscreenElement) return true; // 全屏时我们开了也看不见
  // 这页上打开过一次却看不见自己（cases 013）：后面每次点击都只会被吃掉，干脆退场。
  // 一次观测换整页让位，只到刷新为止——它是观测不是猜测，不落进暂停列表，也不跨页。
  if (Closer.state.unseen) return true;
  return onTopLayer(img);
};

/**
 * 图是不是正站在页面自己的顶层上。
 *
 * 为什么要它（`cases.md` 014）：腾讯文档、HxBuddy 的图片预览都是 `position:fixed`
 * 铺满视口的一层，图在里面。打开它的那一下点击落在缩略图上——缩略图要么过不了
 * `judge()`（pointer 光标、太小，`boot.js` 在那里就 return，连快照都不拍），要么预览
 * 是恢复出来、脚本开的，根本没有那一下点击。于是「页面开过一层」这件事我们一次都没
 * 记下，之后点预览里的图，我们照样叠一层。
 *
 * 所以这里不记，只读：命中栈自上而下，图之下若有一层 `position:fixed`、宽高都盖住
 * 90% 视口的元素，并且它之下还有不属于它的页面内容，就是「页面在自己的内容之上又盖
 * 了一层全屏的东西，图站在那层上」。这正是站点自带查看器的结构定义，与站点、框架、
 * 遮罩与图是不是兄弟、中间夹几层包装、有没有锁滚动、光标写什么都无关。
 *
 * 三处必须守住的边界（每一处都有反例，见 `tools/test-yield.mjs`）：
 *   1. 层取自**命中栈**，不是全树扫描：HxBuddy 有一个 `pointer-events:none` 的 fixed
 *      全屏 toast 容器（占视口 98.9%），它不接事件，所以不在栈里——全树扫描会把它当成
 *      顶层，整站失效。
 *   2. 层之下必须还有页面内容：app 外壳（fixed 全屏、图就在里面、外壳下只有 body）
 *      不算顶层，否则整站失效。包着这一层的祖先也不算「被压着的内容」。
 *   3. 层之下那块若是铺满视口、没有子节点的 fixed 空装饰（视差底、渐变），不算内容，
 *      继续往下看。
 *
 * 判不出就不猜：图不在命中栈里（被遮住、在视口外、`pointer-events:none`）时返回 false。
 * 这条只为「不开」加信心，不会把 judge() 已否决的图救回来（第二条）。
 *
 * 代价（D43）：fixed 全屏外壳之下若还垫着**带子节点**的 fixed 层（背景里放 canvas），
 * 整站的图都会被当成站在顶层上而不开；只在图中心采一个点，页面很短、内容没盖到图中心
 * 时漏判；只认 `fixed`，不认 `absolute` 的全页查看器（放宽会误伤主内容容器）。
 */
function onTopLayer(img) {
  const COVER = 0.9; // 局部常量：顶层 const 会和其它 content 文件的声明撞车
  const vw = innerWidth;
  const vh = innerHeight;

  const covers = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= vw * COVER && r.height >= vh * COVER;
  };
  const fixedFull = (el) => getComputedStyle(el).position === 'fixed' && covers(el);
  const edge = (el) => el === document.body || el === document.documentElement;

  const r = img.getBoundingClientRect();
  const x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
  const y = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);

  let stack;
  try {
    stack = document.elementsFromPoint(x, y);
  } catch {
    return false;
  }

  // 从图开始往下读：图之上的东西一概不看。
  const at = stack.indexOf(img);
  if (at < 0) return false;

  for (let i = at + 1; i < stack.length; i++) {
    const layer = stack[i];
    if (edge(layer)) return false; // 走到 body / html 都没遇到层
    if (!fixedFull(layer)) continue;

    // 层之下还有没有「页面内容」：不包着这一层、也不是空装饰。
    // body / html 包着一切，所以它们在这里必然被跳过——走到头就等于「下面是空的」，
    // 也就是这一层是 app 外壳而不是叠在内容之上的查看器（cases 014 的代价清单第 1 条）。
    for (let j = i + 1; j < stack.length; j++) {
      const under = stack[j];
      if (under.contains(layer)) continue; // 包着这一层的祖先，不是被压着的内容
      if (fixedFull(under) && !under.childElementCount) continue; // 空装饰
      return true;
    }
    return false;
  }
  return false;
}

// 迟到纠正只关心一件事：点击点是不是被页面盖住了。
// 返回盖住它的那个元素，没被盖住返回 null。
//
// 这里必须用 elementsFromPoint（复数）并从下往上剪掉自己：
// overlay 打开后 host 是 fixed + 最高 z-index，elementFromPoint 永远返回它，
// 用它做判据的话，站点在下面挂什么我们都看不见——迟到纠正会彻底失效。
Closer.covered = function (b) {
  let under = null;
  try {
    for (const node of document.elementsFromPoint(b.x, b.y)) {
      if (!Closer.isOurs(node)) {
        under = node;
        break;
      }
    }
  } catch {
    return null;
  }
  if (!under || under === b.hit) return null; // 除了我们自己什么都没有，页面没动
  return under;
};

/**
 * 有些站点的查看器要等图片取回来才挂。
 * 打开之后补两次检查，要是这时候被盖住，我们自己关掉。
 * 会闪一下，但比两张查看器叠着强。
 *
 * 不需要记那一层：它挂上之后就是页面自己的顶层，下一次点击由 shelled() 读到。
 */
Closer.watchLate = function (b, onIntrude) {
  const timers = [600, 1200].map((ms) =>
    setTimeout(() => {
      if (!Closer.covered(b)) return;
      onIntrude();
    }, ms)
  );
  return () => timers.forEach((t) => clearTimeout(t));
};
