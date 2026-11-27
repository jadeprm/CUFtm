import { PDFDocument, degrees } from 'pdf-lib';
import PdfKitDocument from 'pdfkit';
import { sarabunRegular, sarabunBold } from './fonts.js';

export const BOX_KINDS = ['signature', 'date', 'nameTitle', 'initials'];

const TH_SHORT_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/**
 * Formats a timestamp as a Thai Buddhist short date in Asia/Bangkok
 * (e.g. "27 พ.ย. 2569") for `date` stamp boxes.
 */
export function formatThaiDate(value = new Date()) {
  const dt = value instanceof Date ? value : new Date(value || Date.now());
  const safe = Number.isNaN(dt.getTime()) ? new Date() : dt;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(safe);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  const y = get('year');
  const m = get('month');
  const d = get('day');
  if (!y || !m || !d) return '';
  return `${d} ${TH_SHORT_MONTHS[m - 1]} ${y + 543}`;
}

/**
 * Renders Thai text into a single-page PDF snippet using pdfkit + TH Sarabun
 * New so Thai tone marks and vowels shape properly before pdf-lib embeds it.
 */
function renderThaiBoxPdf(lines, widthPt, heightPt) {
  const w = Math.max(24, Number(widthPt) || 120);
  const h = Math.max(12, Number(heightPt) || 28);
  const cleanLines = (lines || []).map((l) => String(l || '').trim()).filter(Boolean);
  return new Promise((resolve, reject) => {
    const doc = new PdfKitDocument({
      size: [w, h],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: true,
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('th', sarabunRegular());
    doc.registerFont('th-bold', sarabunBold());

    const padX = 2;
    const availW = Math.max(10, w - padX * 2);
    const count = Math.max(1, cleanLines.length);
    // Start generous and shrink until every line fits comfortably inside the box.
    let size = Math.min(18, Math.max(6, (h / count) * (count > 1 ? 0.68 : 0.72)));
    for (let i = 0; i < cleanLines.length; i++) {
      doc.font(i === 0 && count > 1 ? 'th-bold' : 'th').fontSize(size);
      const measured = doc.widthOfString(cleanLines[i]);
      if (measured > availW && measured > 0) {
        size = Math.max(5.5, size * (availW / measured));
      }
    }

    const lineGap = size * 1.18;
    const totalH = lineGap * count;
    const startY = Math.max(0, (h - totalH) / 2);

    cleanLines.forEach((line, i) => {
      const isSecond = i > 0;
      const lineSize = isSecond ? Math.max(5, size * 0.88) : size;
      doc.font(i === 0 && count > 1 ? 'th-bold' : 'th')
        .fontSize(lineSize)
        .fillColor(isSecond ? '#3a3240' : '#14121a')
        .text(line, padX, startY + i * lineGap, {
          width: availW,
          align: 'center',
          lineBreak: false,
        });
    });

    doc.end();
  });
}

/**
 * Putting signatures into a PDF.
 *
 * The uploader drags a box over the page in the browser and the box is stored
 * as fractions of the page — 0.62 across, 0.18 down — not as pixels. That one
 * decision is what makes this reliable: the browser renders the page at
 * whatever width the screen happens to be, A4 and Letter are different sizes,
 * and a phone in portrait is different again. Fractions survive all of it.
 *
 * The signed file is always rebuilt from the untouched original, never from
 * the previous signed copy. Stamping onto a stamped file would compound any
 * error and would make a wrongly-placed signature impossible to take back.
 */

/**
 * Displayed page geometry after CropBox and clockwise rotation.
 *
 * Scanners and print-to-PDF tools often store a landscape sheet as a portrait
 * page with a 90° or 270° /Rotate flag, or trim margins with a non-zero
 * CropBox origin. pdf.js renders the rotated CropBox, so top-left fractions
 * from the browser refer to that displayed rectangle — not raw MediaBox (0, 0).
 */
function pageGeometry(page) {
  const cb = typeof page.getCropBox === 'function'
    ? page.getCropBox()
    : { x: 0, y: 0, ...page.getSize() };
  const rawAngle = typeof page.getRotation === 'function' ? (page.getRotation()?.angle || 0) : 0;
  const rot = ((Math.round(rawAngle) % 360) + 360) % 360;
  const swapped = rot === 90 || rot === 270;
  return {
    cx: cb.x || 0,
    cy: cb.y || 0,
    cw: cb.width,
    ch: cb.height,
    rot,
    vw: swapped ? cb.height : cb.width,
    vh: swapped ? cb.width : cb.height,
  };
}

/**
 * Fits the signature inside its visual box without distorting it.
 *
 * A signature stretched to fill a box looks forged, so the image keeps its
 * proportions and is centred in the space the uploader drew — computed in
 * displayed (visual) space before rotating into raw PDF page coordinates.
 */
function fit(box, imageWidth, imageHeight) {
  if (!imageWidth || !imageHeight) return box;
  const scale = Math.min(box.width / imageWidth, box.height / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    ...box,
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * Maps a top-left visual box (and optional image aspect ratio) onto raw PDF
 * page coordinates, accounting for CropBox origin and 0/90/180/270 rotation.
 *
 * pdf-lib draws images with local +x along width, local +y along height, and
 * rotates counter-clockwise around the anchor (x, y). Passing `degrees(rot)`
 * counter-rotates the image in raw space so that when a viewer applies the
 * page's clockwise /Rotate flag, the signature stands upright inside the exact
 * visual rectangle the uploader selected.
 */
export function boxToPdf(page, mark, imageSize) {
  const { cx, cy, cw, ch, rot, vw, vh } = pageGeometry(page);
  const w = Math.max(0.02, Math.min(1, mark.w || 0.22)) * vw;
  const h = Math.max(0.01, Math.min(1, mark.h || 0.08)) * vh;
  const u = Math.max(0, Math.min(1, mark.x || 0)) * vw;
  const v = Math.max(0, Math.min(1, mark.y || 0)) * vh;

  const visual = imageSize && imageSize.width && imageSize.height
    ? fit({ x: u, y: v, width: w, height: h }, imageSize.width, imageSize.height)
    : { x: u, y: v, width: w, height: h };

  const rw = visual.width;
  const rh = visual.height;
  const vu = visual.x;
  const vv = visual.y;

  if (rot === 90) {
    return { x: cx + vv + rh, y: cy + vu, width: rw, height: rh, rotate: degrees(90) };
  }
  if (rot === 180) {
    return { x: cx + cw - vu, y: cy + vv + rh, width: rw, height: rh, rotate: degrees(180) };
  }
  if (rot === 270) {
    return { x: cx + cw - vv - rh, y: cy + ch - vu, width: rw, height: rh, rotate: degrees(270) };
  }
  return { x: cx + vu, y: cy + ch - vv - rh, width: rw, height: rh, rotate: degrees(0) };
}

/**
 * Builds the signed copy.
 *
 * `marks` is one entry per signature to place: { page, x, y, w, h, png }.
 * Only the people who have actually approved are passed in, so the file on
 * disk always matches the approvals recorded in the database.
 */
export async function stampSignatures(originalBytes, marks) {
  const pdf = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
  const pages = pdf.getPages();
  const placed = [];
  const skipped = [];

  for (const mark of marks) {
    if (!mark) continue;
    const kind = BOX_KINDS.includes(mark.kind) ? mark.kind : 'signature';
    if ((kind === 'signature' || kind === 'initials') && !mark.png) continue;

    // Page numbers come from people, so they are 1-based, and a mark on a page
    // that no longer exists is reported rather than crashing the whole file.
    const index = Math.max(1, Math.round(mark.page || 1)) - 1;
    if (index >= pages.length) {
      skipped.push({ username: mark.username, reason: 'NO_SUCH_PAGE', page: mark.page });
      continue;
    }

    const page = pages[index];

    if (kind === 'date' || kind === 'nameTitle') {
      const lines = kind === 'date'
        ? [mark.dateText || formatThaiDate(mark.actedAt || new Date())]
        : [mark.fullName || mark.displayName || mark.username || '', mark.position || ''].filter(Boolean);
      if (!lines.length) continue;

      const at = boxToPdf(page, mark);
      try {
        const snippet = await renderThaiBoxPdf(lines, at.width, at.height);
        const [embedded] = await pdf.embedPdf(snippet);
        page.drawPage(embedded, at);
        placed.push({ username: mark.username, page: index + 1, kind });
      } catch (error) {
        skipped.push({ username: mark.username, reason: 'BAD_TEXT_STAMP', kind });
      }
      continue;
    }

    let image;
    try {
      image = await pdf.embedPng(mark.png);
    } catch (error) {
      skipped.push({ username: mark.username, reason: 'BAD_IMAGE' });
      continue;
    }

    const at = boxToPdf(page, mark, { width: image.width, height: image.height });
    page.drawImage(image, at);
    placed.push({ username: mark.username, page: index + 1, kind });
  }

  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes: Buffer.from(bytes), placed, skipped, pages: pages.length };
}

/**
 * Inspects a PDF buffer to count its pages and separate password-encrypted
 * files from corrupt ones so the user gets a clear message they can act on.
 */
export async function inspectPdf(bytes) {
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
    return { ok: true, pages: pdf.getPageCount() };
  } catch (error) {
    const msg = String(error?.message || '');
    if (/encrypt/i.test(msg)) return { ok: false, error: 'PDF_ENCRYPTED' };
    return { ok: false, error: 'UNREADABLE_PDF' };
  }
}

/** How many pages, so the viewer knows what to draw before loading it all. */
export async function pageCount(bytes) {
  const res = await inspectPdf(bytes);
  return res.ok ? res.pages : 0;
}

/**
 * Refuses anything that is not a PDF, before it reaches the database.
 *
 * The check is the file's own first bytes rather than its name: a .pdf
 * extension is a claim by whoever uploaded it, and "%PDF-" is the file itself
 * saying what it is.
 */
export function looksLikePdf(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** Likewise for a signature image, which must be a real PNG. */
export function looksLikePng(buffer) {
  if (!buffer || buffer.length < 8) return false;
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return magic.every((byte, i) => buffer[i] === byte);
}

/** The pixel size of a PNG, read from its header. */
export function pngSize(buffer) {
  if (!looksLikePng(buffer) || buffer.length < 24) return { width: 0, height: 0 };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
