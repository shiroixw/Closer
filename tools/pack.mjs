// 出品：把「要发布的那部分」从仓库根里挑出来，压成一个可以直接上传的 zip。
//
// 为什么需要它：仓库根就是扩展根（宪法第五条：无构建、不打包），于是 docs/、tools/、
// package.json、.git 全都躺在发布路径上。上传商店前手工圈文件，等于每次都用一次人肉
// 判断去决定「哪些东西会进入用户机器」——这种判断迟早会错一次，而错的那次是发出去了。
//
// 所以这里不写清单，只写**推导规则**：manifest 引用什么、页面加载什么、后台注册什么，
// 那就是要发布的。规则之外的东西进不来，规则之内的东西跑不掉——清单由 `--check` 当场验。
//
// 体积不是问题（打包后约 50 KB），可复现才是：时间戳钉死在 1980-01-01，条目按名字排序，
// 同一份源码永远得到同一个 zip。于是 sha256 可以当收据用：别人下载到的包，能在这里复算出同一个值。
//
// 用法：
//   node tools/pack.mjs --check    只验清单（verify 调用，不写盘）
//   node tools/pack.mjs            生产 .temp/closer-<version>.zip
//   node tools/pack.mjs --out x.zip
//
// 也可以被 import（e11 用同一份清单去装一次扩展）：
//   import { resolveEntries } from '../pack.mjs'

import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, posix, basename, sep } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '..');

// 白名单：只有运行时要用的两个目录树、两个清单文件可以进包。
// 这条是给未来的自己写检查的——手写清单那天，它会拦住「顺手加一个」。
export const ALLOWED_DIRS = ['src/', 'ui/', 'icons/', '_locales/'];
const ALLOWED_FILES = ['manifest.json', 'LICENSE'];

/* ── 1. 清单：从引用关系推，不手写 ────────────────────── */

export function resolveEntries() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const errors = [];
  const files = new Set(['manifest.json']);

  const addRef = (p) => {
    if (typeof p !== 'string' || p.includes('*')) return; // 通配符不是文件
    files.add(p.replace(/^\/+/, ''));
  };

  // manifest 里直接写死的引用
  addRef(manifest.background?.service_worker);
  addRef(manifest.action?.default_popup);
  for (const p of Object.values(manifest.action?.default_icon ?? {})) addRef(p);
  for (const p of Object.values(manifest.icons ?? {})) addRef(p);
  for (const cs of manifest.content_scripts ?? []) {
    for (const p of cs.js ?? []) addRef(p);
    for (const p of cs.css ?? []) addRef(p);
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    for (const p of war.resources ?? []) addRef(p);
  }

  // background.js 里动态注册的 content 文件，以及它打开的 welcome 页
  const bgPath = join(ROOT, 'src/background.js');
  const bgSrc = existsSync(bgPath) ? readFileSync(bgPath, 'utf8') : '';
  for (const m of bgSrc.matchAll(/['"]((?:src|ui)\/[\w./-]+\.(?:js|html|css))['"]/g)) addRef(m[1]);

  // 页面里的 <script src> 与 <link href>：相对路径按该页面所在目录解析
  const PAGE_REF = /<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/g;

  function pageRefs(relPath) {
    const html = readFileSync(join(ROOT, relPath), 'utf8');
    const out = [];
    for (const m of html.matchAll(PAGE_REF)) {
      const ref = m[1];
      if (/^(?:https?:)?\/\//.test(ref)) {
        // MV3 禁止远程代码，同时它也不该出现在我们的页面里
        errors.push(`${relPath} 引用了远程资源：${ref}`);
        continue;
      }
      out.push(posix.normalize(posix.join(posix.dirname(relPath), ref)));
    }
    return out;
  }

  // 收敛循环：html 里的引用也可能再是 html
  const expanded = new Set();
  for (;;) {
    const next = [...files].filter((f) => !expanded.has(f));
    if (!next.length) break;
    for (const f of next) {
      expanded.add(f);
      if (!f.endsWith('.html')) continue;
      if (!existsSync(join(ROOT, f))) continue; // 缺失的引用由下面的存在性检查统一报
      for (const ref of pageRefs(f)) files.add(ref);
    }
  }

  // 语言包：manifest 声明了 default_locale，就该带上每个语言目录的完整 messages.json
  if (manifest.default_locale) {
    const dir = join(ROOT, '_locales');
    if (!existsSync(dir)) errors.push('manifest 声明了 default_locale，但没有 _locales/');
    else {
      for (const loc of readdirSync(dir, { withFileTypes: true })) {
        if (loc.isDirectory()) files.add(`_locales/${loc.name}/messages.json`);
      }
      if (!files.has(`_locales/${manifest.default_locale}/messages.json`)) {
        errors.push(`default_locale 是 ${manifest.default_locale}，但 _locales/${manifest.default_locale}/ 不存在`);
      }
    }
  }

  // MIT 要求随分发保留版权声明：许可证是包的一部分，不是仓库的点缀
  if (existsSync(join(ROOT, 'LICENSE'))) files.add('LICENSE');

  const entries = [...files].sort();

  /* ── 2. 清单必须成立 ────────────────────────────────── */

  const stray = entries.filter(
    (f) => !ALLOWED_FILES.includes(f) && !ALLOWED_DIRS.some((d) => f.startsWith(d))
  );
  if (stray.length) {
    errors.push(
      `清单里出现非发布文件（只允许 ${ALLOWED_FILES.join(' / ')} 与 ${ALLOWED_DIRS.join(' ')}）：\n    ` +
        stray.join('\n    ')
    );
  }

  let rawBytes = 0;
  const missing = [];
  for (const f of entries) {
    const full = join(ROOT, f);
    if (!existsSync(full)) {
      missing.push(f);
      continue;
    }
    rawBytes += statSync(full).size;
  }
  if (missing.length) {
    errors.push(`清单里有 ${missing.length} 个文件不存在：\n    ` + missing.join('\n    '));
  }

  // 反向覆盖：manifest 的每一处引用都必须出现在清单里。
  // addRef 已经保证了这一点，这里再算一次，是因为「保证」藏在实现里，而检查要能失败。
  const declared = [manifest.background?.service_worker, manifest.action?.default_popup]
    .concat(Object.values(manifest.icons ?? {}))
    .filter((p) => typeof p === 'string' && !p.includes('*'))
    .map((p) => p.replace(/^\/+/, ''));
  const lost = declared.filter((p) => !entries.includes(p));
  if (lost.length) errors.push(`manifest 引用了但没进包：\n    ` + lost.join('\n    '));

  // 正向闭合：运行时目录里不许有「在盘上却不在清单里」的文件。
  // 少了它会发生在另一种形态上——新加的文件没人引用（比如忘了加进 background.js 的 FILES），
  // 于是它既不会进包、也不会生效，而且完全静默。这里把它变成一次失败。
  const onDisk = [];
  const walk = (rel) => {
    const dir = join(ROOT, rel);
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else onDisk.push(child);
    }
  };
  for (const dir of ALLOWED_DIRS) walk(dir.replace(/\/$/, ''));

  const orphans = onDisk.filter((f) => !entries.includes(f));
  if (orphans.length) {
    errors.push(
      `这些文件在运行时目录里，却没有任何引用把它们带进包（悬空文件，永远不会生效）：\n    ` +
        orphans.join('\n    ')
    );
  }

  return { entries, errors, rawBytes, manifest };
}

/* ── 3. 打包（手写 zip，零依赖；无构建是宪法第五条）────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// 1980-01-01 00:00:00：zip 能表示的最早时间，也是「可复现」需要的那一个固定值。
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function buildZip(list) {
  const locals = [];
  const centrals = [];
  const written = [];
  let offset = 0;

  for (const f of list) {
    const data = readFileSync(join(ROOT, f));
    const name = Buffer.from(f, 'utf8');
    const crc = crc32(data);

    // 图标这种已压缩的二进制，deflate 之后反而更大：那就存原文，读者也省一次 inflate
    const packed = deflateRawSync(data, { level: 9 });
    const deflate = packed.length < data.length;
    const body = deflate ? packed : data;
    const method = deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6); // 文件名 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 制作版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // 起始磁盘
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 外部属性：-rw-r--r--（左移会溢出成负数）
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    written.push({ name: f, offset, data, method });
    offset += local.length + name.length + body.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(written.length, 8);
  end.writeUInt16LE(written.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return { buffer: Buffer.concat([...locals, ...centrals, end]), written };
}

// 自校验：把刚写的包原样读回来，逐个条目解压并与源文件比对。
// 手写头部格式的好处是不引依赖，代价是写错一个字段只有解压时才会说话——
// 于是让它在这里说话，而不是在商店审核或用户的浏览器里。
export function verifyZip(buffer, written) {
  for (const { name, offset, data, method } of written) {
    const head = buffer.subarray(offset, offset + 30);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`${name}：本地头签名不对`);
    if (head.readUInt16LE(8) !== method) throw new Error(`${name}：方法字节不一致`);
    const size = head.readUInt32LE(18);
    const nameLen = head.readUInt16LE(26);
    if (buffer.subarray(offset + 30, offset + 30 + nameLen).toString('utf8') !== name) {
      throw new Error(`${name}：文件名回读不一致`);
    }
    const body = buffer.subarray(offset + 30 + nameLen, offset + 30 + nameLen + size);
    const back = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (!back.equals(data)) throw new Error(`${name}：内容回读与源文件不一致`);
  }
  const end = buffer.subarray(buffer.length - 22);
  if (end.readUInt32LE(0) !== 0x06054b50) throw new Error('找不到中央目录结尾');
  if (end.readUInt16LE(10) !== written.length) throw new Error('条目数与中央目录不符');
}

/* ── 4. 两种跑法：验清单 / 出货 ───────────────────────── */

// 被 import 时（e11）不跑命令行：`process.argv[1]` 是调用者，不是本文件
const invoked = !!process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (!invoked) {
  // 什么都不做，等调用方自己调 resolveEntries()
} else {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const outIndex = argv.indexOf('--out');
  const { entries, errors, rawBytes, manifest } = resolveEntries();
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

  if (errors.length) {
    console.error('✗ 发布清单不成立：');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  if (checkOnly) {
    console.log(
      `· 发布清单 ${entries.length} 个文件，未压缩 ${kb(rawBytes)}（不含 docs/、tools/、package.json、.git）`
    );
    console.log('\n✓ 发布清单检查通过');
    process.exit(0);
  }

  const outPath =
    outIndex >= 0 ? argv[outIndex + 1] : join(ROOT, '.temp', `closer-${manifest.version}.zip`);

  const { buffer, written } = buildZip(entries);
  try {
    verifyZip(buffer, written);
  } catch (e) {
    console.error(`✗ 打包自校验失败：${e.message}`);
    process.exit(1);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);

  const sha = createHash('sha256').update(buffer).digest('hex');
  console.log(`· 发布清单 ${entries.length} 个文件，未压缩 ${kb(rawBytes)}`);
  console.log(`✓ ${outPath.split(sep).join('/').replace(ROOT.split(sep).join('/') + '/', '')}  ${kb(buffer.length)}  sha256 ${sha}`);
}
