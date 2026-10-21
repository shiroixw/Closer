'use strict';

var Closer = (window.Closer ||= {});

// 让位检测：我们不抢，我们排队。
// click 那一刻拍一张快照，下一帧再拍一张，比出页面有没有自己动手。
// 页面动过之后还要记住它动出来的那一层：下一次点击就落在那层里面（case 006）。

const SHELL_COVER = 0.9; // 一层要盖住 90% 视口，才算「它把屏幕接管了」
const SHELL_DEPTH = 8; // 找那一层时最多看 8 层祖先

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
 * 记基线。必须在 click 处理器里同步调用。
 * hit 存的是元素引用，不是「是不是那张图」——
 * 卡片布局里图上方常年盖着链接或遮罩，按「是不是图」判会永远误判。
 */
Closer.snapshot = function (x, y) {
  return {
    href: location.href,
    fs: !!document.fullscreenElement,
    locked: scrollLocked(),
    hit: document.elementFromPoint(x, y),
    x,
    y,
  };
};

/**
 * 页面有没有自己动手。返回命中的判据名，没有则空串。
 * 顺序按代价排：字符串比较 → 属性读取 → 布局 → 样式重算。
 *
 * 命中时顺手记住它动出来的那一层。只判「这一次」是不够的：站点开着自己的
 * 查看器时，后续每一次点击都发生在它已经接管的状态里，四项判据全部沉默（case 006）。
 */
Closer.acted = function (b) {
  if (location.href !== b.href) return 'href';
  if (!!document.fullscreenElement !== b.fs) return 'fullscreen';

  const now = document.elementFromPoint(b.x, b.y);
  if (now !== b.hit && !Closer.isOurs(now)) {
    Closer.remember(now);
    return 'hit';
  }

  if (scrollLocked() !== b.locked) {
    Closer.remember(now);
    return 'scroll';
  }
  return '';
};

function coversViewport(node) {
  const r = node.getBoundingClientRect();
  return r.width >= innerWidth * SHELL_COVER && r.height >= innerHeight * SHELL_COVER;
}

/**
 * 页面刚刚出手时的那一层。
 *
 * 这不是「这个站点有没有查看器」那种归纳——那是用一次观测去赌整站的行为，
 * 代价是不可解释的整站失效（点卡片展开一下，全站图片从此都打不开）。
 * 这里记的是观测本身：这一刻屏幕上多出来的、盖住视口的那个容器。
 * 归因来自「它是在这次点击之后出现的」，不来自猜测，所以不需要任何阈值
 * 去判断它「像不像查看器」。
 *
 * 传 null 就什么都不记：命中点上没有新东西（命中点没变、只是滚动被锁），
 * 说明页面没有把屏幕接管在那张图身上。
 */
Closer.remember = function (node) {
  if (!node || Closer.isOurs(node)) return;

  for (let n = node, i = 0; n && i < SHELL_DEPTH; i++) {
    if (n === document.body || n === document.documentElement) return;
    if (coversViewport(n)) {
      Closer.state.shell = n;
      return;
    }
    // 命中栈不穿 shadow（case 005），祖先链也不穿：走到 shadow root 就跳到 host。
    const root = n.getRootNode();
    n = n.parentElement || (root instanceof ShadowRoot ? root.host : null);
  }
};

/**
 * 我们现在是不是正站在页面自己开的那一层里。
 *
 * 只问两件事：那层还在不在、里面是不是这张图。与图片的绘制尺寸、缩放、
 * 平移、加载状态全都无关——站点把图缩到 25%、放大后拖到一边，结论不变。
 *
 * 层被关掉、被卸载、被 display:none 掉：判死并忘掉。状态自愈，
 * 不需要过期时间，也不会留下一个用户看不见的站点名单。
 */
Closer.shelled = function (img) {
  if (document.fullscreenElement) return true; // 全屏时我们开了也看不见

  const shell = Closer.state.shell;
  if (!shell) return false;

  if (!shell.isConnected || !coversViewport(shell)) {
    Closer.state.shell = null;
    return false;
  }
  return shell.contains(img);
};

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
 * 慢半拍接管也是接管：同样记住那一层，否则下一次点击又会叠一层。
 */
Closer.watchLate = function (b, onIntrude) {
  const timers = [600, 1200].map((ms) =>
    setTimeout(() => {
      const under = Closer.covered(b);
      if (!under) return;
      Closer.remember(under);
      onIntrude();
    }, ms)
  );
  return () => timers.forEach((t) => clearTimeout(t));
};
