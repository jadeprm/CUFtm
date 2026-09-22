/**
 * The organisation chart, in code.
 *
 * Transcribed from the fair's org chart, then split further to match the
 * Department column in the roster sheet: อำนวยการ 1, 2 and 3 each have their
 * own head, so each is its own teamspace rather than one big Operations pile.
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

  /**
   * The Operations umbrella and its three divisions.
   *
   * `operations` is the whole-division teamspace (ฝ่ายอำนวยการใหญ่). Because
   * the three below list it as their parent, giving someone access to it gives
   * them the three as well — which is what "OperAll" in the sheet means.
   */
  {
    key: 'operations',
    th: 'ฝ่ายอำนวยการใหญ่',
    en: 'Operations (all)',
    units: ['อำนวยการ'],
  },
  {
    key: 'oper1',
    th: 'อำนวยการ 1',
    en: 'Operations 1',
    parent: 'operations',
    units: ['ทะเบียน บัตรและป้าย', 'VR', 'ของที่ระลึก'],
  },
  {
    key: 'oper2',
    th: 'อำนวยการ 2',
    en: 'Operations 2',
    parent: 'operations',
    units: ['สถานที่', 'ยานพาหนะและประสาน ปอ.พ.', 'พัสดุ', 'CSO'],
  },
  {
    key: 'oper3',
    th: 'อำนวยการ 3',
    en: 'Operations 3',
    parent: 'operations',
    units: ['สวัสดิการ', 'พยาบาล', 'รปภ, เทศกิจ, ตำรวจ, อำนวยการจราจร', 'Information'],
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

const byKey = new Map(DEPARTMENTS.map((d) => [d.key, d]));
export const departmentByKey = (key) => byKey.get(key) || null;

/** Every department that lists `key` as its parent. */
export const childrenOf = (key) =>
  DEPARTMENTS.filter((d) => d.parent === key).map((d) => d.key);

/**
 * Turns a granted list into the full set it implies.
 *
 * Granting "ฝ่ายอำนวยการใหญ่" is meant to cover the three divisions under it;
 * spelling all four out in the sheet does the same thing, so both spellings
 * behave identically.
 */
export function expandAccess(keys = []) {
  const out = new Set();
  for (const key of keys) {
    if (!isDepartment(key)) continue;
    out.add(key);
    for (const child of childrenOf(key)) out.add(child);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Reading what the sheet says
// ---------------------------------------------------------------------------

/**
 * The Department column is written by people, not by a form, so it is matched
 * forgivingly: case, spaces, underscores and hyphens are all ignored, and each
 * department answers to several spellings. Matching is exact on the normalised
 * text rather than by substring, so "Merch" (sponsorship) is never mistaken
 * for "Merchant".
 */
const normalise = (value) =>
  String(value ?? '').toLowerCase().replace(/[\s_\-.]/g, '');

export const ALL_DEPARTMENTS = 'ALL';

const ALIASES = {
  [ALL_DEPARTMENTS]: ['all', 'ทั้งหมด', 'ทุกฝ่าย', '*', 'everything'],
  exec: ['exec', 'executive', 'director', 'projectdirector', 'ประธานโครงการ'],
  secretariat: ['secretariat', 'secretary', 'sec', 'เลขา', 'เลขานุการ'],
  legal: ['legal', 'law', 'กฎหมาย', 'ฝ่ายกฎหมาย'],
  finance: ['finance', 'financial', 'cfo', 'treasurer', 'การเงิน', 'เหรัญญิก'],
  sponsor: ['sponsor', 'sponsorship', 'spon', 'merch', 'หาทุน', 'สิทธิประโยชน์', 'หาทุนและสิทธิประโยชน์'],
  hr: ['hr', 'humanresources', 'ประเมินผล'],
  marketing: ['marketing', 'mkt'],
  operations: ['operall', 'operationall', 'operationsall', 'opall', 'oper', 'operation', 'operations', 'op', 'อำนวยการ', 'ฝ่ายอำนวยการ', 'ฝ่ายอำนวยการใหญ่'],
  oper1: ['oper1', 'operation1', 'operations1', 'op1', 'อำนวยการ1'],
  oper2: ['oper2', 'operation2', 'operations2', 'op2', 'อำนวยการ2'],
  oper3: ['oper3', 'operation3', 'operations3', 'op3', 'อำนวยการ3'],
  content: ['content', 'con', 'เนื้อหา', 'ฝ่ายเนื้อหา'],
  merchant: ['merchant', 'shop', 'shops', 'ร้านค้า', 'ฝ่ายร้านค้า'],
  pr: ['pr', 'publicrelations', 'ประชาสัมพันธ์', 'ฝ่ายประชาสัมพันธ์'],
};

const LOOKUP = new Map();
for (const [key, spellings] of Object.entries(ALIASES)) {
  for (const spelling of spellings) LOOKUP.set(normalise(spelling), key);
}

export const departmentFromLabel = (label) => LOOKUP.get(normalise(label)) || null;

/**
 * Reads one Department cell: "Content, PR" → two keys; "All" → everything.
 *
 * Anything it cannot place comes back in `unknown` rather than being dropped,
 * so the admin page can say which cell needs fixing instead of quietly giving
 * someone no access at all.
 */
export function parseDepartmentList(text) {
  const parts = String(text ?? '')
    .split(/[,/|;·\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const keys = [];
  const unknown = [];
  let all = false;

  for (const part of parts) {
    const key = departmentFromLabel(part);
    if (key === ALL_DEPARTMENTS) all = true;
    else if (key) keys.push(key);
    else unknown.push(part);
  }

  return { all, keys: expandAccess(keys), unknown };
}

/**
 * Works out someone's department from the ตำแหน่ง text in the sheet, for rows
 * where the Department column is blank. Only a fallback: whatever the
 * Department column says wins.
 */
export function guessFromPosition(position = '') {
  const p = String(position);

  // "ประธานฝ่าย…" is a department head; "รองประธานโครงการ" is not.
  const isHead = /ประธานฝ่าย|หัวหน้าฝ่าย|^ประธานโครงการ$|^รองประธานโครงการ$/.test(p);

  // Ordered: the numbered divisions must be tested before plain อำนวยการ,
  // and "ใหญ่" (the whole division) before them both.
  const rules = [
    [/อำนวยการใหญ่/, 'operations'],
    [/อำนวยการ\s*1/, 'oper1'],
    [/อำนวยการ\s*2/, 'oper2'],
    [/อำนวยการ\s*3/, 'oper3'],
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
