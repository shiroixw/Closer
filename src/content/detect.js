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

  // 11 祖先链上有一块自己声明了 cursor:pointer 的区域：设计者把它做成了可点区域。
  if (clickBox(img)) return false;

  // 12 其余：打开。
  return true;
};

/**
 * 找「声明了 cursor:pointer 的那层容器」，找不到返回 null。
 *
 * 为什么要它：H5 活动页把整张卡片做成 <section> + JS 事件委托，
 * 既不是 <a> 也不是 <button>，没有 role、没有 onclick 属性——上面十条一条都拦不住。
 * 而它点击后只改自己某个元素的文字/class，让位检测的四个判据
 * （href / fullscreen / 命中点 / 滚动锁）全部沉默，于是被我们接管。
 * 这是让位模型的结构性盲区，只能靠静态信号兜。
 *
 * 为什么不是 D10 删掉的 zoom-in：pointer 没有方向歧义，它只表示「点我」，
 * 不像 zoom-in 还暗示「能放大」。所以这不是把那条规则加回来。
 *
 * cursor 是继承属性，必须只认「声明的边界」：父元素也是 pointer 就说明它是从
 * 更上层继承来的，继续往上找；一路到 body 都没有边界就当没有——否则
 * body{cursor:pointer} 的页面会让整站失效。
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
