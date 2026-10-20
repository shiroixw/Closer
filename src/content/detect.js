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

  // 11 其余：打开。
  return true;
};
