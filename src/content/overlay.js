'use strict';

var Closer = (window.Closer ||= {});

// 视图层。单例，DOM 建一次复用；关闭时把 host 从文档里摘掉，
// 所以「开→关」之后页面 DOM 逐字节不变（宪法第三条的检验）。
//
// 注意：全文不出现名为 chrome 的局部变量，否则会遮住扩展 API。

Closer.overlay = (function () {
  const EASE = 'cubic-bezier(.22,.72,.18,1)';
  const HIDE_DELAY = 2200;
  const BACKDROPS = ['dark', 'light', 'checker'];

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const ms = (n) => (reduced.matches ? 0 : n);

  let host = null;
  let shadow = null;
  let stage, photo, backdrop, bar, panel, toast, infoBtn, copyBtn, saveBtn, closeBtn;
  let rDims, rShown, rRatio, rSize, pauseBtn;
  let rows = {};

  let state = 'idle'; // idle | open
  let cur = null; // { img, meta, href }
  let base = null; // 让位基线
  let view = { s: 1, tx: 0, ty: 0, r: 0, f: 1 };
  let fit = 1;
  let drag = null;
  let hideTimer = 0;
  let unwatch = null;
  let token = 0; // 晚到的体积探测不许覆盖新图

  const CSS = `
:host{all:initial;position:fixed;inset:0;z-index:2147483647;overflow:hidden;contain:layout style;
  font:13px/1.5 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;color:#f5f5f5}
[hidden]{display:none!important}
.backdrop{position:absolute;inset:0;opacity:0;transition:opacity ${ms(260)}ms ease;cursor:zoom-out}
.backdrop.in{opacity:1}
/* 主题类挂在 host 上，必须用 :host(.x)；写成 .x .y 会静默失效（背板透明） */
:host(.dark) .backdrop{background:#0b0b0c}
:host(.light) .backdrop{background:#f4f4f5}
:host(.checker) .backdrop{background-color:#fff;background-image:
  linear-gradient(45deg,#d9d9dd 25%,transparent 25%,transparent 75%,#d9d9dd 75%),
  linear-gradient(45deg,#d9d9dd 25%,transparent 25%,transparent 75%,#d9d9dd 75%);
  background-size:18px 18px;background-position:0 0,9px 9px}
.stage{position:absolute;inset:0}
/* 居中不用 inset:0 + margin:auto：布局尺寸是原图像素，当它大于视口时
   margin:auto 不会产生负边距（CSS 规范），元素退化成 left:0/top:0，
   于是大图在窄窗口里偏右下、右侧被裁。50% + -50% 与尺寸无关。 */
.photo{position:absolute;left:50%;top:50%;margin:0;display:block;max-width:none;max-height:none;
  transform-origin:center center;cursor:grab;user-select:none;will-change:transform}
.photo.dragging{cursor:grabbing}
/* bar 本体不接点击：它是整条顶部横带，会吞掉「点背板关闭」。只有按钮是命中区 */
.bar{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;
  padding:12px 14px;pointer-events:none;transition:opacity ${ms(180)}ms ease;opacity:1}
.bar.idle{opacity:0}
.bar button{pointer-events:auto}
/* 隐身时不可点：看得见才点得到，不留看不见的按钮 */
.bar.idle button{pointer-events:none}
.actions{display:flex;gap:4px}
button{all:unset;box-sizing:border-box;display:grid;place-items:center;cursor:pointer;color:inherit;
  border-radius:9px;background:rgba(24,24,27,.62);backdrop-filter:blur(8px);
  transition:background ${ms(140)}ms ease,color ${ms(140)}ms ease}
:host(.light) .bar button{background:rgba(255,255,255,.72);color:#18181b}
button:hover{background:rgba(63,63,70,.9)}
:host(.light) .bar button:hover{background:#fff}
.info{width:32px;height:32px;font:600 15px/1 ui-sans-serif,system-ui,sans-serif}
.act{width:32px;height:32px}
.act svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.act.done{color:#4ade80}
.panel{position:absolute;top:56px;left:14px;width:232px;padding:12px 14px;border-radius:12px;
  background:rgba(24,24,27,.86);backdrop-filter:blur(12px);box-shadow:0 12px 32px rgba(0,0,0,.45);
  animation:pop ${ms(160)}ms ${EASE}}
@keyframes pop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.panel .dims{font-size:15px;font-weight:500;letter-spacing:.01em}
.panel .sub,.panel .shown{color:#a1a1aa;font-size:12px;margin-top:2px}
.panel hr{border:0;border-top:1px solid rgba(255,255,255,.1);margin:10px 0 8px}
.panel .pause{display:block;width:100%;text-align:left;font-size:12px;color:#a1a1aa;
  padding:2px 0;background:none;backdrop-filter:none}
.panel .pause:hover{color:#f5f5f5;background:none}
.toast{position:absolute;bottom:28px;left:50%;transform:translateX(-50%);padding:7px 13px;
  border-radius:9px;background:rgba(24,24,27,.9);font-size:12px;
  opacity:0;transition:opacity ${ms(140)}ms ease}
.toast.on{opacity:1}
`;

  const COPY_SVG =
    '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6.5A2.5 2.5 0 0 0 4 5.5v6A2.5 2.5 0 0 0 6.5 14"/></svg>';
  const SAVE_SVG =
    '<svg viewBox="0 0 24 24"><path d="M12 4v10"/><path d="m8 11 4 4 4-4"/><path d="M5 19h14"/></svg>';
  const CLOSE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="m5 13 4.5 4.5L19 7"/></svg>';

  /* ---------- 建树 ---------- */

  function ensure() {
    if (host) return;

    host = document.createElement('div');
    host.id = 'closer';
    host.setAttribute('role', 'dialog');
    // 不写 aria-modal：模态语义要求焦点进入对话框，而第三条禁止抢焦点
    // （页面能观测到 blur 的地方，视频会暂停、编辑器会失焦）。
    // 撒谎的 ARIA 比没有 ARIA 更糟，所以这里退成非模态 dialog。
    host.setAttribute('aria-label', Closer.t('viewerLabel'));
    host.lang = Closer.lang; // 中文标签要按中文读，不能跟着页面语言走
    host.tabIndex = -1; // 不 focus：键位靠 window capture，不需要焦点（6.7）

    shadow = host.attachShadow({ mode: 'open' });

    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet]; // 页面 CSP 拦不住

    shadow.innerHTML = `
      <div class="backdrop" part="backdrop"></div>
      <div class="stage">
        <img class="photo" alt="" draggable="false">
      </div>
      <div class="bar">
        <button class="info" aria-expanded="false">i</button>
        <div class="actions">
          <button class="act copy">${COPY_SVG}</button>
          <button class="act save">${SAVE_SVG}</button>
          <button class="act close">${CLOSE_SVG}</button>
        </div>
      </div>
      <div class="panel" hidden>
        <div class="dims"></div>
        <div class="shown" hidden></div>
        <div class="sub ratio"></div>
        <div class="sub size"></div>
        <hr>
        <button class="pause"></button>
      </div>
      <div class="toast" role="status" aria-live="polite"></div>
    `;

    backdrop = shadow.querySelector('.backdrop');
    stage = shadow.querySelector('.stage');
    photo = shadow.querySelector('.photo');
    bar = shadow.querySelector('.bar');
    panel = shadow.querySelector('.panel');
    toast = shadow.querySelector('.toast');
    infoBtn = shadow.querySelector('.info');
    copyBtn = shadow.querySelector('.copy');
    saveBtn = shadow.querySelector('.save');
    closeBtn = shadow.querySelector('.close');
    rDims = shadow.querySelector('.dims');
    rShown = shadow.querySelector('.shown');
    rRatio = shadow.querySelector('.ratio');
    rSize = shadow.querySelector('.size');
    pauseBtn = shadow.querySelector('.pause');

    // 读屏标签与 tooltip：文案只从语言包来，模板里只留结构。
    // 每个 key 都写成字面量，不经过变量——tools/check-i18n.mjs 靠这个静态扫出漏 key。
    infoBtn.setAttribute('aria-label', Closer.t('infoLabel'));
    infoBtn.title = Closer.t('infoTitle');
    copyBtn.setAttribute('aria-label', Closer.t('copyLabel'));
    copyBtn.title = Closer.t('copyTitle');
    saveBtn.setAttribute('aria-label', Closer.t('saveLabel'));
    saveBtn.title = Closer.t('saveTitle');
    closeBtn.setAttribute('aria-label', Closer.t('closeLabel'));
    closeBtn.title = Closer.t('closeTitle');

    infoBtn.addEventListener('click', () => togglePanel());
    closeBtn.addEventListener('click', () => close());
    copyBtn.addEventListener('click', onCopy);
    saveBtn.addEventListener('click', onSave);
    pauseBtn.addEventListener('click', onPause);
    photo.addEventListener('dblclick', onDblClick);
    photo.addEventListener('error', () => close(true)); // 空黑幕比没有更糟（6.8）

    // 不再用 bar 的 pointerenter/leave：bar 本体是 pointer-events:none，收不到事件。
    // 悬停与唤回统一由 onMove 里的 hover() 负责。
  }

  /* ---------- 坐标 ---------- */

  function computeFit() {
    const turned = view.r % 180 !== 0;
    const W = turned ? cur.meta.nh : cur.meta.nw;
    const H = turned ? cur.meta.nw : cur.meta.nh;
    return Math.min((innerWidth * 0.94) / W, (innerHeight * 0.94) / H, 4);
  }

  const clampS = (s) => Math.min(Math.max(s, fit * 0.4), fit * 8);

  function apply(transition) {
    photo.style.transition = transition || 'none';
    // -50%,-50% 先把元素中心对到视口中心，再叠加平移/旋转/缩放。
    // 这样居中不依赖元素自身尺寸，也就不会在窄窗口里失效。
    photo.style.transform =
      `translate(-50%,-50%) translate(${view.tx}px,${view.ty}px) rotate(${view.r}deg) scaleX(${view.f}) scale(${view.s})`;
  }

  /** 以指针 P 为锚点缩放。式子在旋转与翻转下都精确（技术方案 3.2）。 */
  function zoomAt(next, px, py, transition) {
    next = clampS(next);
    const k = next / view.s;
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    view.tx = px - cx - k * (px - cx - view.tx);
    view.ty = py - cy - k * (py - cy - view.ty);
    view.s = next;
    apply(transition);
  }

  const zoomKey = (ratio) => zoomAt(view.s * ratio, innerWidth / 2, innerHeight / 2, `transform ${ms(180)}ms ${EASE}`);

  function refit(animated) {
    fit = computeFit();
    view.s = clampS(fit);
    view.tx = 0;
    view.ty = 0;
    apply(animated ? `transform ${ms(180)}ms ${EASE}` : 'none');
  }

  /* ---------- 面板 ---------- */

  function paintPanel() {
    const m = cur.meta;
    rDims.textContent = `${m.nw} × ${m.nh}`;

    const scaled = m.sw && (Math.abs(m.sw - m.nw) > 1 || Math.abs(m.sh - m.nh) > 1);
    rShown.hidden = !scaled;
    if (scaled) rShown.textContent = Closer.t('shownDims', [String(m.sw), String(m.sh)]);

    rRatio.textContent = [m.ratio, m.mp ? `${m.mp} MP` : ''].filter(Boolean).join(' · ');

    // 取不到大小，整行不显示——不写「未知」（5.4）
    const size = Closer.humanBytes(m.size);
    const head = [m.format, size].filter(Boolean).join(' · ');
    rSize.hidden = !head;
    rSize.textContent = head;

    // 占位符而不是字符串拼接：中文的语序是「在 x 上暂停」，拼接会拼出英文语序
    const site = Closer.site();
    pauseBtn.textContent = site ? Closer.t('pauseOn', [site]) : Closer.t('pauseOnThisSite');
  }

  function togglePanel(force) {
    const open = force ?? panel.hidden;
    panel.hidden = !open;
    infoBtn.setAttribute('aria-expanded', String(open));
    wake();
  }

  async function probeSize(m, my) {
    const quick = Closer.bytesFromTiming(m.url);
    if (quick?.size && my === token && cur) {
      cur.meta.size = quick.size;
      paintPanel();
    }

    const got = await Closer.bytes(m.url, 'meta');
    if (my !== token || !cur || !got?.size) return;
    cur.meta.size = got.size;
    const fmt = mimeFormat(got.mime);
    if (fmt) cur.meta.format = fmt;
    paintPanel();
  }

  const mimeFormat = (mime) => (/^image\/([a-z0-9.+-]+)/i.exec(mime || '')?.[1] || '').toUpperCase();

  /* ---------- 动作 ---------- */

  async function onCopy(e) {
    const m = cur?.meta;
    if (!m) return;

    try {
      // ⇧ 复制地址：纯文本，永不失败
      if (e.shiftKey) {
        await Closer.copyText(m.url);
      } else {
        const got = await Closer.bytes(m.url, 'full');
        if (!got?.buf) throw new Error('bytes');
        // 太大时降级成地址：拿到的东西变了，就得说出来（5.4）
        if ((await Closer.copyImage(got, m.url)) === 'address') {
          say(Closer.t('copyTooLarge'));
        }
      }
      flash(copyBtn);
    } catch {
      say(Closer.t('copyFailed'));
    }
  }

  async function onSave() {
    const m = cur?.meta;
    if (!m) return;
    try {
      const got = await Closer.bytes(m.url, 'full');
      if (!got?.buf) throw new Error('bytes');
      await Closer.saveImage(got, Closer.fileName(m.url, m));
      flash(saveBtn);
    } catch {
      say(Closer.t('saveFailed'));
    }
  }

  async function onPause() {
    await Closer.pauseHere();
    close(true);
  }

  function flash(btn) {
    const html = btn.innerHTML;
    btn.classList.add('done');
    btn.innerHTML = CHECK_SVG;
    setTimeout(() => {
      btn.classList.remove('done');
      btn.innerHTML = html;
    }, 1200);
  }

  let toastTimer = 0;
  function say(text) {
    toast.textContent = text;
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), 1400);
  }

  /* ---------- chrome 自动隐藏 ---------- */

  function wake() {
    bar.classList.remove('idle');
    clearTimeout(hideTimer);
    if (!panel.hidden) return; // 面板开着时不许淡出
    hideTimer = setTimeout(() => bar.classList.add('idle'), HIDE_DELAY);
  }

  /**
   * 指针一动就把 chrome 唤回来（设计 5.2）。
   * 只挂在 onMove 里，不新增监听器（宪法第六条：加载期监听预算是 2 个）。
   * 节流 80 ms：pointermove 一秒能来几百条，唤回一次就够。
   */
  let lastHover = 0;
  function hover(e) {
    const t = performance.now();
    if (t - lastHover < 80) return;
    lastHover = t;

    // 停在按钮上时不淡出：取消计时器，且不重设
    if (e.composedPath().includes(bar)) {
      bar.classList.remove('idle');
      clearTimeout(hideTimer);
      return;
    }
    wake();
  }

  function setBackdrop(name) {
    const next = BACKDROPS.includes(name) ? name : 'dark';
    host.classList.remove(...BACKDROPS);
    host.classList.add(next);
  }

  /* ---------- 事件 ---------- */

  function onDown(e) {
    if (state !== 'open') return;

    const path = e.composedPath();
    if (!panel.hidden && !path.includes(panel) && !path.includes(infoBtn)) togglePanel(false);

    if (e.button !== 0) return;
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      tx: view.tx,
      ty: view.ty,
      moved: false,
      onPhoto: path.includes(photo),
      onBar: path.includes(bar) || path.includes(panel),
    };
    if (drag.onPhoto) {
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* 合成事件没有真实指针，忽略 */
      }
      photo.classList.add('dragging');
      photo.style.transition = 'none'; // 跟着手走，不许有缓动
    }
  }

  function onMove(e) {
    if (state !== 'open') return;

    hover(e); // 唤回 chrome；拖拽时它同时负责保持可见

    if (!drag || e.pointerId !== drag.id) return;

    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return; // 手抖的点击仍是点击
    drag.moved = true;

    if (drag.onPhoto) {
      view.tx = drag.tx + dx;
      view.ty = drag.ty + dy;
      apply('none');
    }
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    photo.classList.remove('dragging');

    if (!d.moved && !d.onPhoto && !d.onBar) close(); // 点背板关闭
  }

  const SCROLL_KEYS = new Set([
    ' ',
    'PageUp',
    'PageDown',
    'Home',
    'End',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
  ]);

  function onKey(e) {
    if (state !== 'open') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const k = e.key;

    // 空格与方向键不拦，页面会在 overlay 背后滚动——用户看不见，关掉才发现人已经走了
    if (SCROLL_KEYS.has(k)) {
      e.preventDefault();
      wake();
      return;
    }

    switch (k) {
      case 'Escape':
        e.preventDefault();
        if (!panel.hidden) togglePanel(false);
        else close();
        return;
      case 'i':
      case 'I':
        e.preventDefault();
        togglePanel();
        return;
      case '0':
        e.preventDefault();
        refit(true);
        return;
      case '1':
        e.preventDefault();
        zoomAt(1, innerWidth / 2, innerHeight / 2, `transform ${ms(180)}ms ${EASE}`);
        return;
      case '+':
      case '=':
        e.preventDefault();
        zoomKey(1.25);
        return;
      case '-':
      case '_':
        e.preventDefault();
        zoomKey(0.8);
        return;
      case 'r':
      case 'R': {
        e.preventDefault();
        view.r = (view.r + 90) % 360;
        refit(true);
        return;
      }
      case 'f':
      case 'F':
        e.preventDefault();
        view.f *= -1;
        apply(`transform ${ms(180)}ms ${EASE}`);
        return;
      case 'b':
      case 'B': {
        e.preventDefault();
        const now = BACKDROPS.find((n) => host.classList.contains(n)) || 'dark';
        const next = BACKDROPS[(BACKDROPS.indexOf(now) + 1) % BACKDROPS.length];
        setBackdrop(next);
        Closer.setPref('backdrop', next); // 记忆
        return;
      }
      case 'Enter': {
        e.preventDefault();
        const href = cur?.href;
        if (href) location.assign(href);
        else close();
        return;
      }
      default:
        return;
    }
  }

  function onDblClick(e) {
    e.preventDefault();
    const atFit = Math.abs(view.s - fit) < 0.001;
    if (atFit) zoomAt(1, e.clientX, e.clientY, `transform ${ms(180)}ms ${EASE}`);
    else refit(true);
  }

  const stop = (e) => {
    if (state === 'open') {
      e.preventDefault();
      wake();
    }
  };

  function onResize() {
    if (state !== 'open' || !cur) return;
    refit(false);
  }

  function bind() {
    addEventListener('wheel', onWheel, { capture: true, passive: false });
    addEventListener('keydown', onKey, true);
    addEventListener('pointerdown', onDown, true);
    addEventListener('pointermove', onMove, true);
    addEventListener('pointerup', onUp, true);
    addEventListener('pointercancel', onCancel, true);
    addEventListener('dragstart', stop, true);
    addEventListener('selectstart', stop, true);
    addEventListener('resize', onResize);
  }

  function unbind() {
    removeEventListener('wheel', onWheel, { capture: true });
    removeEventListener('keydown', onKey, true);
    removeEventListener('pointerdown', onDown, true);
    removeEventListener('pointermove', onMove, true);
    removeEventListener('pointerup', onUp, true);
    removeEventListener('pointercancel', onCancel, true);
    removeEventListener('dragstart', stop, true);
    removeEventListener('selectstart', stop, true);
    removeEventListener('resize', onResize);
  }

  function onWheel(e) {
    if (state !== 'open') return;
    // 不 preventDefault 页面会照样滚；必须显式 passive:false（6.2）
    e.preventDefault();

    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= innerHeight;

    // e.ctrlKey 为真时是触控板捏合，同一条路径，不另开分支
    zoomAt(view.s * Math.exp(-dy * 0.0018), e.clientX, e.clientY, 'none');
    wake();
  }

  function onCancel(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    photo.classList.remove('dragging');
  }

  /* ---------- 开关 ---------- */

  function open(img, baseline) {
    if (state === 'open') return;

    const m = Closer.meta(img);
    if (!m.nw || !m.nh) return;

    ensure();

    cur = { img, meta: m, href: img.closest('a')?.href || '' };
    base = baseline;
    view = { s: 1, tx: 0, ty: 0, r: 0, f: 1 };
    fit = computeFit();

    // 尺寸先按原始像素写上，避免等 decode 造成跳动（6.8）
    photo.style.width = `${m.nw}px`;
    photo.style.height = `${m.nh}px`;
    photo.style.opacity = '1';
    photo.style.transition = 'none';
    photo.src = m.url;

    // FLIP 起点：源图当前矩形。同时插值「中心点」和「尺寸」即可
    const r = img.getBoundingClientRect();
    const usable = r.width > 0 && r.height > 0;
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;

    view.s = usable ? r.width / m.nw : fit;
    view.tx = usable ? r.left + r.width / 2 - cx : 0;
    view.ty = usable ? r.top + r.height / 2 - cy : 0;
    apply('none');

    document.documentElement.appendChild(host);
    Closer.state.host = host;
    state = 'open';

    togglePanel(false);
    setBackdrop(Closer.state.prefs.backdrop || 'dark');
    paintPanel();
    wake();
    bind();

    void photo.getBoundingClientRect(); // 强制提交起始样式，否则动画不成立

    requestAnimationFrame(() => {
      if (state !== 'open') return;
      view.s = clampS(fit);
      view.tx = 0;
      view.ty = 0;
      apply(`transform ${ms(260)}ms ${EASE}`);
      backdrop.classList.add('in');
    });

    token += 1;
    probeSize(m, token);
    unwatch = Closer.watchLate(base, () => close(true));
  }

  function close(instant) {
    if (state !== 'open') return;
    state = 'idle';
    unbind();
    clearTimeout(hideTimer);
    if (unwatch) {
      unwatch();
      unwatch = null;
    }

    const m = cur?.meta;
    const src = cur?.img;
    const r = src?.isConnected ? src.getBoundingClientRect() : null;
    const usable = !!(r && r.width > 0 && r.height > 0);

    backdrop.classList.remove('in');

    if (instant || !m || reduced.matches) return teardown();
    if (!usable) return fadeOut();

    view.s = r.width / m.nw;
    view.tx = r.left + r.width / 2 - innerWidth / 2;
    view.ty = r.top + r.height / 2 - innerHeight / 2;
    view.r = 0;
    view.f = 1;
    apply(`transform ${ms(260)}ms ${EASE}`);

    photo.addEventListener('transitionend', teardown, { once: true });
    setTimeout(teardown, 400); // transitionend 不保证来
  }

  function fadeOut() {
    photo.style.transition = 'opacity 160ms ease';
    photo.style.opacity = '0';
    setTimeout(teardown, 180);
  }

  function teardown() {
    // 退场动画跑到一半又重新打开了：拆掉就等于把新打开的那张也弄丢
    if (state === 'open') return;
    if (!host || !host.isConnected) return;
    photo.removeAttribute('src');
    photo.style.width = '';
    photo.style.height = '';
    photo.style.transition = 'none';
    photo.style.opacity = '1';
    host.remove(); // 关掉之后页面 DOM 必须逐字节还原
    Closer.state.host = null;
    cur = null;
  }

  /**
   * 偏好变了（在 popup 里换背板）：已经打开的这一张立刻换，不必等下次点击。
   * 幂等——B 键自己也会调 setBackdrop，随后 storage 回调再来一次不会有事。
   */
  function syncBackdrop() {
    if (state !== 'open') return;
    setBackdrop(Closer.state.prefs.backdrop || 'dark');
  }

  return {
    open,
    close,
    syncBackdrop,
    isOpen: () => state === 'open',
  };
})();
