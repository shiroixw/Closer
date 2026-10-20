'use strict';

var Closer = (window.Closer ||= {});

// 复制与保存。都复用 bytes 取回的内容，不再发第二次请求。
// blob 必须在页面里造：SW 造的 blob:chrome-extension:// 页面加载不了。

// canvas 按像素收费，不按字节：64 MB 的 JPEG 能解出 300 MP，一次要 1.2 GB 的 RGBA，
// 标签页直接被系统杀掉——比「复制失败」难看得多。所以这里有两道闸，
// 超了不硬来，退回复制地址（降级必须说出来，静默降级等于骗人）。
const MAX_SIDE = 16384; // Chrome 的 canvas 单边上限
const MAX_PIXELS = 32e6; // 约 32 MP：8000×4000 之下，中间缓冲约 128 MB

async function toPng(buf, mime) {
  const src = URL.createObjectURL(new Blob([buf], { type: mime || 'application/octet-stream' }));
  try {
    const img = new Image();
    img.src = src;
    await img.decode();

    const { naturalWidth: w, naturalHeight: h } = img;
    if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) return null;

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);

    return await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(src);
  }
}

/**
 * 复制图片本身（PNG）。动图会变成静态帧——需要动画请用保存。
 * 返回 'image' | 'address'：像素超出 canvas 预算时退回复制地址，
 * 由调用方把这次降级讲出来。
 */
Closer.copyImage = async function (media, url) {
  const png = await toPng(media.buf, media.mime);
  if (!png) {
    if (!url) throw new Error('no-url');
    await Closer.copyText(url);
    return 'address';
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  return 'image';
};

Closer.copyText = (text) => navigator.clipboard.writeText(text);

/** 保存原始字节：动图仍是动图。用 <a download>，不申请 downloads 权限（D12）。 */
Closer.saveImage = async function (media, name) {
  const src = URL.createObjectURL(new Blob([media.buf], { type: media.mime || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = src;
  a.download = name || 'image';
  a.style.display = 'none';
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(src), 1000);
};

/** 文件名：取 URL 末段；没有图片扩展名时用 image-<宽>x<高>。 */
Closer.fileName = function (url, meta) {
  const ext = (meta.format || '').toLowerCase();
  let name = '';

  try {
    const path = new URL(url, location.href).pathname;
    name = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
  } catch {
    /* data: URL，没有路径 */
  }

  const hasExt = /\.[a-z0-9]{2,5}$/i.test(name);
  if (name && hasExt) return name;
  if (!hasExt) name = '';
  return `image-${meta.nw}x${meta.nh}${ext ? '.' + ext : ''}`;
};
