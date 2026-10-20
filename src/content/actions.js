'use strict';

var Closer = (window.Closer ||= {});

// 复制与保存。都复用 bytes 取回的内容，不再发第二次请求。
// blob 必须在页面里造：SW 造的 blob:chrome-extension:// 页面加载不了。

async function toPng(buf, mime) {
  const src = URL.createObjectURL(new Blob([buf], { type: mime || 'application/octet-stream' }));
  try {
    const img = new Image();
    img.src = src;
    await img.decode();

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

/** 复制图片本身（PNG）。动图会变成静态帧——需要动画请用保存。 */
Closer.copyImage = async function (media) {
  const png = await toPng(media.buf, media.mime);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
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
