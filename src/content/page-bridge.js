'use strict';
// MAIN world：只掐页面脚本。须晚于 isolated boot 注册（background.js 顺序），否则 marker 在 pointerdown 挂上后，本 listener 先跑会把 click 吃掉、Closer 不开。
function eat(e) {
  if (e.button !== 0) return;
  let n = e.target;
  if (!(n instanceof Element)) return;
  for (; n && n !== document.documentElement; n = n.parentElement) {
    if (n.hasAttribute('data-closer-stop')) {
      e.stopImmediatePropagation();
      if (!e.defaultPrevented) e.preventDefault();
      return;
    }
  }
}
addEventListener('click', eat, true);
addEventListener('pointerdown', eat, true);
