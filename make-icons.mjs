// 生成 PWA 图标（纯 Node 手写 PNG 编码，不依赖任何图形库）
//   icon-192.png / icon-512.png        普通图标
//   icon-maskable-512.png              Android 自适应图标（内容收在中心 80% 安全区）
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// ---------- 最小 PNG 编码器 ----------
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: None
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 画图标：深色底 + 四根柱（红/金/蓝/绿），呼应看板的 K 线与分时 ----------
const BG = [0x14, 0x18, 0x21];
const BG2 = [0x1b, 0x21, 0x30];
const BARS = [
  [0xef, 0x4d, 0x5a],
  [0xe0, 0xb9, 0x6a],
  [0x5b, 0x8d, 0xef],
  [0x43, 0xd1, 0x9a],
];
const HEIGHTS = [0.42, 0.66, 0.50, 0.88];

function render(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  // maskable 要求内容落在中心 80% 内，普通图标留边小一些
  const pad = maskable ? size * 0.20 : size * 0.14;
  const area = size - pad * 2;
  const n = BARS.length;
  const gap = area * 0.11;
  const bw = (area - gap * (n - 1)) / n;
  const baseY = pad + area;
  const radius = maskable ? 0 : size * 0.22;

  const inRounded = (x, y) => {
    if (maskable) return true;
    const r = radius;
    const cx = Math.min(Math.max(x, r), size - 1 - r);
    const cy = Math.min(Math.max(y, r), size - 1 - r);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x, y)) { buf[i + 3] = 0; continue; }
      // 背景：轻微竖向渐变，避免死板
      const t = y / size;
      let c = [0, 1, 2].map((k) => Math.round(BG[k] + (BG2[k] - BG[k]) * t));
      // 柱体
      for (let b = 0; b < n; b++) {
        const x0 = pad + b * (bw + gap);
        const barH = area * HEIGHTS[b];
        const y0 = baseY - barH;
        const r = Math.max(1, Math.round(bw * 0.22));
        // 圆角矩形
        const cx2 = Math.min(Math.max(x, x0 + r), x0 + bw - r);
        const cy2 = Math.min(Math.max(y, y0 + r), baseY - r);
        const dx = x - cx2, dy = y - cy2;
        if (dx * dx + dy * dy <= r * r) c = BARS[b];
      }
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
    }
  }
  return encodePng(size, size, buf);
}

writeFileSync('icon-192.png', render(192, false));
writeFileSync('icon-512.png', render(512, false));
writeFileSync('icon-maskable-512.png', render(512, true));
console.log('wrote icon-192.png / icon-512.png / icon-maskable-512.png');

// ---------- manifest ----------
const manifest = {
  name: 'A股情绪与事件看板',
  short_name: 'A股看板',
  description: 'A股情绪指标、跌停统计、事件倒计时与盘前信号',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#141821',
  theme_color: '#141821',
  lang: 'zh-CN',
  icons: [
    { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
writeFileSync('manifest.webmanifest', JSON.stringify(manifest, null, 1), 'utf8');
console.log('wrote manifest.webmanifest');
