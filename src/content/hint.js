'use strict';

var Closer = (window.Closer ||= {});

// 悬停提示：用浏览器原生的 zoom-in 光标，不画图标、不注入常驻样式。
//
// 为什么不是「常驻低优先级样式」（`@layer` + `:where(img)`）：`@layer` 确实是
// 「页面永远赢」的正解——未分层的作者样式恒胜——但 cursor 是**继承**属性，
// 「在 img 上声明一个值」会打断继承。页面把 `pointer` 写在整张卡片上、图靠继承
// 拿到手里的那种结构（D24 那次 H5 卡片），一旦我们声明了 img，光标就从「点我」
// 变成「能放大」，恰好在页面已经把话说清楚的地方撒谎。CSS 读不到祖先的 computed
// cursor（`:has()` 只看结构），所以这不是选择器写全就能解决的问题；同理它也表达
// 不了 judge() 里的链接方向、面积与正方形规则。
//
// 所以门控必须由判断器来做：逐张写，离开即还原。写的是 inline style——这是我们
// 能造成的、最小且完全可逆的那种页面改动（第三条）：撤销时把属性整个删掉，
// 不留 `style=""` 这种痕迹。
//
// 自咬的三道闸：
//   1. judge() 通过才写：能开才给手势，光标不说谎。
//   2. 页面已经声明过 cursor（computed 不是 `auto`）就不碰——zoom-in 是页面自己的，
//      default 是页面自己的规矩，grab 是地图的。
//   3. 还原发生在 snapshot() 之前（boot 取基线前调 reset）：skin 判据读的是
//      style 属性，我们的撤销若跨过那次基线，页面明明没动也会被判成「认领了这次点击」。

Closer.hint = (function () {
  const ZOOM = 'zoom-in';
  // 没有 dwell：指针进入就写，离开就撤——**和站点自己写 `img{cursor:zoom-in}` 完全一致**。
  //
  // 曾经有过一版 140 ms（后来 70 ms）的停留判定，理由是「掠过图集不闪、只在指针停下时
  // 才改页面」。2026-10-23 实测把它否掉了：judge() 0.0128 ms、getComputedStyle 0.0002 ms、
  // 写一次 inline style 微秒级——所谓「预处理/降低判断成本」省的只有 13 µs，而它带来的
  // 77–91 ms 端到端延迟是纯粹的手感损失。而「掠过一个图集时光标跳几下」恰恰是原生
  // `img{cursor:zoom-in}` 的行为，用户把它读成「这些能点」，不是闪。
  //
  // 代价（如实记着）：指针扫过一排缩略图会多几次 inline 写，每次微秒级，且都在
  // pointerover / 下一个目标上即时撤销。

  let cur = null; // { el, had, prev }：光标此刻被我们改着的那张图

  function restore() {
    if (!cur) return;

    const { el, had, prev } = cur;
    cur = null;
    if (el.style.cursor !== ZOOM) return; // 页面期间自己改过：那是页面的事，不覆盖
    el.style.cursor = prev; // prev 通常是 ''
    // 本来没有 style 属性的，撤销后会留下一个空属性：删掉才算真的还原（第三条）
    if (!had && !el.getAttribute('style')) el.removeAttribute('style');
  }

  function show(img) {
    // 页面已经在自己那一层里展示它了：不再重复表态
    if (!img.isConnected || Closer.isPaused() || Closer.overlay.isOpen()) return;
    if (!Closer.judge(img)) return; // 打不开的图不给手势：这是光标不说谎的唯一来源
    if (Closer.shelled(img)) return;
    if (getComputedStyle(img).cursor !== 'auto') return; // 页面自己的手势优先

    cur = { el: img, had: img.hasAttribute('style'), prev: img.style.cursor };
    img.style.cursor = ZOOM;
  }

  function onOver(e) {
    // 触屏与笔没有「悬停」语义：不写，也不留残影
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return restore();

    // 只认指针底下的那张图本身。图被透明装饰盖住时（cases 004）这里什么都不做：
    // 悬停提示是「锦上添花」，为它每次移动都跑一次 elementsFromPoint 不划算，
    // 而漏提示按第二条是可接受的。
    const img = e.target instanceof Element ? e.target.closest('img') : null;
    if (!img) return restore();
    if (cur && cur.el === img) return; // 已经亮着

    restore(); // 换了目标：先把上一张收干净
    if (!Closer.state.ready || Closer.isPaused() || Closer.overlay.isOpen()) return;

    show(img);
  }

  return {
    // 加载期唯一新增的监听（宪法第六条由 2 改成 3，理由与代价见 D32）。
    // 不并进 click 处理器：悬停与点击是两件事，混在一起两者都更难读。
    attach() {
      addEventListener('pointerover', onOver, true);
    },
    // boot 在 snapshot() 之前调用；core 在暂停生效时调用
    reset: restore,
  };
})();
