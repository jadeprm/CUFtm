/**
 * หนังสือนัดประชุม — the meeting notice, as a PDF.
 *
 * What people did before this: copy last time's notice in Word, change the
 * date, miss one of the วาระ somebody proposed in the app, send it round. The
 * agenda already lives here, so the letter is built from it and is right by
 * construction.
 *
 * Laid out the way the committee's letters are: who is writing at the top,
 * เรื่อง / เรียน, a paragraph saying when and where, the full ระเบียบวาระ with
 * its numbering and its durations, the closing line, a space to sign, and the
 * invitation list.
 *
 * Built with pdfkit rather than pdf-lib, which the signing code uses. pdf-lib
 * draws the glyphs a string maps to and nothing else; Thai needs the font's
 * layout tables applied, or every tone mark lands in the high position and
 * "ผู้เข้าร่วม" is printed "ผูเขารวม". pdfkit runs the text through fontkit's
 * shaper first, which is the whole difference — see lib/fonts.js.
 */

import PDFDocument from 'pdfkit';
import { sarabunRegular, sarabunBold } from './fonts.js';

const MARGIN = 64;          // ~2.25 cm, the usual margin on a Thai letter
const INK = '#14121a';
const FAINT = '#6b6875';

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

/** "วันพฤหัสบดีที่ 15 ตุลาคม 2569" — Buddhist year, as every Thai letter dates itself. */
export function thaiDate(iso, { withDay = true } = {}) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${withDay ? `วัน${TH_DAYS[dow]}ที่ ` : ''}${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

/**
 * "ประชุมสามัญครั้งที่ 4" is already a meeting, so writing ขอเชิญประชุม in
 * front of it gives "ขอเชิญประชุมประชุมสามัญครั้งที่ 4". Titles that do not
 * say it themselves get the word added.
 */
const asMeeting = (title) => (/^(การ)?ประชุม/.test(String(title).trim())
  ? String(title).trim() : `การประชุม${String(title).trim()}`);

const timeText = (at, to) =>
  (at ? `เวลา ${at} น.${to ? ` – ${to} น.` : ''}` : 'เวลาตามที่จะแจ้งให้ทราบ');

/**
 * @param meeting  a meeting as assembleMeetings shapes it
 * @param nameOf   username -> the name to print
 * @param org      what the committee calls itself at the top of a letter
 */
export function meetingNoticePdf(meeting, {
  nameOf = (u) => u, org = 'งานจุฬาฯแฟร์', docNumber = '', issuedOn = null,
} = {}) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: { Title: `หนังสือนัดประชุม ${meeting.title}`, Creator: 'cu-ftm' },
  });
  doc.registerFont('th', sarabunRegular());
  doc.registerFont('th-bold', sarabunBold());

  const width = doc.page.width - MARGIN * 2;
  const put = (text, { size = 16, bold = false, colour = INK, ...rest } = {}) =>
    doc.font(bold ? 'th-bold' : 'th').fontSize(size).fillColor(colour).text(String(text ?? ''), rest);

  // ---- the head of the letter ----
  put(org, { size: 28, bold: true, align: 'center' });
  put('หนังสือนัดประชุม', { size: 19, align: 'center', colour: FAINT });
  doc.moveDown(0.8);

  if (docNumber) put(`ที่  ${docNumber}`, { size: 16 });
  put(thaiDate(issuedOn || meeting.meetsOn), { size: 16, align: 'right' });
  doc.moveDown(0.6);

  const subject = asMeeting(meeting.title);
  put(`เรื่อง  ขอเชิญเข้าร่วม${subject}`, { size: 17, bold: true });
  put('เรียน  ผู้เข้าร่วมประชุมทุกท่าน', { size: 17 });
  doc.moveDown(0.6);

  // ---- when and where ----
  const where = meeting.place ? `ณ ${meeting.place}`
    : (meeting.joinUrl ? 'ผ่านระบบออนไลน์' : '');
  put(
    `ด้วย${org}กำหนดจัด${subject} ใน${thaiDate(meeting.meetsOn)} ` +
    `${timeText(meeting.meetsAt, meeting.endsAt)}${where ? ` ${where}` : ''} ` +
    'จึงขอเรียนเชิญท่านเข้าร่วมประชุมตามระเบียบวาระการประชุมดังต่อไปนี้',
    // Left, not justified: Thai writes without spaces, so a justified line
    // can only stretch the two or three spaces it happens to have, and the
    // date comes out spread across the page.
    { size: 17, indent: 36, lineGap: 2 },
  );
  if (meeting.note) {
    doc.moveDown(0.3);
    put(meeting.note, { size: 16, colour: FAINT, indent: 36 });
  }
  if (meeting.joinUrl) put(`ลิงก์เข้าประชุม: ${meeting.joinUrl}`, { size: 15, colour: FAINT, indent: 36 });
  doc.moveDown(0.9);

  // ---- ระเบียบวาระ ----
  put('ระเบียบวาระการประชุม', { size: 18, bold: true });
  doc.moveDown(0.3);

  const items = meeting.agenda || [];
  if (!items.length) {
    put('(ยังไม่มีการเสนอวาระ)', { size: 16, colour: FAINT, indent: 20 });
  } else {
    for (const item of items) {
      const heading = (item.depth || 0) === 0;
      const indent = heading ? 12 : 44;
      const mins = item.minutes ? `  (${item.minutes} นาที)` : '';
      // Headings are often typed "วาระที่ 4 เรื่องเสนอเพื่อพิจารณา", which
      // with the number in front reads "4 วาระที่ 4 …".
      const numbered = /^วาระที่\s*\d/.test(String(item.title).trim());
      put(`${numbered ? '' : `${item.number}  `}${item.title}${mins}`, {
        size: heading ? 17 : 16, bold: heading, indent, width,
      });
      if (item.detail) put(item.detail, { size: 15, colour: FAINT, indent: indent + 18, width });
      if (!heading && item.proposedBy) {
        put(`ผู้เสนอ: ${nameOf(item.proposedBy)}`, { size: 14, colour: FAINT, indent: indent + 18, width });
      }
      doc.moveDown(heading ? 0.3 : 0.2);
    }
  }

  // ---- the closing line, and a space to sign ----
  doc.moveDown(0.8);
  put('จึงเรียนมาเพื่อโปรดทราบ และขอเรียนเชิญเข้าร่วมประชุมโดยพร้อมเพรียงกัน',
    { size: 17, indent: 36 });

  /**
   * The signature block needs about 150pt below it. Starting one at the foot
   * of a page is how a letter ends up with a name on a page of its own.
   */
  if (doc.y > doc.page.height - MARGIN - 136) doc.addPage();
  doc.moveDown(1.8);
  const half = width / 2;
  const signOpts = { width: half, align: 'center', continued: false };
  const atRight = (text, opts) => {
    doc.font(opts.bold ? 'th-bold' : 'th').fontSize(opts.size).fillColor(opts.colour || INK)
      .text(text, MARGIN + half, doc.y, signOpts);
  };
  atRight('ขอแสดงความนับถือ', { size: 17 });
  doc.moveDown(2.6);
  atRight('(.............................................)', { size: 16 });
  atRight(nameOf(meeting.createdBy), { size: 16 });
  atRight('ผู้นัดประชุม', { size: 15, colour: FAINT });

  // pdfkit remembers the x of the last positioned text, and the signature
  // block sat in the right-hand half — without this the list below is indented
  // to the middle of the page.
  doc.x = MARGIN;

  // ---- who was invited ----
  const people = (meeting.people || []).map((p) => nameOf(p.username));
  const guests = (meeting.guests || []).filter((g) => g && (g.name || g.email));
  if (people.length || guests.length) {
    // Only a page of its own when the list would not fit under the signature.
    const need = 70 + (people.length + guests.length) * 19;
    if (doc.y + need > doc.page.height - MARGIN) doc.addPage();
    else doc.moveDown(1.6);
    put('รายชื่อผู้ได้รับเชิญ', { size: 18, bold: true });
    doc.moveDown(0.4);
    if (people.length) {
      put(`กรรมการและผู้เกี่ยวข้อง (${people.length} ท่าน)`, { size: 16, bold: true });
      people.forEach((name, i) => put(`${i + 1}.  ${name}`, { size: 15, indent: 18 }));
    }
    if (guests.length) {
      doc.moveDown(0.5);
      put('ผู้เข้าร่วมจากภายนอก', { size: 16, bold: true });
      guests.forEach((g, i) => put(
        `${i + 1}.  ${g.name || g.email}${g.name && g.email ? `  (${g.email})` : ''}`,
        { size: 15, indent: 18 },
      ));
    }
  }

  doc.end();
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
