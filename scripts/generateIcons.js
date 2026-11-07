import fs from 'node:fs';
import { deflateSync } from 'node:zlib';

const directory = new URL('../public/icons/', import.meta.url);
const pages = [
  { points: [[7, 8], [13, 8], [16, 10], [16, 24], [12, 22], [7, 22]], color: [36, 65, 92] },
  { points: [[17, 10], [20, 8], [25, 8], [25, 22], [21, 22], [17, 24]], color: [36, 65, 92] },
  { points: [[20, 8], [23, 8], [23, 16], [21.5, 14.5], [20, 16]], color: [192, 111, 73] },
];

function contains(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function colorAt(x, y) {
  const cx = Math.max(8, Math.min(24, x));
  const cy = Math.max(8, Math.min(24, y));
  if (Math.hypot(x - cx, y - cy) > 7) return null;
  for (let i = pages.length - 1; i >= 0; i--) {
    if (contains(pages[i].points, x, y)) return pages[i].color;
  }
  return [185, 220, 242];
}

function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, 8 + data.length)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return bytes;
}

fs.mkdirSync(directory, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = 1 + size * 4;
  const pixels = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const samples = [];
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const color = colorAt((x + (sx + 0.5) / 4) * 32 / size, (y + (sy + 0.5) / 4) * 32 / size);
          if (color) samples.push(color);
        }
      }
      if (!samples.length) continue;
      const offset = y * stride + 1 + x * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = Math.round(samples.reduce((sum, color) => sum + color[channel], 0) / samples.length);
      }
      pixels[offset + 3] = Math.round(samples.length / 16 * 255);
    }
  }
  fs.writeFileSync(new URL('icon' + size + '.png', directory), Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]));
}
