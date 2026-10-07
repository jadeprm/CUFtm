/** Renders Flex JSON as HTML, approximately, so a card can be looked at without LINE. */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
import { writeFileSync } from 'node:fs';
const { taskCard, eventCard, meetingCard } = await import('./lib/linecards.js');
const today = '2026-10-08';
const names = { Jade_Pres: 'เจด', Kungking_HeadCon: 'กุ๊งกิ๊ง', Totti_HeadOp: 'ต๊อดติ', Yam_HeadSpon: 'แยม', Pin_Sec: 'ปิ่น', New_UnitCon: 'นิว' };
const cards = [
  taskCard({ id: 't1', code: 'T0042', title: 'เตรียมเนื้อหาเพื่อรวมกับ tmr fest', status: 'doing', priority: 'high',
    dueDate: '2026-10-06', dueTime: '18:00', assignees: Object.keys(names), department: 'content', unit: 'Stage',
    description: '- ประสานงานกับฝ่ายเนื้อหา - คุยกับอาจารย์ไวท์ - ประสานกับสถานที่',
    parts: [{ done: true }, { done: true }, { done: false }, { done: false }, { done: false }], links: [1, 2],
    createdBy: 'Jade_Pres', updatedAt: '2026-10-08T07:30:00Z' }, { today, names, canMove: true, link: 'https://x.test' }),
  taskCard({ id: 't2', code: 'T0051', title: 'ส่งไฟล์โปสเตอร์', status: 'review', priority: 'medium', dueDate: '2026-10-10',
    assignees: ['Pin_Sec'], parts: [], links: [], createdBy: 'Totti_HeadOp' }, { today, names, canMove: true, link: 'https://x.test' }),
  eventCard({ id: 'e1', code: 'E0007', title: 'ซ้อมใหญ่รอบสุดท้าย', colour: 'blue', startsOn: '2026-10-20', startsAt: '14:00', endsAt: '17:00',
    place: 'หอประชุมจุฬาฯ', people: [], departments: ['content'], description: 'ทุกฝ่ายที่ขึ้นเวทีต้องมาครบ' }, { today, names, link: 'https://x.test' }),
  meetingCard({ id: 'm1', code: 'M0003', title: 'ประชุมคณะกรรมการโครงการ ครั้งที่ 4/2569', meetsOn: '2026-10-15', meetsAt: '17:00',
    place: 'ห้อง 701 จามจุรี 9', joinUrl: 'https://zoom.us/j/1', status: 'planned', googleUrl: 'https://calendar.google.com/x',
    people: [{ username: 'Kungking_HeadCon', reply: 'invited' }], counts: { accepted: 7, invited: 4, declined: 1, total: 12 },
    agenda: [{ number: '1', title: 'วาระที่ 1 ประธานแจ้งเพื่อทราบ', depth: 0, hasChildren: false, minutes: 0 },
      { number: '4', title: 'วาระที่ 4 เรื่องเสนอเพื่อพิจารณา', depth: 0, hasChildren: true },
      { number: '4.1', title: 'งบประมาณฝ่ายสถานที่', depth: 1, minutes: 15 },
      { number: '4.2', title: 'ตารางซ้อมใหญ่', depth: 1, minutes: 10 }],
    length: { minutes: 25, endsAt: '17:25' }, note: 'อ่านสรุปงบประมาณมาก่อน' }, { today, me: 'Kungking_HeadCon', canReply: true, link: 'https://x.test' }),
];
const SIZE = { xxs: 11, xs: 13, sm: 14, md: 16, lg: 19, xl: 22, xxl: 29 };
const GAP = { none: 0, xs: 2, sm: 4, md: 8, lg: 12, xl: 16, xxl: 20 };
function r(n, parentLayout) {
  if (!n) return '';
  const st = [];
  if (n.flex !== undefined) st.push(`flex:${n.flex} ${n.flex ? 1 : 0} ${n.flex ? '0' : 'auto'}`);
  else if (parentLayout === 'horizontal' || parentLayout === 'baseline') st.push('flex:1 1 0');
  if (n.margin) st.push(parentLayout === 'vertical' || !parentLayout ? `margin-top:${GAP[n.margin] ?? 0}px` : `margin-left:${GAP[n.margin] ?? 0}px`);
  if (n.type === 'box') {
    st.push('display:flex', `flex-direction:${n.layout === 'vertical' ? 'column' : 'row'}`, 'min-width:0');
    if (n.layout === 'baseline') st.push('align-items:baseline');
    if (n.backgroundColor) st.push(`background:${n.backgroundColor}`);
    if (n.cornerRadius) st.push(`border-radius:${n.cornerRadius}`);
    for (const [k, c] of [['paddingAll', 'padding'], ['paddingTop', 'padding-top'], ['paddingBottom', 'padding-bottom'], ['paddingStart', 'padding-left'], ['paddingEnd', 'padding-right']]) if (n[k]) st.push(`${c}:${n[k]}`);
    if (n.width) st.push(`width:${n.width}`, 'flex:none');
    if (n.height) st.push(`height:${n.height}`);
    if (n.borderWidth) st.push(`border:${n.borderWidth} solid ${n.borderColor}`, 'box-sizing:border-box');
    if (n.justifyContent) st.push(`justify-content:${n.justifyContent}`);
    if (n.alignItems) st.push(`align-items:${n.alignItems}`);
    const sp = GAP[n.spacing] || 0;
    if (sp) st.push(`gap:${sp}px`);
    return `<div style="${st.join(';')}">${n.contents.map((c) => r(c, n.layout)).join('')}</div>`;
  }
  if (n.type === 'text') {
    st.push(`font-size:${SIZE[n.size] || 14}px`, `color:${n.color || '#111'}`, `font-weight:${n.weight === 'bold' ? 700 : 400}`,
      `text-align:${n.align === 'end' ? 'right' : n.align || 'left'}`, n.wrap === false ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' : 'white-space:pre-wrap', 'min-width:0', 'line-height:1.35');
    return `<div style="${st.join(';')}">${n.text.replace(/</g, '&lt;')}</div>`;
  }
  if (n.type === 'filler') return '<div style="flex:1"></div>';
  if (n.type === 'separator') return `<div style="height:1px;background:${n.color || '#ddd'};margin:8px 0"></div>`;
  if (n.type === 'button') {
    const bg = n.style === 'primary' ? (n.color || '#06c755') : n.style === 'secondary' ? '#eef0f3' : 'transparent';
    const fg = n.style === 'primary' ? '#fff' : n.style === 'link' ? '#2d6cdf' : '#111';
    return `<div style="background:${bg};color:${fg};border-radius:8px;padding:9px;text-align:center;font-size:14px;font-weight:600">${n.action.label}</div>`;
  }
  return '';
}
const bubble = (b) => `<div style="width:300px;flex:none;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.15);font-family:'IBM Plex Sans Thai',system-ui,sans-serif">
  ${r(b.header, 'vertical')}${b.body ? r(b.body, 'vertical') : ''}${b.footer ? r(b.footer, 'vertical') : ''}</div>`;
const html = `<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;700&display=swap"></head>
<body style="margin:0;padding:20px;background:#8cabd9;display:flex;gap:16px;align-items:flex-start">${cards.map(bubble).join('')}</body></html>`;
writeFileSync('/tmp/claude-0/flexprev/cards.html', html);
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const pg = await (await b.newContext({ viewport: { width: 1320, height: 900 }, deviceScaleFactor: 2 })).newPage();
await pg.goto('file:///tmp/claude-0/flexprev/cards.html'); await pg.waitForTimeout(1200);
await pg.screenshot({ path: '/tmp/claude-0/flexprev/cards.png', fullPage: true });
await b.close();
console.log('ok');
