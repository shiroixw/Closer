'use strict';

var Closer = (window.Closer ||= {});

// 接线。唯一允许同时认识 judge / snapshot / overlay 的地方。
// 时序底线：click → open 之间只隔一次 rAF，中间不许出现 await（技术方案 2）。

(function () {
  /**
   * rAF 与 32ms 定时器谁先到用谁：
   * 后台标签页里 rAF 不一定会触发，只挂 rAF 会永远不开。
   */
  function settle(fn) {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      fn();
    };
    requestAnimationFrame(run);
    setTimeout(run, 32);
  }

  function onClick(e) {
    if (e.button !== 0) return;
    // 带修饰键的点击是用户明确要走别的路径（⌘ 开新标签页等），一律放行
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    if (!Closer.state.ready || Closer.isPaused()) return;
    if (Closer.overlay.isOpen()) return;

    const target = e.composedPath()[0];
    const img = target instanceof Element ? target.closest('img') : null;
    if (!img || !Closer.judge(img)) return;

    const base = Closer.snapshot(e.clientX, e.clientY);
    e.preventDefault(); // 只掐默认行为，不阻断传播：页面自己的处理器照常跑

    settle(() => {
      if (!Closer.acted(base)) Closer.overlay.open(img, base);
    });
  }

  Closer.load().finally(() => {
    addEventListener('click', onClick, true);
  });
})();
