// Generates cover.png (800x534) for gladys-switcher: plain Node, no
// dependency. A water heater tank with its heat waves, a roller shutter and
// a wall plug, joined by local network waves, on a warm-to-cool gradient (no
// brand logo). Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = x / W;
    const u = y / H;
    set(x, y, [200 - 150 * t + 20 * u, 90 + 40 * t, 60 + 130 * t]);
  }
}
const white = [255, 255, 255];
const dark = [30, 36, 60];
const warm = [255, 170, 80];
const glass = [190, 220, 245];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
// An arc of a ring, between two angles (radians, 0 = right, clockwise on screen).
const arc = (cx, cy, r, width, from, to, color) => {
  for (let y = Math.floor(cy - r - width); y <= cy + r + width; y += 1) {
    for (let x = Math.floor(cx - r - width); x <= cx + r + width; x += 1) {
      const angle = Math.atan2(y - cy, x - cx);
      if (angle < from || angle > to) continue;
      const a = Math.max(
        0,
        Math.min(1, width / 2 - Math.abs(Math.hypot(x - cx, y - cy) - r) + 0.5),
      );
      if (a > 0) set(x, y, color, a);
    }
  }
};
// Rounded rectangle, anti-aliased corners.
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};

// Soft halo.
disc(400, 270, 260, white, 0.06);

// Water heater: a tall rounded tank, a gauge, heat waves above.
box(90, 150, 230, 430, 40, white, 0.95);
box(110, 190, 210, 400, 28, glass, 0.6);
disc(160, 240, 22, dark);
disc(160, 240, 16, white);
for (let a = -2.4; a <= -0.7; a += 0.02) {
  disc(160 + 12 * Math.cos(a), 240 + 12 * Math.sin(a), 1.6, warm);
}
for (const dx of [-30, 0, 30]) {
  for (let y = 70; y < 130; y += 1) {
    disc(160 + dx + 8 * Math.sin(y / 7), y, 3.2, warm);
  }
}
// Roller shutter: a box and its slats, half closed.
box(320, 150, 480, 180, 8, white, 0.95);
box(330, 180, 470, 430, 6, glass, 0.35);
for (let y = 186; y < 320; y += 22) box(330, y, 470, y + 16, 4, white, 0.92);
box(330, 330, 470, 430, 6, [255, 255, 255], 0.12);
// Wall plug.
box(560, 220, 720, 380, 34, white, 0.95);
disc(640, 300, 52, glass, 0.7);
disc(620, 300, 9, dark);
disc(660, 300, 9, dark);
// Local network waves joining them.
for (const r of [26, 46, 66]) arc(400, 500, r, 7, -2.6, -0.54, white);
disc(400, 500, 8, white);
// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
