/**
 * The organisation chart, in code.
 *
 * Transcribed from the fair's org chart. This drives the "tag a whole
 * department" feature: pick ฝ่ายเนื้อหา and everyone in it is on the task.
 *
 * `key` never changes — it is what the database stores. The Thai and English
 * labels are display only, so renaming a department in the UI cannot orphan
 * existing tasks.
 */

export const DEPARTMENTS = [
  {
    key: 'exec',
    th: 'ประธานโครงการ',
    en: 'Project Director',
    units: ['ประธานโครงการ', 'รองประธานโครงการ', 'ผู้ช่วยประธานโครงการ'],
  },
  {
    key: 'secretariat',
    th: 'เลขานุการ',
    en: 'Secretariat',
    units: ['เลขานุการ', 'เลขานุการคณะกรรมการ'],
  },
  {
    key: 'legal',
    th: 'ฝ่ายกฎหมาย',
    en: 'Legal',
    units: ['ฝ่ายกฎหมาย'],
  },
  {
    key: 'finance',
    th: 'เหรัญญิก',
    en: 'Finance',
    units: ['เหรัญญิก'],
  },
  {
    key: 'sponsor',
    th: 'หาทุนและสิทธิประโยชน์',
    en: 'Sponsorship',
    units: ['หาทุนและสิทธิประโยชน์', 'Merch'],
  },
  {
    key: 'hr',
    th: 'HR',
    en: 'HR',
    units: ['HR', 'ประเมินผล'],
  },
  {
    key: 'marketing',
    th: 'Marketing',
    en: 'Marketing',
    units: ['Marketing'],
  },
  {
    key: 'operations',
    th: 'ฝ่ายอำนวยการ',
    en: 'Operations',
    units: [
      'อำนวยการ 1',
      'ทะเบียน บัตรและป้าย',
      'VR',
      'ของที่ระลึก',
      'อำนวยการ 2',
      'สถานที่',
      'ยานพาหนะและประสาน ปอ.พ.',
      'พัสดุ',
      'CSO',
      'อำนวยการ 3',
      'สวัสดิการ',
      'พยาบาล',
      'รปภ, เทศกิจ, ตำรวจ, อำนวยการจราจร',
      'Information',
    ],
  },
  {
    key: 'content',
    th: 'ฝ่ายเนื้อหา',
    en: 'Content',
    units: [
      'Stage',
      'ประสานพิธีกร',
      'ประสานศิลปิน',
      'กิจกรรมบนเวที',
      'Timer + AP',
      'ประสานออแกไนซ์',
      'กิจกรรม',
      'Exhibition',
      'กิจกรรมงานวัด',
      'ตกแต่งสถานที่',
    ],
  },
  {
    key: 'merchant',
    th: 'ฝ่ายร้านค้า',
    en: 'Merchant',
    units: ['ประสานร้านค้านิสิต', 'ประสานร้านค้าทั่วไป'],
  },
  {
    key: 'pr',
    th: 'ฝ่ายประชาสัมพันธ์',
    en: 'Public Relations',
    units: [
      'PR & Media Relations',
      'Admin',
      'Content Creative & Short Video',
      'Graphic Design',
      'Photo & Video',
    ],
  },
];

export const DEPARTMENT_KEYS = DEPARTMENTS.map((d) => d.key);
export const isDepartment = (key) => DEPARTMENT_KEYS.includes(key);

/**
 * Works out someone's department and whether they lead it, from the ตำแหน่ง
 * text in the sheet. It is a best guess on first import only — once an admin
 * sets someone's department in the app, that choice is kept and this is never
 * consulted for them again.
 */
export function guessFromPosition(position = '') {
  const p = String(position);

  // "ประธานฝ่าย…" is a department head; "รองประธานโครงการ" is not.
  const isHead = /ประธานฝ่าย|หัวหน้าฝ่าย|^ประธานโครงการ$|^รองประธานโครงการ$/.test(p);

  const rules = [
    [/อำนวยการ/, 'operations'],
    [/เนื้อหา/, 'content'],
    [/ร้านค้า/, 'merchant'],
    [/ประชาสัมพันธ์|PR/i, 'pr'],
    [/หาทุน|สิทธิประโยชน์|Merch/i, 'sponsor'],
    [/การเงิน|เหรัญญิก/, 'finance'],
    [/กฎหมาย/, 'legal'],
    [/HR|ประเมินผล/i, 'hr'],
    [/Marketing/i, 'marketing'],
    [/เลขานุการ/, 'secretariat'],
    [/ประธานโครงการ|รองประธานโครงการ|ผู้ช่วยประธานโครงการ/, 'exec'],
  ];

  for (const [pattern, key] of rules) {
    if (pattern.test(p)) return { department: key, isHead };
  }
  return { department: null, isHead };
}
