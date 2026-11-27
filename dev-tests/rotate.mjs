/**
 * Verifies rotated (0/90/180/270) and CropBox-offset PDF signature stamping.
 *
 * Tests both the raw coordinate math in boxToPdf() and real pdf.js rendering
 * (via Playwright + public/vendor/pdf.min.js when Playwright is installed)
 * using an asymmetric 4:1 PNG whose top-left quadrant is bright green and the
 * rest is magenta, proving every stamped signature lands in the right visual
 * spot, keeps its aspect ratio, and stands upright.
 */
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';
import { boxToPdf, stampSignatures } from '../lib/pdfsign.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed += 1;
};

/** Builds an uncompressed-filter RGBA PNG in pure Node (no canvas dependency). */
function makeAsymmetricPng(width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 4;
      const isTopLeft = x < width * 0.25 && y < height * 0.5;
      raw[p] = isTopLeft ? 0x00 : 0xb5;
      raw[p + 1] = isTopLeft ? 0xcc : 0x1e;
      raw[p + 2] = isTopLeft ? 0x44 : 0x64;
      raw[p + 3] = 0xff;
    }
  }
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Projects a raw PDF point (X, Y) into displayed top-left fractions [0..1] of CropBox. */
function rawToVisualFrac(page, X, Y) {
  const cb = page.getCropBox();
  const rot = ((Math.round(page.getRotation().angle) % 360) + 360) % 360;
  const rx = X - cb.x;
  const ry = Y - cb.y;
  if (rot === 90) return { u: ry / cb.height, v: rx / cb.width };
  if (rot === 180) return { u: (cb.width - rx) / cb.width, v: ry / cb.height };
  if (rot === 270) return { u: (cb.height - ry) / cb.height, v: (cb.width - rx) / cb.width };
  return { u: rx / cb.width, v: (cb.height - ry) / cb.height };
}

/** Applies pdf-lib's drawImage transform: translate(x,y) * rotateCCW(rot) * local(lx, ly). */
function imageCornerToRaw(at, lx, ly) {
  const rad = ((at.rotate?.angle || 0) * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return {
    X: at.x + lx * c - ly * s,
    Y: at.y + lx * s + ly * c,
  };
}

const CASES = [
  { label: '0° portrait', size: [595, 842], rot: 0, crop: null },
  { label: '90° CW rotated', size: [595, 842], rot: 90, crop: null },
  { label: '180° rotated', size: [595, 842], rot: 180, crop: null },
  { label: '270° CW rotated', size: [595, 842], rot: 270, crop: null },
  { label: '0° with CropBox offset', size: [700, 950], rot: 0, crop: [50, 70, 595, 842] },
  { label: '90° CW with CropBox offset', size: [700, 950], rot: 90, crop: [50, 70, 595, 842] },
];

const MARK = { x: 0.65, y: 0.12, w: 0.25, h: 0.10 };
const IMG_W = 200;
const IMG_H = 50;
const sigPng = makeAsymmetricPng(IMG_W, IMG_H);

const doc = await PDFDocument.create();
for (const c of CASES) {
  const p = doc.addPage(c.size);
  if (c.crop) p.setCropBox(...c.crop);
  if (c.rot) p.setRotation(degrees(c.rot));
}
const origBytes = Buffer.from(await doc.save({ useObjectStreams: false }));

console.log('1. Coordinate & aspect-ratio math (boxToPdf)');
const pages = doc.getPages();
CASES.forEach((c, i) => {
  const page = pages[i];
  const at = boxToPdf(page, MARK, { width: IMG_W, height: IMG_H });
  const tl = rawToVisualFrac(page, ...Object.values(imageCornerToRaw(at, 0, at.height)));
  const tr = rawToVisualFrac(page, ...Object.values(imageCornerToRaw(at, at.width, at.height)));
  const bl = rawToVisualFrac(page, ...Object.values(imageCornerToRaw(at, 0, 0)));
  const br = rawToVisualFrac(page, ...Object.values(imageCornerToRaw(at, at.width, 0)));

  const ratio = at.width / at.height;
  const cx = (tl.u + br.u) / 2;
  const cy = (tl.v + br.v) / 2;
  const inside = tl.u >= MARK.x - 1e-4 && tr.u <= MARK.x + MARK.w + 1e-4 &&
    tl.v >= MARK.y - 1e-4 && bl.v <= MARK.y + MARK.h + 1e-4;
  const upright = tl.u < tr.u && tl.v < bl.v && Math.abs(tl.v - tr.v) < 1e-4 && Math.abs(tl.u - bl.u) < 1e-4;
  const centered = Math.abs(cx - (MARK.x + MARK.w / 2)) < 1e-4 && Math.abs(cy - (MARK.y + MARK.h / 2)) < 1e-4;

  ok(`${c.label}: inside visual box, upright, centred, 4:1 ratio`,
    inside && upright && centered && Math.abs(ratio - 4) < 1e-3,
    `center=(${cx.toFixed(3)},${cy.toFixed(3)}) ratio=${ratio.toFixed(2)}`);
});

console.log('\n2. Full stampSignatures() round-trip');
const marks = CASES.map((_, i) => ({
  username: 'tester',
  page: i + 1,
  ...MARK,
  png: sigPng,
}));
const stamped = await stampSignatures(origBytes, marks);
ok('all 6 pages stamped with zero skipped', stamped.placed.length === CASES.length && stamped.skipped.length === 0,
  `placed=${stamped.placed.length} skipped=${stamped.skipped.length}`);

// Visual verification in real pdf.js via Playwright when available.
let playwright = null;
try { playwright = await import('playwright'); } catch {}
if (playwright) {
  console.log('\n3. Real pdf.js visual pixel verification (Playwright)');
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    const pdfjsSrc = readFileSync(join(ROOT, 'public/vendor/pdf.min.js'), 'utf8');
    const workerSrc = readFileSync(join(ROOT, 'public/vendor/pdf.worker.min.js'), 'utf8');
    await page.setContent('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
    await page.addScriptTag({ content: pdfjsSrc });

    const results = await page.evaluate(async ({ b64, workerCode }) => {
      const workerBlob = new Blob([workerCode], { type: 'text/javascript' });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
      const raw = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const pdf = await window.pdfjsLib.getDocument({ data: raw }).promise;
      const out = [];
      const canvas = document.getElementById('c');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      for (let n = 1; n <= pdf.numPages; n++) {
        const pg = await pdf.getPage(n);
        const vp = pg.getViewport({ scale: 1 });
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await pg.render({ canvasContext: ctx, viewport: vp }).promise;
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        let minX = canvas.width, maxX = -1, minY = canvas.height, maxY = -1;
        let gSumX = 0, gSumY = 0, gCount = 0;
        let mSumX = 0, mSumY = 0, mCount = 0;

        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const k = (y * canvas.width + x) * 4;
            const r = img[k], g = img[k + 1], b = img[k + 2];
            if (r > 240 && g > 240 && b > 240) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (g > r + 40 && g > b + 40) { gSumX += x; gSumY += y; gCount++; }
            else if (r > g + 40) { mSumX += x; mSumY += y; mCount++; }
          }
        }
        out.push({
          page: n,
          w: canvas.width,
          h: canvas.height,
          u0: minX / canvas.width,
          u1: maxX / canvas.width,
          v0: minY / canvas.height,
          v1: maxY / canvas.height,
          greenX: gCount ? (gSumX / gCount) / canvas.width : -1,
          greenY: gCount ? (gSumY / gCount) / canvas.height : -1,
          magX: mCount ? (mSumX / mCount) / canvas.width : -1,
          magY: mCount ? (mSumY / mCount) / canvas.height : -1,
          gCount,
          mCount,
        });
      }
      await pdf.destroy();
      return out;
    }, { b64: stamped.bytes.toString('base64'), workerCode: workerSrc });

    results.forEach((r, i) => {
      const c = CASES[i];
      const cx = (r.u0 + r.u1) / 2;
      const cy = (r.v0 + r.v1) / 2;
      const targetCx = MARK.x + MARK.w / 2;
      const targetCy = MARK.y + MARK.h / 2;
      const posOk = Math.abs(cx - targetCx) < 0.015 && Math.abs(cy - targetCy) < 0.015 &&
        r.u0 >= MARK.x - 0.015 && r.u1 <= MARK.x + MARK.w + 0.015 &&
        r.v0 >= MARK.y - 0.015 && r.v1 <= MARK.y + MARK.h + 0.015;
      // Green marker sits at top-left of upright signature -> smaller X and smaller Y than magenta centroid
      const uprightOk = r.gCount > 20 && r.mCount > 100 && r.greenX < r.magX && r.greenY < r.magY;
      ok(`pdf.js render page ${r.page} (${c.label})`,
        posOk && uprightOk,
        `center=(${cx.toFixed(3)},${cy.toFixed(3)}) green=(${r.greenX.toFixed(3)},${r.greenY.toFixed(3)}) mag=(${r.magX.toFixed(3)},${r.magY.toFixed(3)})`);
    });
  } finally {
    await browser.close();
  }
}

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
