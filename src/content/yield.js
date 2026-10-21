'use strict';

var Closer = (window.Closer ||= {});

// 让位检测：我们不抢，我们排队。
// click 那一刻拍一张快照，下一帧再拍一张，比出页面有没有自己动手。

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
 * 于是我们照样打开，两层缩放叠在一起，关掉之后页面还停在放大状态（cases 004）。
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
  // 站点就地放大的形态：元素没换、位置没动，只有它自己（或它的盒子）被改写了。
  if (b.skin && skinChanged(b.skin)) return 'skin';
  if (!!document.fullscreenElement !== b.fs) return 'fullscreen';

  const now = document.elementFromPoint(b.x, b.y);
  if (now !== b.hit && !Closer.isOurs(now)) return 'hit';

  if (scrollLocked() !== b.locked) return 'scroll';
  return '';
};

// 迟到纠正只关心一件事：点击点是不是被页面盖住了。
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
    return false;
  }
  if (!under) return false; // 除了我们自己什么都没有，页面没动
  return under !== b.hit;
};

/**
 * 有些站点的查看器要等图片取回来才挂。
 * 打开之后补两次检查，要是这时候被盖住，我们自己关掉。
 * 会闪一下，但比两张查看器叠着强。
 */
Closer.watchLate = function (b, onIntrude) {
  const timers = [600, 1200].map((ms) =>
    setTimeout(() => {
      if (Closer.covered(b)) onIntrude();
    }, ms)
  );
  return () => timers.forEach((t) => clearTimeout(t));
};
