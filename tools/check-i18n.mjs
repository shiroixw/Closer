// 契约检查：语言包。
//
// 这是唯一一类「代码全对、界面仍然是坏的」的错法：getMessage 找不到 key 只返回空字符串，
// 不抛错、不告警，页面上就是一块空白；而语言包是 JSON，node --check 也看不见它。
// 所以每条都写成能失败的断言：
//   1. default_locale 与 _locales 互相成立（缺一边，Chrome 直接装不上）
//   2. 每种语言的 key 集合与默认语言逐字相同（多一个、少一个都报）
//   3. 同一 key 的占位符跨语言相同（中文漏写 $SITE$，按钮就成了「在  上暂停」）
//   4. manifest 与代码里引用的 key 必须存在（有字面量引用，就能静态扫）
//   5. 反过来：没人引用的 key 也报出来——漏接线的文案和漏写的 key 一样看不见

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LOCALES = join(ROOT, '_locales');

const errors = [];
const warnings = [];

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ── 1. default_locale 与 _locales 必须互相成立 ──────────────
const manifestPath = join(ROOT, 'manifest.json');
const manifestText = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);
const def = manifest.default_locale;

if (!existsSync(LOCALES)) {
  console.error('✗ _locales 目录不存在：manifest 声明了 default_locale，就必须有语言包');
  process.exit(1);
}
if (!def) {
  errors.push('manifest 没有 default_locale：只要存在 _locales 目录，Chrome 就要求写它');
} else if (!existsSync(join(LOCALES, def, 'messages.json'))) {
  errors.push(`default_locale 指向的 _locales/${def}/messages.json 不存在（它是所有语言的回退终点）`);
}

const locales = readdirSync(LOCALES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

// ── 每种语言：必须有 messages.json，每条必须有非空 message ──
const catalogs = new Map();
const placeholdersOf = (text) =>
  new Set([...String(text || '').matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase()));

for (const loc of locales) {
  const p = join(LOCALES, loc, 'messages.json');
  if (!existsSync(p)) {
    errors.push(`_locales/${loc}/messages.json 不存在（每个语言目录都必须有）`);
    continue;
  }

  let data;
  try {
    data = readJson(p);
  } catch (e) {
    errors.push(`_locales/${loc}/messages.json 不是合法 JSON：${e.message}`);
    continue;
  }

  for (const [key, entry] of Object.entries(data)) {
    if (!entry || typeof entry.message !== 'string' || !entry.message.trim()) {
      errors.push(`_locales/${loc}: 「${key}」缺少非空的 message`);
    }
  }

  // 声明了却没用、用了却没声明，两种都是静默错误
  for (const [key, entry] of Object.entries(data)) {
    if (!entry || typeof entry.message !== 'string') continue;
    const used = placeholdersOf(entry.message);
    const declared = new Set(Object.keys(entry.placeholders || {}).map((s) => s.toLowerCase()));
    const undeclared = [...used].filter((x) => !declared.has(x));
    const dead = [...declared].filter((x) => !used.has(x));
    if (undeclared.length) {
      errors.push(
        `_locales/${loc}: 「${key}」用了 ${undeclared.map((x) => `$${x.toUpperCase()}$`).join(' ')}，却没在 placeholders 里声明`
      );
    }
    if (dead.length) {
      errors.push(`_locales/${loc}: 「${key}」声明了没用到的占位符 ${dead.join(', ')}`);
    }
  }

  catalogs.set(loc, data);
}

// ── 2. key 集合逐字相同 ────────────────────────────────────
const base = def ? catalogs.get(def) : null;
if (def && !base) errors.push(`默认语言 ${def} 没有可用的 messages.json`);

if (base) {
  const baseKeys = new Set(Object.keys(base));
  for (const [loc, data] of catalogs) {
    if (loc === def) continue;
    const keys = new Set(Object.keys(data));
    const missing = [...baseKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !baseKeys.has(k));
    if (missing.length) errors.push(`_locales/${loc} 缺 ${missing.length} 个 key：${missing.join(', ')}`);
    if (extra.length) {
      errors.push(`_locales/${loc} 有 ${extra.length} 个 ${def} 里没有的 key：${extra.join(', ')}`);
    }
  }

  // ── 3. 占位符跨语言相同 ─────────────────────────────────
  for (const [loc, data] of catalogs) {
    if (loc === def) continue;
    for (const key of baseKeys) {
      if (!data[key]?.message) continue;
      const want = [...placeholdersOf(base[key].message)].sort().join(',');
      const got = [...placeholdersOf(data[key].message)].sort().join(',');
      if (want !== got) {
        errors.push(
          `_locales/${loc}: 「${key}」的占位符是 ${got || '（无）'}，${def} 是 ${want || '（无）'}——语序不同只能靠占位符对上`
        );
      }
    }
  }
}

// ── 4. 被引用的 key 必须存在 ───────────────────────────────
const KEY_REF = /(?:Closer\.t|\bt|getMessage)\(\s*['"]([A-Za-z0-9_@]+)['"]/g;
const ATTR_REF = /data-i18n(?:-html)?="([A-Za-z0-9_@]+)"/g;

const referenced = new Map(); // key -> [file]
const files = [];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|html)$/.test(entry.name)) files.push(full);
  }
};
walk(join(ROOT, 'src'));
walk(join(ROOT, 'ui'));

const note = (key, file) => {
  if (!referenced.has(key)) referenced.set(key, []);
  referenced.get(key).push(file.replace(ROOT, '').replace(/\\/g, '/'));
};

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(KEY_REF)) note(m[1], file);
  for (const m of text.matchAll(ATTR_REF)) note(m[1], file);
}
for (const m of manifestText.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) note(m[1], manifestPath);

if (base) {
  const unknown = [...referenced].filter(([key]) => !(key in base));
  if (unknown.length) {
    errors.push(
      `代码/manifest 引用了 ${def} 里不存在的 key：\n    ` +
        unknown.map(([key, where]) => `${key} ← ${where.join(', ')}`).join('\n    ')
    );
  }

  const unused = Object.keys(base).filter((key) => !referenced.has(key));
  if (unused.length) {
    warnings.push(`语言包里有 ${unused.length} 个 key 没人引用（漏接线？）：${unused.join(', ')}`);
  }

  // 与默认语言一字不差的译文：可能是故意的，也可能是忘了翻
  for (const [loc, data] of catalogs) {
    if (loc === def) continue;
    const same = Object.keys(base).filter((key) => data[key]?.message === base[key]?.message);
    if (same.length) {
      warnings.push(`_locales/${loc} 有 ${same.length} 条与 ${def} 完全相同，确认是有意为之：${same.join(', ')}`);
    }
  }
}

// ── 输出 ────────────────────────────────────────────────────
const keyCount = base ? Object.keys(base).length : 0;

for (const w of warnings) console.log(`· ${w}`);
console.log(`· 语言：${[`${def}（默认）`, ...locales.filter((l) => l !== def)].join(' / ')} · ${keyCount} 个 key`);

if (errors.length) {
  console.error('\n✗ 语言包检查未通过：');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`\n✓ 语言包检查通过（${catalogs.size} 种语言 × ${keyCount} 个 key）`);
