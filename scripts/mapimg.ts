/** Renders a top-down PNG of a generated world (biomes, hillshade, water, landmarks, homelands). */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generateTerrain } from '../src/world/generateTerrain';
import { BIOMES } from '../src/world/biomes';
import { WORLD_HALF, WORLD_SIZE } from '../src/world/config';

function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => (raw[y * (w * 3 + 1) + 1 + i] = v));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const seed = Number(process.argv[2] ?? 1337);
const out = process.argv[3] ?? 'map.png';
const t0 = performance.now();
const gen = generateTerrain(seed);
console.log(`generated in ${(performance.now() - t0).toFixed(0)} ms`);
const t = gen.terrain;
const S = 640;
const img = new Uint8Array(S * S * 3);
for (let py = 0; py < S; py++) {
  for (let px = 0; px < S; px++) {
    const x = (px / S) * WORLD_SIZE - WORLD_HALF;
    const z = (py / S) * WORLD_SIZE - WORLD_HALF;
    const h = t.heightAt(x, z);
    let c: [number, number, number];
    const wl = t.waterLevelAt(x, z);
    if (h < 0.02) {
      const d = Math.min(1, -h / 12);
      c = [40 * (1 - d) + 20, 150 * (1 - d) + 60, 200 * (1 - d) + 110];
    } else if (wl > -1e5 && h < wl) {
      c = t.isRiver(x, z) ? [60, 150, 230] : [50, 120, 200];
    } else {
      const b = BIOMES[t.biomeAt(x, z)];
      const hex = h < 1.3 ? 0xe8d49a : h > 20 ? b.rock[1] : b.grass[0];
      c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
      const n = { x: 0, y: 0, z: 0 };
      t.normalAt(x, z, n);
      const shade = Math.max(0.35, Math.min(1.25, 0.55 + (n.x * -0.6 + n.y * 0.6 + n.z * -0.5)));
      c = c.map((v) => Math.min(255, v * shade * (0.85 + Math.min(h, 40) / 120))) as [number, number, number];
    }
    const i = (py * S + px) * 3;
    img[i] = c[0];
    img[i + 1] = c[1];
    img[i + 2] = c[2];
  }
}
const dot = (x: number, z: number, r: number, col: [number, number, number]) => {
  const cx = ((x + WORLD_HALF) / WORLD_SIZE) * S;
  const cy = ((z + WORLD_HALF) / WORLD_SIZE) * S;
  for (let y = -r; y <= r; y++)
    for (let xx = -r; xx <= r; xx++) {
      if (xx * xx + y * y > r * r) continue;
      const px = Math.round(cx + xx);
      const py = Math.round(cy + y);
      if (px < 0 || py < 0 || px >= S || py >= S) continue;
      const i = (py * S + px) * 3;
      img[i] = col[0];
      img[i + 1] = col[1];
      img[i + 2] = col[2];
    }
};
for (const l of t.landmarks) dot(l.x, l.z, 4, [255, 230, 60]);
for (const s of gen.sites) dot(s.x, s.z, 6, [255, 40, 40]);
dot(gen.mountain.x, gen.mountain.z, 3, [255, 255, 255]);
writeFileSync(out, png(S, S, img));
console.log('landmarks', t.landmarks.map((l) => `${l.kind}@${l.x.toFixed(0)},${l.z.toFixed(0)}`).join(' '));
console.log('sites', gen.sites.map((s) => `${s.biome}@${s.x.toFixed(0)},${s.z.toFixed(0)}`).join(' '));
console.log('lakes', t.ponds.length, 'rivers', t.rivers.map((r) => r.points.length).join(','));
console.log('regions', t.regions.map((r) => r.name).join(', '));
