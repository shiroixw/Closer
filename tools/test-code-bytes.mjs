// code-bytes.mjs 的口径单测。
//
// 这个数字现在是宪法第六条 B 表的账本，所以它的语义必须钉死在断言里：
// 「注释不计、行尾注释计、缩进不计、注释之后的代码不许丢」。最后一条最要紧——
// 一个把代码一起当注释吃掉的扫描器，会把增长静默藏起来，而预算的用处正是指向增长。

import { codeBytes } from './code-bytes.mjs';

const bytes = (s) => Buffer.byteLength(s);
const CODE = 'const x = 1;';

const cases = [
  ['单行注释不算', '// 说明\nconst x = 1;', bytes(CODE)],
  ['块注释不算', '/* 说明\n * 第二行\n */\nconst x = 1;', bytes(CODE)],
  ['注释关闭后同一行的代码要留下', '/* 说明 */ const x = 1;', bytes(CODE)],
  ['行尾注释按代码算（切它要真词法分析）', 'const x = 1; // 说明', bytes('const x = 1; // 说明')],
  ['空行与缩进不算', '\n\n    const x = 1;   \n\n', bytes(CODE)],
  ['字符串里的 // 不是注释', "const u = 'https://a.com/x';", bytes("const u = 'https://a.com/x';")],
  ['字符串里的 /* 不是注释', "const s = '/* 不是注释 */';", bytes("const s = '/* 不是注释 */';")],
  ['全是注释 → 0', '// a\n// b\n', 0],
  ['空文件 → 0', '', 0],
];

let pass = 0;
const fails = [];
for (const [name, src, want] of cases) {
  const got = codeBytes(src);
  if (got === want) pass++;
  else fails.push(`${name}：期望 ${want}，得到 ${got}`);
}

for (const f of fails) console.log(`✗ ${f}`);
console.log(`\n${pass}/${cases.length} 通过`);
if (fails.length) process.exit(1);
