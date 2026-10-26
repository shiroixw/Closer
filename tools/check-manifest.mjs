// 契约检查：manifest 引用的每个文件都必须存在，权限不得越界，体积不得超预算。
//
// 这个脚本存在的唯一理由：扩展装不进 Chrome 时，报错发生在浏览器里，
// 而浏览器不会告诉你「少了哪四个图标」。让人肉去看是浪费，让脚本看是零成本。

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

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

// ── 3. 体积预算（宪法第六条：content 侧 ≤ 64 KB 未压缩）──
// 60 → 64 KB 是 2026-10-23 与「监听 2 → 3」同一条修正案里改的，见 D32。
const BUDGET = 64 * 1024;
let contentBytes = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) walk(full);
    else if (name.name.endsWith('.js')) contentBytes += statSync(full).size;
  }
};
if (existsSync(join(ROOT, 'src/content'))) walk(join(ROOT, 'src/content'));
if (contentBytes > 0) {
  const kb = (contentBytes / 1024).toFixed(1);
  if (contentBytes > BUDGET) errors.push(`content 侧源码 ${kb} KB 超过 64 KB 预算（宪法第六条）`);
  else warnings.push(`content 侧源码 ${kb} KB / 64 KB 预算`);
}

// ── 4. 每个发布文件都必须能解析 ──────────────────────────
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

// ── 5. content 侧共用同一个全局词法环境，顶层声明不得撞名 ──
// 无构建的代价：9 个文件按 background 的 FILES 顺序注入同一个隔离世界。
// 顶层 const 重名是 SyntaxError（整份 content 脚本不执行，页面完全没反应）；
// function 重名是静默覆盖（后者赢，行为取决于文件名顺序）。
// 而第 4 节是逐文件 node --check，结构上永远看不见跨文件冲突——
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
