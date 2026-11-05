// 契约检查：manifest 引用的每个文件都必须存在，权限不得越界，预算不得超（代码量与加载期监听）。
//
// 这个脚本存在的唯一理由：扩展装不进 Chrome 时，报错发生在浏览器里，
// 而浏览器不会告诉你「少了哪四个图标」。让人肉去看是浪费，让脚本看是零成本。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sizeOf } from './code-bytes.mjs';

// 不能用 new URL('..', import.meta.url).pathname：Windows 上它是 /D:/Programming/Closer/，
// 再交给 path.join 会拼成 D:\D:\Programming\...，整个 verify 直接 ENOENT。
// 文件系统路径只能由 path API 生成。
const ROOT = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const errors = [];
const warnings = [];

// ── 1. 引用的文件必须存在 ────────────────────────────────
const refs = [];
const addRef = (p, from) => {
  if (typeof p !== 'string' || p.includes('*')) return;
  refs.push({ path: p, from });
};

addRef(manifest.background?.service_worker, 'background.service_worker');
addRef(manifest.action?.default_popup, 'action.default_popup');
for (const [size, p] of Object.entries(manifest.action?.default_icon ?? {})) {
  addRef(p, `action.default_icon[${size}]`);
}
for (const [size, p] of Object.entries(manifest.icons ?? {})) {
  addRef(p, `icons[${size}]`);
}
for (const cs of manifest.content_scripts ?? []) {
  for (const p of cs.js ?? []) addRef(p, 'content_scripts.js');
  for (const p of cs.css ?? []) addRef(p, 'content_scripts.css');
}
for (const war of manifest.web_accessible_resources ?? []) {
  for (const p of war.resources ?? []) addRef(p, 'web_accessible_resources');
}

const missing = [];
for (const { path, from } of refs) {
  if (!existsSync(join(ROOT, path))) missing.push(`${path}  ← ${from}`);
}
if (missing.length) {
  errors.push(`manifest 引用了 ${missing.length} 个不存在的文件：\n    ` + missing.join('\n    '));
}

// ── 1b. service worker 动态注册的文件也必须存在 ──────────
// 这些路径不在 manifest 里，Chrome 装得上但运行时静默失败，比图标缺失更难查。
const bgPath = join(ROOT, 'src/background.js');
if (existsSync(bgPath)) {
  const src = readFileSync(bgPath, 'utf8');
  const listed = new Set(
    [...src.matchAll(/['"]((?:src|ui)\/[^'"]+\.(?:js|html|css))['"]/g)].map((m) => m[1])
  );
  const gone = [...listed].filter((p) => !existsSync(join(ROOT, p)));
  if (gone.length) {
    errors.push(`background.js 引用了 ${gone.length} 个不存在的文件：\n    ` + gone.join('\n    '));
  }
}

// ── 2. 权限白名单（宪法第五条：多一个权限就多一段要解释的话）──
const ALLOWED = new Set(['storage', 'scripting', 'activeTab', 'contextMenus']);
for (const p of manifest.permissions ?? []) {
  if (!ALLOWED.has(p)) errors.push(`权限「${p}」不在白名单内，需先在 decisions.md 记一条`);
}
if (manifest.host_permissions) {
  errors.push('出现 host_permissions：权限模型是「可选授权」（D6），不得改为声明式');
}
for (const p of manifest.optional_host_permissions ?? []) {
  if (p !== '*://*/*') warnings.push(`optional_host_permissions 含非常规值：${p}`);
}

// ── 3. 代码量预算（宪法第六条 B 表：有效代码 ≤ 44 KB，单文件 ≤ 总量一半）──
// 口径在 tools/code-bytes.mjs：注释、空行、缩进不计。这里拦的是功能膨胀，不是文档——
// 此前这个数字数的是**原样字节**，注释占了一半，于是五次修正（40 → 60 → 64 → 66 →
// 72 → 80）都是同一个形状：注释写完整 → 超了 → 抬数字。口径换了，那个循环才停。
// 原样字节照样印出来，那个数字才对得上商店包与 View source。
const BUDGET_CODE = 44 * 1024;
const MAX_FILE_CODE = BUDGET_CODE / 2; // 单文件不得吃掉总量的一半：结构上就不允许一个文件变成项目
const contentFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) walk(full);
    else if (name.name.endsWith('.js')) contentFiles.push(full);
  }
};
if (existsSync(join(ROOT, 'src/content'))) walk(join(ROOT, 'src/content'));

if (contentFiles.length) {
  const kb = (n) => (n / 1024).toFixed(1);
  const sizes = contentFiles
    .map((f) => ({ name: f.slice(f.indexOf('src/content/') + 12), ...sizeOf(readFileSync(f, 'utf8')) }))
    .sort((a, b) => b.code - a.code);
  const code = sizes.reduce((n, f) => n + f.code, 0);
  const raw = sizes.reduce((n, f) => n + f.raw, 0);

  warnings.push(
    `content 侧有效代码 ${kb(code)} KB / 44 KB（注释 ${kb(raw - code)} KB 与空行不计入；原样 ${kb(raw)} KB）`
  );
  // 逐文件印出来：总量红的时候，这一行直接指出膨胀点在哪，不用再猜
  warnings.push(`  ${sizes.map((f) => `${f.name} ${kb(f.code)}`).join(' · ')}`);

  if (code > BUDGET_CODE) {
    errors.push(`content 侧有效代码 ${kb(code)} KB 超过 44 KB 预算（宪法第六条 B 表）：按第九条先砍功能`);
  }
  for (const f of sizes) {
    if (f.code > MAX_FILE_CODE) {
      errors.push(
        `${f.name} 有效代码 ${kb(f.code)} KB 超过单文件 ${kb(MAX_FILE_CODE)} KB 上限（总量的一半）：按第五条拆文件，不是删注释`
      );
    }
  }
}

// ── 4. 加载期监听器预算（宪法第六条 A 表：3 个）──────────────
// 这一项静态可数，所以留在 verify 每次跑；A 表另两条（judge()、首帧）要真浏览器，
// 只活在 `npm run smoke` 的 e7 里。此前三条都在 e7，于是 STATUS 上反复出现
// 「e7 未复跑」——能自动验的那项反而不在自动验的地方。
// 数的是行首的 addEventListener：加载期接线写在两处（boot 的接线、hint 的
// pointerover，D32），只数 boot 会漏掉后者，预算数字必须跟着代码走。
const LOAD_LISTENERS = 3;
const countAdds = (rel) => (readFileSync(join(ROOT, rel), 'utf8').match(/^\s*addEventListener\(/gm) || []).length;
const loadAdds = countAdds('src/content/boot.js') + countAdds('src/content/hint.js');
if (loadAdds > LOAD_LISTENERS) {
  errors.push(`页面加载期挂了 ${loadAdds} 个监听，超过 ${LOAD_LISTENERS} 个（宪法第六条 A 表）`);
} else {
  warnings.push(`页面加载期 ${loadAdds} 个监听 / 3 个预算（boot.js + hint.js）`);
}
// overlay 打开后才挂的那批不算加载预算——但它必须真有，否则上面那条可以靠「什么都不挂」通过
if (!countAdds('src/content/overlay.js')) {
  errors.push('overlay.js 里一个 addEventListener 都没有：打开期的事件接线去哪了？');
}

// ── 5. 每个发布文件都必须能解析 ──────────────────────────
// 手写平铺脚本没有编译期，一个多余的花括号只有在 Chrome 里才报错。
// 在这里挡住，比让人打开浏览器听 console 便宜。
const jsFiles = [];
const collect = (dir) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) collect(full);
    else if (name.name.endsWith('.js')) jsFiles.push(full);
  }
};
collect(join(ROOT, 'src'));
collect(join(ROOT, 'ui'));

for (const f of [...jsFiles, ...(existsSync(bgPath) ? [bgPath] : [])]) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    errors.push(`语法错误：${f.replace(ROOT, '')}\n    ${String(e.stderr || e).split('\n')[0]}`);
  }
}

// ── 6. content 侧共用同一个全局词法环境，顶层声明不得撞名 ──
// 无构建的代价：9 个文件按 background 的 FILES 顺序注入同一个隔离世界。
// 顶层 const 重名是 SyntaxError（整份 content 脚本不执行，页面完全没反应）；
// function 重名是静默覆盖（后者赢，行为取决于文件名顺序）。
// 而第 5 节是逐文件 node --check，结构上永远看不见跨文件冲突——
// 只有装上真扩展才炸，且 Chrome 把错误指向第二个文件，与真正改错的地方无关。
// 唯一允许共享的名字是命名空间 Closer（每个文件都写一次 var）。
const SHARED = new Set(['Closer']);
const DECL = /^(?:async\s+)?(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/;

const bgSrc = existsSync(bgPath) ? readFileSync(bgPath, 'utf8') : '';
const injected = [...bgSrc.matchAll(/['"](src\/content\/[\w.-]+\.js)['"]/g)].map((m) => m[1]);
const owners = new Map();
for (const rel of injected) {
  const full = join(ROOT, rel);
  if (!existsSync(full)) continue;
  for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
    const m = DECL.exec(line); // 行首锚定：缩进的都是函数内部的局部声明
    if (!m || SHARED.has(m[1])) continue;
    if (!owners.has(m[1])) owners.set(m[1], []);
    owners.get(m[1]).push(rel);
  }
}
const clashes = [...owners].filter(([, files]) => files.length > 1);
if (clashes.length) {
  errors.push(
    `content 侧顶层声明重名 ${clashes.length} 处（共用全局作用域，装上真扩展才会炸）：\n    ` +
      clashes.map(([name, files]) => `${name} ← ${files.join(' + ')}`).join('\n    ')
  );
}

// ── 输出 ────────────────────────────────────────────────
for (const w of warnings) console.log(`· ${w}`);
console.log(`· content 顶层声明 ${owners.size} 个，来源 ${injected.length} 个注入文件${clashes.length ? '（有重名）' : ''}`);
if (errors.length) {
  console.error('\n✗ 契约检查未通过：');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`\n✓ 契约检查通过（${refs.length} 个引用、${(manifest.permissions ?? []).length} 项权限）`);
