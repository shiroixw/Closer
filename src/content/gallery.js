'use strict';

var Closer = (window.Closer ||= {});

Closer.gallery = (function () {
  const MAX = 60;
  let list = [];
  let at = 0;
  let ui = null;

  function ok(img) {
    return img && img.complete && img.naturalWidth > 0 && Closer.judge(img);
  }

  function collect(seed) {
    list = [seed];
    at = 0;
    for (let box = seed.parentElement; box && box !== document.body; box = box.parentElement) {
      const seen = new Set();
      const imgs = [];
      for (const im of box.querySelectorAll('img')) {
        if (!ok(im)) continue;
        const u = im.getAttribute('src') || im.src || '';
        if (!u || seen.has(u)) continue;
        seen.add(u);
        imgs.push(im);
      }
      if (imgs.length > 1) list = imgs.slice(0, MAX);
    }
    at = Math.max(0, list.indexOf(seed));
    return list.length;
  }

  function step(d) {
    if (list.length < 2) return null;
    const n = at + d;
    if (n < 0 || n >= list.length) return null;
    at = n;
    return list[at];
  }

  function count() {
    return list.length > 1 ? [at + 1, list.length] : null;
  }

  function bind(h) {
    ui = h;
  }

  function paintCount() {
    if (!ui?.countEl) return;
    const n = list.length;
    if (n < 2) {
      ui.countEl.textContent = '';
      ui.countEl.classList.remove('on');
      return;
    }
    ui.countEl.textContent = Closer.t('galleryCount', [String(at + 1), String(n)]);
    ui.countEl.classList.add('on');
  }

  function swapPhoto(img) {
    if (!ui) return;
    const m = Closer.meta(img);
    if (!m.nw || !m.nh) return;
    ui.bumpToken();
    const my = ui.token();
    ui.setCur(img, m);
    ui.viewReset();
    ui.photo.style.transition = `opacity ${ui.ms(140)}ms ease`;
    ui.photo.style.opacity = '0';
    setTimeout(() => {
      if (!ui.open() || my !== ui.token()) return;
      ui.photo.style.width = `${m.nw}px`;
      ui.photo.style.height = `${m.nh}px`;
      ui.photo.src = m.url;
      ui.refit(false);
      ui.photo.style.opacity = '1';
      ui.paintPanel();
      paintCount();
      ui.probeSize(m, my);
      ui.wake();
    }, ui.ms(140));
  }

  return {
    collect,
    step,
    count,
    reset: () => {
      list = [];
      at = 0;
    },
    has: () => list.length > 1,
    bind,
    paintCount,
    swapPhoto,
  };
})();
