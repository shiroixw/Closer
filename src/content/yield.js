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
 *
 * 命中时顺手记住它动出来的那一层。只判「这一次」是不够的：站点开着自己的
 * 查看器时，后续每一次点击都发生在它已经接管的状态里，四项判据全部沉默（case 006）。
 */
Closer.acted = function (b) {
  if (location.href !== b.href) return 'href';
  // 站点就地放大的形态：元素没换、位置没动，只有它自己（或它的盒子）被改写了。
  if (b.skin && skinChanged(b.skin)) {
    // 这条分支没有「多出来的那一层」可记，但「页面接管过」这件事成立。
    // 漏掉这一句的代价是具体的：知乎在打开查看器时把被点的缩略图设成
    // visibility:hidden，于是第一次放大走的是 skin、而不是 hit，`remember()`
    // 一次都不跑 → 紧接着的**第一次**缩小仍然会叠一层（真机 1/3，cases 009）。
    Closer.state.yielded = true;
    return 'skin';
  }
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
  // hit / scroll / 迟到纠正三条让位路径都经过这里，所以「本页接管过」在这里落账。
  // 它与「记住了哪一层」是两件事：层可能根本记不下来——站点把遮罩做成图的兄弟
  // （cases 009），观测本身仍然成立，之后靠静态存量判据接着用（见 shelled）。
  Closer.state.yielded = true;

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
  if (shell) {
    if (!shell.isConnected || !coversViewport(shell)) {
      Closer.state.shell = null; // 层被关掉、被卸载：判死并忘掉
    } else if (shell.contains(img)) {
      return true;
    }
  }

  // 有的站点根本不建「层」：知乎把遮罩和图做成 <body> 下的兄弟节点，图的祖先链一步
  // 就到 body，remember() 一个东西也记不下（cases 009）。它留下的唯一痕迹是指针——
  // 查看器里那张图的 cursor 是 zoom-out。这是**状态**，不是变化：读一次就知道站在
  // 哪儿，不依赖帧序，也不需要观察窗口。所以它比 skin 更稳：知乎在**我们判定之后**
  // 才写 style（实测决策帧 2.8 ms、写入 9.4 ms），第 5 判据那天总是晚一步（D31）。
  //   只认 zoom-out：zoom-in 有方向歧义，只写了样式、没有处理器的图也会声明它（D10）；
  //   还要 yielded：cursor 是声明不是观测，单独拿它当预言会误伤那类页面（tech-spec c4）。
  //   观测在先，声明只用来延长观测的寿命。
  return Closer.state.yielded && getComputedStyle(img).cursor === 'zoom-out';
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
