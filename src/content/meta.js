'use strict';

var Closer = (window.Closer ||= {});

// 尺寸、比例、格式。只读，无副作用。
// url 用 currentSrc：<picture> 里真正的那个候选，src 常常只是 1x。

const EXT_NAME = {
  jpg: 'JPEG',
  jpeg: 'JPEG',
  jfif: 'JPEG',
  png: 'PNG',
  apng: 'APNG',
  gif: 'GIF',
  webp: 'WEBP',
  avif: 'AVIF',
  svg: 'SVG',
  bmp: 'BMP',
  ico: 'ICO',
};

Closer.formatOf = function (url) {
  if (!url) return '';

  const data = /^data:image\/([a-z0-9.+-]+)/i.exec(url);
  if (data) return data[1].toUpperCase();

  let path;
  try {
    path = new URL(url, location.href).pathname;
  } catch {
    return '';
  }

  const dot = path.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = path.slice(dot + 1).toLowerCase();
  return EXT_NAME[ext] || ext.toUpperCase().slice(0, 5);
};

// 最大公约数比。超过 21 的整数比没人看得懂，退回两位小数。
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

Closer.ratio = function (w, h) {
  if (!w || !h) return '';
  const d = gcd(w, h);
  const a = w / d;
  const b = h / d;
  if (a <= 21 && b <= 21) return `${a}:${b}`;
  return (w / h).toFixed(2);
};

Closer.humanBytes = function (n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

Closer.meta = function (img) {
  const rect = img.getBoundingClientRect();
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const url = img.currentSrc || img.src;

  return {
    url,
    nw,
    nh,
    sw: Math.round(rect.width),
    sh: Math.round(rect.height),
    ratio: Closer.ratio(nw, nh),
    mp: +((nw * nh) / 1e6).toFixed(2),
    format: Closer.formatOf(url),
    size: 0, // 由 bytes 探测后补上；取不到就一直是 0，面板据此整行不显示
  };
};
