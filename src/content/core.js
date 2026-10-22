'use strict';

// 命名空间、文案、偏好、暂停列表。
// 注意用 var：多个 content script 文件共享同一个全局词法环境，
// 顶层 const 会在第二个文件里抛「already declared」。

var Closer = (window.Closer ||= {});

const PAUSED_KEY = 'closer:paused';
const PREFS_KEY = 'closer:prefs';

const DEFAULT_PREFS = { backdrop: 'dark' };

/* ---------- 文案 ---------- */

// 语言由浏览器 UI 语言决定（manifest 的 default_locale + _locales/*），
// 这里不解析 navigator.language，也不提供切换开关（宪法第九条：能自动答对的问题不抛给用户）。
Closer.lang = 'en';
try {
  Closer.lang = (chrome.i18n.getUILanguage() || 'en').replace('_', '-');
} catch {
  /* 扩展上下文已失效：按 en 显示，不阻塞页面 */
}

// 漏 key 时 getMessage 返回空串而不报错，所以退回 key 本身：
// 界面上直接出现 copyFailed 这样的字样，比一片空白更容易被发现。
// tools/check-i18n.mjs 会在 verify 阶段先把不存在的 key 拦下来。
Closer.t = function (key, subs) {
  try {
    return chrome.i18n.getMessage(key, subs) || key;
  } catch {
    return key;
  }
};

/* ---------- 站点身份 ---------- */

// 去 www. 是为了让 example.com 的一条记录同时管住 www 与子域。
// 不引 PSL：多级后缀（.co.uk）下会略微过宽，但这里管的是「别烦我」，宁宽勿窄。
Closer.site = function () {
  const h = location.hostname || '';
  return h.replace(/^www\./i, '').toLowerCase();
};

function covers(entry, host) {
  if (!entry || !host) return false;
  return host === entry || host.endsWith('.' + entry);
}

/* ---------- 状态 ---------- */

Closer.state = {
  ready: false, // 偏好是否读完。没读完时一律放行，杜绝竞态
  paused: false, // 当前站点是否被暂停
  prefs: { ...DEFAULT_PREFS },
  host: null, // overlay 的 shadow host，由 overlay.js 建立
  shell: null, // 页面自己开的那一层，由 yield.js 记录与失效
  yielded: false, // 本页有没有观测到页面接管过。只给静态存量判据用（见 yield.js）
};

/* ---------- 加载 ---------- */

Closer.load = async function () {
  let paused = [];
  let prefs = DEFAULT_PREFS;

  try {
    const got = await chrome.storage.local.get([PAUSED_KEY, PREFS_KEY]);
    if (Array.isArray(got[PAUSED_KEY])) paused = got[PAUSED_KEY];
    if (got[PREFS_KEY] && typeof got[PREFS_KEY] === 'object') {
      prefs = { ...DEFAULT_PREFS, ...got[PREFS_KEY] };
    }
  } catch {
    // 扩展上下文失效（更新、重载）时按默认值走，不阻塞页面
  }

  const site = Closer.site();
  Closer.state.prefs = prefs;
  Closer.state.paused = paused.some((entry) => covers(entry, site));
  Closer.state.ready = true;
  return Closer.state;
};

/* ---------- 暂停 ---------- */

Closer.pauseHere = async function () {
  const site = Closer.site();
  if (!site) return;

  try {
    const got = await chrome.storage.local.get(PAUSED_KEY);
    const list = Array.isArray(got[PAUSED_KEY]) ? got[PAUSED_KEY] : [];
    if (!list.includes(site)) {
      list.push(site);
      await chrome.storage.local.set({ [PAUSED_KEY]: list });
    }
  } catch {
    return;
  }

  Closer.state.paused = true;
};

Closer.resumeHere = async function () {
  const site = Closer.site();
  if (!site) return;

  try {
    const got = await chrome.storage.local.get(PAUSED_KEY);
    const list = Array.isArray(got[PAUSED_KEY]) ? got[PAUSED_KEY] : [];
    const next = list.filter((entry) => !covers(entry, site));
    await chrome.storage.local.set({ [PAUSED_KEY]: next });
  } catch {
    return;
  }

  Closer.state.paused = false;
};

Closer.isPaused = () => Closer.state.paused;

/* ---------- 偏好 ---------- */

Closer.setPref = async function (key, value) {
  const next = { ...Closer.state.prefs, [key]: value };
  Closer.state.prefs = next;
  try {
    await chrome.storage.local.set({ [PREFS_KEY]: next });
  } catch {
    // 写不进去不影响本次会话
  }
};

/* ---------- 跨上下文同步 ---------- */

// 在 popup 里取消暂停、或换背景，已经打开的页面要立刻跟上。
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes[PAUSED_KEY]) {
      const list = changes[PAUSED_KEY].newValue;
      const site = Closer.site();
      Closer.state.paused = Array.isArray(list) && list.some((entry) => covers(entry, site));
      if (Closer.state.paused && Closer.overlay?.isOpen?.()) Closer.overlay.close();
    }

    if (changes[PREFS_KEY] && changes[PREFS_KEY].newValue) {
      Closer.state.prefs = { ...DEFAULT_PREFS, ...changes[PREFS_KEY].newValue };
      // 和暂停一样：状态变了，眼前这一张必须立刻跟上，不能等下次点击
      Closer.overlay?.syncBackdrop?.();
    }
  });
} catch {
  // 极端情况下 storage 不可用，忽略
}
