'use strict';

// 首次运行页：解释权限，允许授权，管理暂停列表。
// 不做引导流程（没有多步教程），因为设置项只有背景一项，没什么可教的。

const ALL = { origins: ['*://*/*'] };
const PAUSED_KEY = 'closer:paused';

const list = document.getElementById('list');
const count = document.getElementById('count');
const empty = document.getElementById('empty');
const perm = document.getElementById('perm');

async function render() {
  const got = await chrome.storage.local.get(PAUSED_KEY);
  const paused = Array.isArray(got[PAUSED_KEY]) ? got[PAUSED_KEY] : [];

  list.textContent = '';
  empty.hidden = paused.length > 0;
  // 复数只有在多于一个时才是另一个 key：英文要说 sites，中文两个 key 文字相同但结构一致
  count.textContent = !paused.length
    ? '—'
    : paused.length === 1
      ? t('pausedCountOne')
      : t('pausedCountMany', [String(paused.length)]);

  for (const site of paused) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = site;

    const del = document.createElement('button');
    del.textContent = t('resume');
    del.addEventListener('click', async () => {
      const now = await chrome.storage.local.get(PAUSED_KEY);
      const rest = (now[PAUSED_KEY] || []).filter((s) => s !== site);
      await chrome.storage.local.set({ [PAUSED_KEY]: rest });
      render();
    });

    li.append(name, del);
    list.append(li);
  }

  let granted = false;
  try {
    granted = await chrome.permissions.contains(ALL);
  } catch {
    /* 忽略 */
  }

  perm.textContent = granted ? t('revokeAll') : t('allowAll');
  perm.classList.toggle('primary', !granted);
}

perm.addEventListener('click', async () => {
  let granted = false;
  try {
    granted = await chrome.permissions.contains(ALL);
  } catch {
    /* 忽略 */
  }

  try {
    if (granted) await chrome.permissions.remove(ALL);
    else await chrome.permissions.request(ALL); // 用户手势内请求
  } catch {
    /* 用户取消 */
  }

  render();
});

render();
