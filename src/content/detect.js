'use strict';

var Closer = (window.Closer ||= {});

// 判断器。只有一个问题：这张图值得打开吗？
// 它不知道「看图器」是什么——那是让位检测的活。
// 顺序有讲究：便宜的在前，否决即返回。

const IMAGE_EXT = /\.(avif|webp|jpe?g|png|gif|apng|svg|bmp|ico|jfif)(?:[?#]|$)/i;

const CONTROL =
  'button,[role="button"],label,select,input,textarea,summary,option,' +
  '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

// 只认「明确声明了归属」的图集。声明式，零成本，让开不心疼。
const KNOWN_VIEWER =
  '[data-lightbox],[data-fancybox],[data-fslightbox],[data-featherlight],[data-zoom],a[rel~="lightbox"]';

const MIN_RENDER = 40; // 渲染后的边长下限：图标、头像、sprite
const MIN_AREA = 40000; // 原始面积下限，约 200 × 200
const MIN_SIDE = 48; // 原始短边下限：横幅、分割线、长条
const SQUARE_MAX = 600; // 正方形小图的上限：二维码、头像几乎都在这条线以下

Closer.judge = function (img) {
  // 1 还没解码。懒加载占位符就走这条。
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) return false;

  // 2 页面上画得太小。同时挡住 display:none（rect 全 0）。
  const rect = img.getBoundingClientRect();
  if (rect.width < MIN_RENDER || rect.height < MIN_RENDER) return false;

  // 3 原图太小，放大只会更糊。40 000 px² 是二维码那次实测后定的。
  if (nw * nh < MIN_AREA) return false;

  // 4 短边太短：横幅、分隔线、细长条。
  if (Math.min(nw, nh) < MIN_SIDE) return false;

  // 5 开发者显式要求别碰。
  if (img.closest('[data-closer-ignore]')) return false;

  // 6 控件里的图，点击属于控件。
  if (img.closest(CONTROL)) return false;

  // 7 页头页脚里的小图是 logo。
  const bar = img.closest('header,nav');
  if (bar && rect.height < 80) return false;

  // 8 用户想下载，不是想看。
  if (img.closest('a[download]')) return false;

  // 9 图片被链接包着：他要去看那个链接指向的东西（商品页、文章），
  //   只有两种例外——链接指向图片本身（我们比裸图跳转更好），或者裸锚点。
  const a = img.closest('a');
  if (a) {
    const href = (a.getAttribute('href') || '').trim();
    if (!IMAGE_EXT.test(href) && href !== '#') return false;
  }

  // 10 站点自己声明了查看器（图集库的约定），或者此刻就在一个对话框里。
  if (img.closest(KNOWN_VIEWER)) return false;
  if (img.closest('dialog[open],[role="dialog"][aria-modal="true"]')) return false;

  // 11 正方形小图：二维码、头像。点他是想扫它、或者看这个人，不是想看这张图。
  //    代价写在 D25：500 × 500 的正方形插画会被一起跳过。
  if (nw === nh && nw < SQUARE_MAX) return false;

  // 12 祖先链上有一块自己声明了 cursor:pointer 的区域：设计者把它做成了可点区域。
  if (clickBox(img)) return false;

  // 13 页面把它放进了背景层：图自己或某层祖先声明了负 z-index。
  if (behind(img)) return false;

  // 14 其余：打开。
  return true;
};

/**
 * 这一下点的是哪张图。
 *
 * 多数时候 target 就在图里，closest 一次就够；但图上方常盖着一层透明装饰
 * （图库的致谢遮罩、卡片的悬停层），点击落在装饰上，target 与图毫无关系。
 * 光看事件目标，这整类站点会表现为「点了没反应」，而页面自己什么也没做。
 * 那种情况只能用命中点栈把图找回来。
 *
 * 四条边界：
 *   1. 点中的东西自己在做事（链接、控件）就不接管——那是页面的意图，不是看这张图。
 *   2. 图必须和点击落在同一块地方：往上找共同祖先，body / html 不算；
 *      否则点浮层、点页头会把下面任意一张图拽出来。
 *   3. 命中栈不穿 shadow，图被做进 Web Component 时要逐层下钻（见 fromPoint）。
 *   4. 找回来的图若铺满视口宽度，它是版面的底，不是被盖住的那张图（见 fullBleed）。
 */
Closer.pick = function (target, x, y) {
  if (!(target instanceof Element)) return null;

  const inside = target.closest('img');
  if (inside) return inside;

  if (target.closest('a,' + CONTROL)) return null;

  return fromPoint(target, x, y);
};

/**
 * 命中点上的图。
 *
 * elementFromPoint 不穿 shadow：站点把「图 + 遮罩」做进 Web Component 时，
 * 命中栈里只有 host。所以栈顶若是带 shadowRoot 的宿主，就下钻一层再看——
 * 最多三层，再深的组件套组件不值得为它付复杂度。
 * 下钻不需要额外的信任判断：图仍要过 sameFrame()，隔着组件猜的图会被挡掉。
 */
function fromPoint(target, x, y) {
  const MAX = 3;
  let scope = document;

  for (let depth = 0; depth < MAX; depth++) {
    let stack;
    try {
      stack = scope.elementsFromPoint(x, y);
    } catch {
      return null;
    }

    let inner = null;
    for (const node of stack) {
      if (node instanceof HTMLImageElement && sameFrame(target, node)) {
        // 栈里最上面那张就是版面的底时，再往下只会是更深的底：直接放弃，不继续找
        return fullBleed(node) ? null : node;
      }
      if (!inner && node.shadowRoot) inner = node.shadowRoot;
    }
    if (!inner) return null;
    scope = inner;
  }
  return null;
}

// 共同祖先要有边界：body 包含一切，认它就等于认「页面上的图都算」。
function sameFrame(from, img) {
  for (let n = from; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (n.contains(img)) return true;
  }
  return false;
}

/**
 * 命中栈找回来的这张图，是不是铺满了视口宽度。
 *
 * 为什么要它（`cases.md` 012）：bilibili 首页的页头横幅是 `<picture>`（2560×240），
 * 上面叠着二十几层视差 `<img>`（3840×360 的透明切片），再上面是装着 logo 链接的
 * `div.header-banner__inner`，铺满整条横幅。点页头任意空白处，target 是那个 div，
 * `pick()` 按命中点把最上面那层切片找回来，`judge()` 十三条全过（不在 `<header>`
 * 里、不在链接里、无 pointer、无负 z-index）——于是点一下页头，弹出半张透明切片。
 * 页头右侧的登录浮层也一样：点浮层的空白，下面的切片被拽出来。
 *
 * 这和 010（salesforce 的版面底图）是同一族：`pick()` 分不出「图上盖了装饰」
 * （004/005）与「图是版面的底、内容压在上面」，两者 DOM 同构。010 靠作者声明的
 * 负 z-index 区分；bilibili 没有任何声明，`z-index` 全是 `auto` / `0`——正是 010
 * 记下的那个「不修」缺口。剩下唯一不同的是几何：被装饰盖住的是**一张图**，有它
 * 自己的版面宽度（004 的 925 px 照片）；版面的底要垫住整块版面，所以横跨整个视口。
 *
 * 只在找回路径上生效，图被直接点中（target 就是 img）时不问：文章里的全宽图、
 * 用户直接点它，照常打开。悬停提示同理不受影响（它只认指针底下的那张图本身）。
 *
 * 代价：全宽照片上盖一层透明装饰、点击落在装饰上的图库页会被漏开；窗口很窄时
 * 004 那类照片也可能铺满视口而漏开。按第二条，漏图可接受，误接管不可接受。
 */
function fullBleed(img) {
  const FULL = 0.98; // 局部常量：顶层 const 会和其它 content 文件的声明撞车。留 2% 给取整与滚动条
  const vw = document.documentElement.clientWidth || innerWidth;
  return img.getBoundingClientRect().width >= vw * FULL;
}

/**
 * 找「声明了 cursor:pointer 的那层容器」，找不到返回 null。
 *
 * 为什么要它：H5 活动页把整张卡片做成 <section> + JS 事件委托，既不是 <a>
 * 也不是 <button>，没有 role、没有 onclick 属性——上面十条一条都拦不住；而它点击后
 * 只改自己某个元素的文字/class，让位检测的四判据（href / fullscreen / 命中点 /
 * 滚动锁）全部沉默。这是让位模型的结构性盲区，只能靠静态信号兜。
 *
 * 为什么不是 D10 删掉的 zoom-in：pointer 没有方向歧义，只表示「点我」，
 * 不像 zoom-in 还暗示「能放大」。所以这不是把那条规则加回来。
 *
 * cursor 是继承属性，必须只认「声明的边界」：父元素也是 pointer 就说明它从更上层
 * 继承来的，继续往上找；到 body 都没有边界就当没有，否则 body{cursor:pointer}
 * 的页面会让整站失效。
 */
function clickBox(img) {
  const MAX = 8; // 局部常量：顶层 const 会和其它 content 文件的声明撞车
  let n = img;

  for (let i = 0; i < MAX && n; i++, n = n.parentElement) {
    if (n === document.body || n === document.documentElement) return null;
    if (getComputedStyle(n).cursor !== 'pointer') continue;

    const up = n.parentElement;
    if (up && up !== document.body && getComputedStyle(up).cursor === 'pointer') continue;
    return n;
  }
  return null;
}

/**
 * 页面把它放进了背景层吗。
 *
 * 拦的不是 CSS 的 `background-image`（那种图我们本来就看不见，也不需要拦），
 * 而是页面用 `<img>` 当版面的底（salesforce 的 blade 背景就是这个写法），
 * 内容压在它上面，点击落在内容或版面的空白处，`pick()` 会把这张底图找回来，
 * 接着被我们接管（`cases.md` 010）。宪法的非目标里写着背景图，它不能被接管。
 *
 * 信号是**负 z-index**，它唯一的含义是「放到内容后面」，是作者自己说的「我是底」。
 * 不像 `cursor:zoom-in`（D10）那样方向不明。`getComputedStyle` 对静态定位元素
 * 也返回声明值（实测 salesforce 的 `img.background__image` 是 `position:static`
 * + `z-index:-1`），所以不必先看 position。只认声明值 `< 0`：`z-index:0` 与 `auto`
 * 都不算，内容图被 `z-index:0` 抬进自己的层是常见写法，那不是「我是底」。
 *
 * 为什么要往上找：图自己是 `auto`、只有 wrapper 声明 `-z-10`（Tailwind 的
 * `-z-10` + `relative isolate`）同样成立。到 body 为止，最多 8 层，与 `clickBox`
 * 同口径。
 *
 * 代价（D33）：用负 z-index 实现的真内容图（视差装饰图之类）会被一起跳过。
 * 按第二条，漏图可接受，误接管不可接受。010 当时记下的缺口——背景图用
 * `z-index:auto` 的 `absolute` 铺满、内容用定位压在上面——静态层面和普通大图无法
 * 区分；它在 `pick()` 的找回路径上由 `fullBleed()` 兜住（`cases.md` 012），不在这里。
 */
function behind(img) {
  const MAX = 8; // 局部常量：顶层 const 会和其它 content 文件的声明撞车
  let n = img;

  for (let i = 0; i < MAX && n; i++, n = n.parentElement) {
    if (n === document.body || n === document.documentElement) return false;
    if (parseInt(getComputedStyle(n).zIndex, 10) < 0) return true;
  }
  return false;
}
