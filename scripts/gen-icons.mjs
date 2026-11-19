/**
 * 图标生成脚本（零依赖）。
 *
 * 【为什么自己画】
 * 扩展图标必须是 PNG（manifest 不支持 SVG）。
 * 为了不引入 sharp / canvas 这类重依赖，这里手写一个最小 PNG 编码器：
 *   像素 → 扫描线 + zlib 压缩 → IDAT chunk → 拼上 IHDR/IEND
 * 配合 4x 超采样做抗锯齿，出来的图边缘是平滑的。
 *
 * 用法：node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../public/icons');
const SIZES = [16, 32, 48, 128];

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA 像素数组 → PNG buffer */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前面加一个 filter byte（0 = None）
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 图形 ---------------- */

/** 圆角矩形内部判定（归一化坐标 0..1） */
function inRoundedRect(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 闪电多边形（归一化坐标） */
const BOLT = [
  [0.56, 0.08],
  [0.3, 0.54],
  [0.47, 0.54],
  [0.42, 0.93],
  [0.72, 0.44],
  [0.53, 0.44],
];

/** 点在多边形内（射线法） */
function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 画一个图标 */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // 超采样倍数（抗锯齿）
  const radius = 0.22;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgHits = 0;
      let boltHits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          if (inRoundedRect(px, py, radius)) bgHits += 1;
          if (inPolygon(px, py, BOLT)) boltHits += 1;
        }
      }
      const total = SS * SS;
      const bgAlpha = bgHits / total;
      const boltAlpha = (boltHits / total) * bgAlpha;

      // 背景：橙色渐变（#ff6b35 → #ff9f45）
      const t = y / size;
      const bgR = Math.round(255 + (255 - 255) * t);
      const bgG = Math.round(107 + (159 - 107) * t);
      const bgB = Math.round(53 + (69 - 53) * t);

      // 前景闪电：白色
      const r = Math.round(bgR * (1 - boltAlpha) + 255 * boltAlpha);
      const g = Math.round(bgG * (1 - boltAlpha) + 255 * boltAlpha);
      const b = Math.round(bgB * (1 - boltAlpha) + 255 * boltAlpha);

      const idx = (y * size + x) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = Math.round(bgAlpha * 255);
    }
  }
  return rgba;
}

/* ---------------- 输出 ---------------- */

mkdirSync(OUT_DIR, { recursive: true });
SIZES.forEach((size) => {
  const png = encodePng(size, size, drawIcon(size));
  const file = resolve(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`生成 ${file} (${png.length} bytes)`);
});
