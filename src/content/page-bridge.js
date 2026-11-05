'use strict';
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
