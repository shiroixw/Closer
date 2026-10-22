'use strict';

// 扩展页面（popup / welcome）的文案入口。
// content 侧不加载这个文件：那边由 core.js 的 Closer.t 负责。两个世界之间没有构建步骤可以共享（D4），
// 所以这里重复一个五行的包装，而不是为一个函数引入模块系统。
//
// 语言不由我们决定：manifest 的 default_locale + _locales/* 由浏览器按 UI 语言挑选，
// 代码里没有任何检测逻辑，也没有切换开关（宪法第九条：能自动答对的问题不抛给用户）。

const t = (key, subs) => {
  try {
    // escapeLt 显式关掉：data-i18n-html 那几段带 <strong>/<code>，内容全部出自我们自己的 messages.json。
    // 其余文案一律走 textContent，不经过 innerHTML。
    return chrome.i18n.getMessage(key, subs, { escapeLt: false }) || key;
  } catch {
    return key; // 扩展上下文失效：显示 key 名，比一片空白更容易被看见
  }
};

// 中文标签需要正确的中文字形与断行规则
document.documentElement.lang = (chrome.i18n.getUILanguage() || 'en').replace('_', '-');

// 静态文案：HTML 里只写 key，文字全部在 _locales/*/messages.json。
// 漏 key 不会报错，只会原样显示 key 名——tools/check-i18n.mjs 在 verify 阶段先拦下。
for (const el of document.querySelectorAll('[data-i18n]')) {
  el.textContent = t(el.dataset.i18n);
}
for (const el of document.querySelectorAll('[data-i18n-html]')) {
  el.innerHTML = t(el.dataset.i18nHtml);
}
