// 生成扩展图标（纯 Node，无第三方依赖）：蓝色圆角底 + 白色书签 + 底部三色“标签组”条
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BLUE = [26, 115, 232];
const WHITE = [255, 255, 255];
const BAR = [
  [251, 188, 4],
  [52, 168, 83],
  [234, 67, 53],
];

// 在 0..1 归一化坐标下判定像素颜色
function shade(u, v) {
  // 圆角矩形背景
  const r = 0.2;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) return null;
  // 底部三色条
  if (v >= 0.76 && v <= 0.88 && u >= 0.16 && u <= 0.84) {
    const seg = Math.min(2, Math.floor(((u - 0.16) / 0.68) * 3));
    const gap = ((u - 0.16) / 0.68) * 3 - seg;
    if (seg > 0 && gap < 0.08) return BLUE;
    return BAR[seg];
  }
  // 书签形状：矩形 + 底部 V 形缺口
  const l = 0.32;
  const rr = 0.68;
  const top = 0.14;
  const bottom = 0.66;
  if (u >= l && u <= rr && v >= top && v <= bottom) {
    const notchDepth = 0.14;
    const mid = (l + rr) / 2;
    const notchTop = bottom - notchDepth * (1 - Math.abs(u - mid) / ((rr - l) / 2));
    if (v > notchTop) return BLUE;
    return WHITE;
  }
  return BLUE;
}

for (const size of [16, 32, 48, 128]) {
  const ss = 4; // 超采样抗锯齿
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let as = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (!c) continue;
          rs += c[0];
          gs += c[1];
          bs += c[2];
          as += 1;
        }
      }
      const i = (y * size + x) * 4;
      if (as) {
        buf[i] = Math.round(rs / as);
        buf[i + 1] = Math.round(gs / as);
        buf[i + 2] = Math.round(bs / as);
        buf[i + 3] = Math.round((as / (ss * ss)) * 255);
      }
    }
  }
  writeFileSync(join(outDir, `icon${size}.png`), png(size, buf));
  console.log(`icon${size}.png`);
}
