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

  /**
   * 按下那一刻的现场。click 只能告诉我们「点完了」，
   * 而「这是不是一次点击」必须在按下时就记下来——选区在 mousedown 时就被折叠了，
   * 到 click 再问一定得到空字符串。
   */
  let down = null;

  const DRAG_SLOP = 6; // 位移超过 6 px 是在拖，不是在点
  const HOLD_MS = 600; // 按住超过 600 ms 是在读，不是在点
  const WIKI_FILE = /\/wiki\/File:|title=File:/i;

  function passOpen(img) {
    if (Closer.judge(img)) return true;
    if (!Closer.isTakeover()) return false;
    const a = img.closest('a');
    if (!a) return false;
    const h = (a.getAttribute('href') || '').trim();
    if (!WIKI_FILE.test(h) && !h.startsWith('#/media/') && h !== '#') return false;
    return Closer.judge(img, { thumbLink: true });
  }

  function idle() {
    return Closer.state.ready && !Closer.isPaused() && !Closer.overlay.isOpen();
  }

  function skipMods(e, allowAlt) {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return true;
    if (e.altKey && !allowAlt) return true;
    return false;
  }

  function onPointerDown(e) {
    down = null;
    if (e.button !== 0) return;
    if (skipMods(e, true)) return;
    if (!idle()) return;

    let sel = false;
    try {
      sel = !!String(getSelection() || '').trim();
    } catch {
      /* 拿不到选区就当没有，按第二条偏向打开 */
    }
    const target = e.composedPath()[0];
    const img = Closer.pick(target, e.clientX, e.clientY);
    let stopEl = null;
    if (Closer.isTakeover() && img && passOpen(img)) {
      stopEl = img;
      stopEl.setAttribute('data-closer-stop', '');
    }
    down = { x: e.clientX, y: e.clientY, t: e.timeStamp, sel, stopEl };
  }

  function clearStop(el) {
    if (!el) return;
    const run = () => el.removeAttribute('data-closer-stop');
    queueMicrotask(run);
    setTimeout(run, 0);
  }

  function shouldYield(img, force) {
    if (force) return false;
    if (Closer.isTakeover()) return Closer.blind();
    if (Closer.shelled(img)) return true;
    return false;
  }

  function onClick(e) {
    const d = down;
    down = null;

    if (e.button !== 0) return;
    const force = e.altKey;
    if (skipMods(e, true)) {
      clearStop(d?.stopEl);
      return;
    }

    if (!idle()) {
      clearStop(d?.stopEl);
      return;
    }

    if (d) {
      if (Math.abs(e.clientX - d.x) > DRAG_SLOP || Math.abs(e.clientY - d.y) > DRAG_SLOP) {
        clearStop(d?.stopEl);
        return;
      }
      if (e.timeStamp - d.t > HOLD_MS) {
        clearStop(d?.stopEl);
        return;
      }
      if (d.sel) {
        clearStop(d?.stopEl);
        return;
      }
    }

    const target = e.composedPath()[0];
    const img = Closer.pick(target, e.clientX, e.clientY);
    if (!img || !passOpen(img)) {
      clearStop(d?.stopEl);
      return;
    }

    if (shouldYield(img, force)) {
      clearStop(d?.stopEl);
      if (!force && Closer.siteMode() === 'auto') Closer.state.lastYield = true;
      return;
    }

    Closer.hint?.reset?.();

    const intercept = Closer.isTakeover() || force;
    if (intercept) img.setAttribute('data-closer-stop', '');

    const base = Closer.snapshot(e.clientX, e.clientY, img);
    if (intercept) {
      e.stopImmediatePropagation();
    }
    e.preventDefault();

    settle(() => {
      clearStop(img);
      if (!Closer.acted(base)) Closer.overlay.open(img, base);
    });
  }

  Closer.load().finally(() => {
    // 宪法第六条：加载期最多 3 个监听（2026-10-23 由 2 改成 3，见 D32）。这就是全部三个。
    addEventListener('pointerdown', onPointerDown, true);
    addEventListener('click', onClick, true);
    Closer.hint?.attach?.();
  });
})();
