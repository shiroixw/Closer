/**
 * E1 — 让位检测假阳性率探测
 *
 * 用法：
 *   1. 打开 chrome://extensions 之外任意 http(s) 页面
 *   2. DevTools → Sources → Snippets → New snippet → 粘贴本文件 → ⌘/Ctrl + Enter
 *   3. 正常浏览、正常点击（页面不会被阻止，行为与没装任何东西时完全一致）
 *   4. 点够 15–30 次后，在控制台执行 __closer.report()
 *   5. 换站点重复。报告里的 guess 列就是答案
 *
 * 这个脚本只观察，不改变页面。它复刻的是 design-v0.1.md 第 4 节的判据
 * 与 tech-spec.md 第 4 节的检测逻辑，用来在真站点上标定阈值。
 */
(() => {
  if (window.__closer) {
    console.warn('[closer] 已经装过了。先执行 __closer.off() 再重跑。');
    return;
  }

  // 与设计稿一致的常量
  const MAX_MOVE = 6;
  const MAX_MS = 600;
  const MIN_RENDERED = 40;
  const MIN_AREA = 40000;
  const MIN_SIDE = 48;

  const rows = [];
  let down = null;

  const IMAGE_HREF = /\.(avif|webp|jpe?g|png|gif|apng|svg|bmp|ico)(?:[?#]|$)/i;
  const CONTROL =
    'button,[role="button"],label,select,input,textarea,summary,option,[contenteditable=""],[contenteditable="true"]';
  const KNOWN_VIEWER =
    '[data-lightbox],[data-fancybox],[data-fslightbox],[data-featherlight],[data-zoom],a[rel~="lightbox"]';

  // ---------- 判断器（复刻 design-v0.1.md 第 4 节） ----------

  function judge(img) {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;

    if (!nw || !nh) return 'rule 1: 未解码';
    const r = img.getBoundingClientRect();
    if (r.width < MIN_RENDERED || r.height < MIN_RENDERED) return 'rule 2: 渲染太小';
    if (nw * nh < MIN_AREA) return 'rule 3: 面积太小';
    if (Math.min(nw, nh) < MIN_SIDE) return 'rule 4: 短边太窄';
    if (img.closest('[data-closer-ignore]')) return 'rule 5: 显式忽略';
    if (img.closest(CONTROL)) return 'rule 6: 控件内';
    const bar = img.closest('header,nav');
    if (bar && r.height < 80) return 'rule 7: 导航区 logo';
    if (img.closest('a[download]')) return 'rule 8: 下载链接';

    const a = img.closest('a');
    if (a) {
      const href = a.getAttribute('href') || '';
      if (!IMAGE_HREF.test(href) && !href.startsWith('#')) return 'rule 9: 非图片链接';
    }

    const slab = img.closest(KNOWN_VIEWER) || img.closest('dialog[open],[role="dialog"][aria-modal="true"]');
    if (slab) return 'rule 10: 已知查看器';

    return null; // 候选
  }

  // ---------- 让位检测（复刻 tech-spec.md 第 4 节） ----------

  function scrollLocked() {
    const d = document.documentElement;
    const b = document.body;
    return (
      getComputedStyle(d).overflowY === 'hidden' || (b && getComputedStyle(b).overflowY === 'hidden')
    );
  }

  function snapshot(x, y, src) {
    return {
      href: location.href,
      fullscreen: !!document.fullscreenElement,
      scrollLocked: scrollLocked(),
      hit: document.elementFromPoint(x, y),
      x,
      y,
      src,
      dup: dupCount(src),
      layers: layerCount(),
    };
  }

  function acted(b, allowHit = true) {
    if (location.href !== b.href) return 'href';
    if (!!document.fullscreenElement !== b.fullscreen) return 'fullscreen';
    if (allowHit) {
      const hit = document.elementFromPoint(b.x, b.y);
      if (hit !== b.hit) return 'hit';
    }
    if (scrollLocked() !== b.scrollLocked) return 'scroll';
    return '';
  }

  // ---------- 页面到底做了什么（代理指标，不是判据） ----------

  function dupCount(src) {
    // 页面若把同一张图塞进自己的查看器，同 src 的 <img> 会变多
    if (!src) return 0;
    let n = 0;
    for (const im of document.images) {
      if ((im.currentSrc || im.src) === src) n++;
    }
    return n;
  }

  function layerCount() {
    return document.querySelectorAll(
      '[role="dialog"],[aria-modal="true"],dialog[open],[class*="lightbox" i],[class*="modal" i],[class*="viewer" i]'
    ).length;
  }

  function viewerEvidence(b) {
    const hits = [];
    if (dupCount(b.src) > b.dup) hits.push('dup-img');
    if (layerCount() > b.layers) hits.push('layer');
    return hits.join('+');
  }

  // ---------- 接线 ----------

  function onDown(e) {
    if (e.button !== 0) {
      down = null;
      return;
    }
    const sel = window.getSelection();
    down = {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      selecting: !!sel && sel.toString().length > 0,
    };
  }

  function onClick(e) {
    const d = down;
    down = null;
    if (!d) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (d.selecting) return;
    if (Math.abs(e.clientX - d.x) > MAX_MOVE || Math.abs(e.clientY - d.y) > MAX_MOVE) return;
    if (performance.now() - d.t > MAX_MS) return;

    const t = e.target;
    const img = t instanceof Element ? t.closest('img') : null;
    if (!img) return;

    const why = judge(img);
    const r = img.getBoundingClientRect();
    const src = img.currentSrc || img.src;
    const base = snapshot(d.x, d.y, src);

    const row = {
      time: new Date().toLocaleTimeString('en-GB'),
      candidate: why ? 'no' : 'yes',
      why: why || '',
      img: `${img.naturalWidth}×${img.naturalHeight} @ ${Math.round(r.width)}×${Math.round(r.height)}`,
      acted: '',
      late: '',
      viewer: '',
      guess: '',
    };
    rows.push(row);

    if (why) {
      row.guess = 'judge-skip';
      console.log('[closer] skip —', why, row.img);
      return;
    }

    settle(() => {
      const at = acted(base);
      row.acted = at || 'none';

      setTimeout(() => {
        const now = acted(base);
        row.late = now && now !== at ? now : '';
        row.viewer = viewerEvidence(base);
        row.guess = classify(row);

        const mark = row.guess === 'MISS' ? 'color:#e24b4a;font-weight:600' : 'color:#1d9e75';
        console.log(
          `%c[closer] ${row.guess}%c  acted=${row.acted || '-'} late=${row.late || '-'} viewer=${row.viewer || '-'}`,
          mark,
          'color:inherit'
        );
      }, 1300);
    });
  }

  function classify(row) {
    const atFrame = row.acted !== 'none';
    const actedAny = atFrame || !!row.late;
    const viewer = !!row.viewer;
    if (!actedAny && viewer) return 'MISS'; // 以为页面没动，其实它开了查看器 → 双开
    if (!atFrame && row.late) return 'late-yield'; // 我们先开、页面后开，于是自己关掉 → 会闪一下
    if (!actedAny) return 'open-ok';
    if (viewer) return 'yield-ok';
    return 'yield-blind'; // 让位了，但看不出页面做了什么
  }

  function settle(fn) {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      fn();
    };
    requestAnimationFrame(once);
    setTimeout(once, 32);
  }

  // ---------- 报告 ----------

  function report() {
    const cand = rows.filter((r) => r.candidate === 'yes' && r.guess);
    console.table(
      cand.map((r, i) => ({
        '#': i + 1,
        acted: r.acted,
        late: r.late || '-',
        viewer: r.viewer || '-',
        guess: r.guess,
        img: r.img,
      }))
    );

    const count = (k) => rows.filter((r) => r.guess === k).length;
    const summary = {
      候选: rows.filter((r) => r.candidate === 'yes').length,
      判据跳过: count('judge-skip'),
      'open-ok 理想打开': count('open-ok'),
      'yield-ok 理想让位': count('yield-ok'),
      'late-yield 先开再关': count('late-yield'),
      'yield-blind 让位但看不出': count('yield-blind'),
      'MISS 双开风险': count('MISS'),
    };
    console.log(`[closer] ${location.host}`, summary);

    const miss = count('MISS');
    const blind = count('yield-blind');
    if (miss > 0) console.warn(`[closer] 双开风险 ${miss} 次 —— 判据太窄`);
    if (blind > candidates(rows) * 0.5) console.warn('[closer] 让位过多 —— 判据太宽');
    return summary;
  }

  const candidates = (rs) => rs.filter((r) => r.candidate === 'yes').length || 1;

  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('click', onClick, true);

  window.__closer = {
    report,
    rows,
    off() {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('click', onClick, true);
      delete window.__closer;
      console.log('[closer] 已卸载');
    },
  };

  console.log(
    '%c[closer]%c E1 探测已就绪。正常点击即可，点够 15–30 次后执行 __closer.report()',
    'color:#7f77dd;font-weight:600',
    'color:inherit'
  );
})();
