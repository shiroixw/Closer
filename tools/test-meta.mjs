// meta.js / actions.js 里的纯函数单测。
// judge() 有 19 条断言，同一批文件里这些函数却一条都没有——这个不对称本身就是 bug。
// 面板上看到的每个数字、保存下来的每个文件名，都从这里过。

import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(new URL(`../src/content/${name}`, import.meta.url), 'utf8');

// 两个文件都只用 window / location / URL 三个外部标识符；
// Blob、document、Image 只出现在函数体里，不执行就碰不到。
const ctx = { window: {}, location: { href: 'https://example.com/a/b.html' }, URL };
vm.createContext(ctx);
vm.runInContext(read('meta.js'), ctx);
vm.runInContext(read('actions.js'), ctx);

const C = ctx.window.Closer;

const img = (over = {}) => ({
  naturalWidth: 1920,
  naturalHeight: 1080,
  currentSrc: 'https://cdn.example.com/p/photo.webp',
  getBoundingClientRect: () => ({ width: 640.4, height: 360.6 }),
  ...over,
});

const cases = [
  /* ---- ratio：≤ 21 的整数比，否则两位小数 ---- */
  ['16:9', () => C.ratio(1920, 1080), '16:9'],
  ['4:3', () => C.ratio(800, 600), '4:3'],
  ['约分后 1:1', () => C.ratio(22, 22), '1:1'],
  ['分子 > 21 退回小数', () => C.ratio(1000, 40), '25.00'],
  ['互质大数退回小数', () => C.ratio(1000, 999), '1.00'],
  ['缺一边 → 空串', () => C.ratio(0, 800), ''],
  ['竖图 3:4', () => C.ratio(600, 800), '3:4'],

  /* ---- humanBytes：0 是「不知道」，不是 0 B ---- */
  ['0 字节 → 空串', () => C.humanBytes(0), ''],
  ['512 B', () => C.humanBytes(512), '512 B'],
  ['1024 → 1 KB', () => C.humanBytes(1024), '1 KB'],
  ['1536 → 2 KB（四舍五入）', () => C.humanBytes(1536), '2 KB'],
  ['58 KB', () => C.humanBytes(58 * 1024), '58 KB'],
  ['1.5 MB', () => C.humanBytes(1.5 * 1048576), '1.5 MB'],

  /* ---- formatOf：data URL、查询串、无扩展名 ---- */
  ['扩展名大写归一', () => C.formatOf('https://a.com/x/photo.WEBP'), 'WEBP'],
  ['查询串不算进扩展名', () => C.formatOf('https://a.com/x/photo.jpeg?w=1'), 'JPEG'],
  ['jfif 归到 JPEG', () => C.formatOf('https://a.com/x/pic.jfif'), 'JPEG'],
  ['data URL', () => C.formatOf('data:image/png;base64,AAA'), 'PNG'],
  ['无扩展名 → 空串', () => C.formatOf('https://a.com/img/abc123'), ''],
  ['空 URL → 空串', () => C.formatOf(''), ''],
  ['未知扩展名截断到 5 位', () => C.formatOf('https://a.com/x/pic.unknownext'), 'UNKNO'],

  /* ---- fileName：有扩展名就原样，没有就 image-宽x高 ---- */
  ['原名带扩展名', () => C.fileName('https://a.com/pics/photo.JPG', { format: 'JPEG', nw: 800, nh: 600 }), 'photo.JPG'],
  ['无扩展名 → 尺寸名', () => C.fileName('https://a.com/img/abc123', { format: 'WEBP', nw: 800, nh: 600 }), 'image-800x600.webp'],
  ['路径以 / 结尾', () => C.fileName('https://a.com/pic/', { format: 'PNG', nw: 10, nh: 20 }), 'image-10x20.png'],
  ['data URL', () => C.fileName('data:image/png;base64,AAAA', { format: 'PNG', nw: 5, nh: 5 }), 'image-5x5.png'],
  ['百分号编码名要解码', () => C.fileName('https://a.com/%E5%9B%BE.png', { format: 'PNG', nw: 9, nh: 9 }), '图.png'],
  ['格式未知时不硬编扩展名', () => C.fileName('https://a.com/img/abc', { format: '', nw: 7, nh: 7 }), 'image-7x7'],

  /* ---- meta：面板显示的那几个数 ---- */
  ['meta 取整渲染尺寸', () => C.meta(img()).sw, 640],
  ['meta 取整高度', () => C.meta(img()).sh, 361],
  ['meta 用 currentSrc', () => C.meta(img()).url, 'https://cdn.example.com/p/photo.webp'],
  ['meta 百万像素两位', () => C.meta(img()).mp, 2.07],
  ['meta 的 size 初始为 0（待探测）', () => C.meta(img()).size, 0],
];

let pass = 0;
const fails = [];

for (const [name, fn, want] of cases) {
  let got;
  try {
    got = fn();
  } catch (e) {
    got = `抛错 ${e.message}`;
  }
  if (got === want) pass++;
  else fails.push(`${name}：期望 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}`);
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length));
const failNames = new Set(fails.map((f) => f.slice(0, f.indexOf('：'))));
for (const [name, , want] of cases) {
  const bad = failNames.has(name);
  console.log(`${bad ? '✗' : '✓'} ${pad(name, 28)} ${bad ? fails.find((f) => f.startsWith(name + '：')).split('：')[1] : '→ ' + want}`);
}

console.log(`\n${pass}/${cases.length} 通过`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log('  ' + f);
}
process.exit(fails.length ? 1 : 0);
