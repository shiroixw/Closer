// 有效代码字节：把注释与空行去掉之后，一个文件还剩多少真东西。
//
// 为什么不用 `statSync().size`：那个数字把注释也算进去了，而注释是宪法第五条
// 要求的「收据」。实测注释占 content 侧一半（34.6 KB / 72.3 KB）——预算若含
// 注释，一半的额度就在管文档，而「写清楚」会变成要花钱的事。这条账已经算过
// 五次（宪法第六条 40 → 60 → 64 → 66 → 72 → 80），每次都是同一个形状：
// 注释写完整 → 超了 → 抬数字。换口径，这个循环才停。
//
// 口径写在明处，因为它必须可复算：
//   · 整行注释（去掉空白后以 `//` 开头）不算；
//   · 块注释（`/*` 到 `*/`，含 `*` 开头的续行）不算——`overlay.js` 里那段 CSS
//     也写成块注释，一并算注释，它同样是写给人看的；
//   · 空行不算，行首行尾空白不算；
//   · 行尾那半句注释**算代码**。把它切出来需要真正的词法分析（要认字符串、
//     模板、正则字面量），而一个会静默吃代码的扫描器，比多算几十字节贵得多。
//     实测代价 1.3 KB，且方向安全：只会多算，不会把增长藏起来。
//
// 这个数字只服务宪法第六条 B 表（代码量预算），不承诺任何毫秒——扩展源码不走
// 网络，Chrome 从本地包里读，字节数解释不了快慢。

/** 一段源码的有效代码字节数。 */
export function codeBytes(src) {
  const keep = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let rest = line.trim();
    if (inBlock) {
      const end = rest.indexOf('*/');
      if (end < 0) continue;
      inBlock = false;
      rest = rest.slice(end + 2).trim();
    }
    if (rest.startsWith('//')) continue;
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      if (end < 0) {
        inBlock = true;
        continue;
      }
      rest = rest.slice(end + 2).trim();
    }
    if (rest) keep.push(rest);
  }
  return Buffer.byteLength(keep.join('\n'));
}

/** 文件的有效代码字节数；同时给出原样字节，报告里两个都印（对得上商店包）。 */
export function sizeOf(src) {
  return { raw: Buffer.byteLength(src), code: codeBytes(src) };
}
