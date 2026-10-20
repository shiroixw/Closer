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
 */
Closer.acted = function (b) {
  if (location.href !== b.href) return 'href';
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
