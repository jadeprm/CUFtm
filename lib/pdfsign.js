import { PDFDocument } from 'pdf-lib';

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

/** PDF coordinates start at the BOTTOM-left; screens start at the top-left. */
function boxToPdf(page, mark) {
  const { width, height } = page.getSize();
  const w = Math.max(0.02, Math.min(1, mark.w || 0.22)) * width;
  const h = Math.max(0.01, Math.min(1, mark.h || 0.08)) * height;
  const x = Math.max(0, Math.min(1, mark.x || 0)) * width;
  const topDown = Math.max(0, Math.min(1, mark.y || 0)) * height;
  return { x, y: height - topDown - h, width: w, height: h };
}

/**
 * Fits the signature inside its box without distorting it.
 *
 * A signature stretched to fill a box looks forged, so the image keeps its
 * proportions and is centred in the space the uploader drew.
 */
function fit(box, imageWidth, imageHeight) {
  if (!imageWidth || !imageHeight) return box;
  const scale = Math.min(box.width / imageWidth, box.height / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
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
    if (!mark || !mark.png) continue;

    // Page numbers come from people, so they are 1-based, and a mark on a page
    // that no longer exists is reported rather than crashing the whole file.
    const index = Math.max(1, Math.round(mark.page || 1)) - 1;
    if (index >= pages.length) {
      skipped.push({ username: mark.username, reason: 'NO_SUCH_PAGE', page: mark.page });
      continue;
    }

    const page = pages[index];
    let image;
    try {
      image = await pdf.embedPng(mark.png);
    } catch (error) {
      skipped.push({ username: mark.username, reason: 'BAD_IMAGE' });
      continue;
    }

    const box = boxToPdf(page, mark);
    const at = fit(box, image.width, image.height);
    page.drawImage(image, at);
    placed.push({ username: mark.username, page: index + 1 });
  }

  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes: Buffer.from(bytes), placed, skipped, pages: pages.length };
}

/** How many pages, so the viewer knows what to draw before loading it all. */
export async function pageCount(bytes) {
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
    return pdf.getPageCount();
  } catch (error) {
    return 0;
  }
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
