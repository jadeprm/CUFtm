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

const BUILTIN = [
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
    units: ['ทะเบียน บัตรและป้าย', 'VR', 'ของที่ระลึก', 'เสื้อโครงการ'],
  },
  {
    key: 'oper2',
    th: 'อำนวยการ 2',
    en: 'Operations 2',
    parent: 'operations',
    units: ['สถานที่', 'ยานพาหนะและประสาน ปอ.พ.', 'พัสดุ', 'CSO', 'Green Guide'],
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

/**
 * The chart as it stands right now: the transcription above, plus whatever
 * the admin page has since added, renamed or put away.
 *
 * These four are deliberately mutable and are rebuilt IN PLACE by applyOrg().
 * Every other module imports them once at load; handing out a fresh array
 * would leave half the app looking at last request's org chart. The contents
 * change, the objects never do.
 */
export const DEPARTMENTS = [];
export const DEPARTMENT_KEYS = [];
const byKey = new Map();
export const isDepartment = (key) => byKey.has(key);
export const departmentByKey = (key) => byKey.get(key) || null;

/**
 * A key for a department somebody typed into the admin page.
 *
 * Keys are what the database stores against every task, grant and meeting, so
 * they have to be stable and ASCII. An English name gives a readable one;
 * a Thai-only name falls back to a short random suffix, which is ugly in a
 * query and invisible everywhere else.
 */
export function makeDepartmentKey(en = '', th = '', taken = []) {
  const base = String(en || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20)
    || String(th || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
  const used = new Set([...byKey.keys(), ...taken]);
  let key = base || 'dept';
  if (!used.has(key)) return key;
  for (let n = 2; n < 500; n++) if (!used.has(key + n)) return key + n;
  return `dept${Date.now().toString(36)}`;
}

/**
 * Fold the admin page's changes into the chart.
 *
 * `departments` rows either override a built-in by key — its labels, its
 * parent, whether it is put away — or add one the org chart never had.
 * `units` rows add or remove a section inside a department. Hiding is used
 * rather than deleting throughout: a department key already written on two
 * hundred tasks cannot be taken out of the world, only out of the pickers.
 */
export function applyOrg({ departments = [], units = [] } = {}) {
  const overrides = new Map(departments.map((d) => [d.key, d]));
  const live = [];

  for (const base of BUILTIN) {
    const over = overrides.get(base.key);
    overrides.delete(base.key);
    if (over?.hidden) continue;
    live.push({
      ...base,
      th: over?.th || base.th,
      en: over?.en || base.en,
      parent: over && over.parent !== undefined && over.parent !== null ? over.parent : base.parent,
      units: base.units.slice(),
    });
  }
  // Whatever is left was added here rather than transcribed.
  for (const extra of [...overrides.values()].sort((a, b) => (a.sort || 0) - (b.sort || 0))) {
    if (extra.hidden) continue;
    live.push({
      key: extra.key,
      th: extra.th || extra.key,
      en: extra.en || extra.th || extra.key,
      parent: extra.parent || undefined,
      units: [],
      added: true,
    });
  }

  const index = new Map(live.map((d) => [d.key, d]));
  for (const unit of [...units].sort((a, b) => (a.sort || 0) - (b.sort || 0))) {
    const owner = index.get(unit.department);
    if (!owner) continue;
    const at = owner.units.findIndex((u) => normaliseUnit(u) === normaliseUnit(unit.name));
    if (unit.hidden) { if (at >= 0) owner.units.splice(at, 1); continue; }
    if (at < 0) owner.units.push(unit.name);
  }

  DEPARTMENTS.length = 0;
  DEPARTMENTS.push(...live);
  DEPARTMENT_KEYS.length = 0;
  DEPARTMENT_KEYS.push(...live.map((d) => d.key));
  byKey.clear();
  for (const d of live) byKey.set(d.key, d);
  rebuildLookup();
}

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
// Units: the sections inside a department
// ---------------------------------------------------------------------------

/**
 * A department's sections, as the org chart names them.
 *
 * อำนวยการ was split into three real departments because each has its own head
 * and the roster sheet files people that way. The sections below never got that
 * treatment — สถานที่ and พัสดุ both sit inside อำนวยการ 2 under one head — so
 * they are a level of filing rather than a level of authority. A task carries
 * one, and it changes nothing about who may see or edit it.
 */
export const unitsOf = (key) => (byKey.get(key)?.units || []).slice();

/**
 * Matched the same forgiving way as everything else read from a spreadsheet:
 * case, spaces, dots, hyphens and the stray zero-width characters that survive
 * a copy-paste are all ignored, because "ยานพาหนะและประสาน ป.อ.พ." and
 * "ยานพาหนะและประสาน ปอ.พ." are the same section written by two people.
 *
 * Returns the canonical spelling, or null when the department has no such
 * section — which the importer reports rather than quietly dropping.
 */
export function matchUnit(departmentKey, text) {
  const want = normaliseUnit(text);
  if (!want) return null;
  for (const unit of unitsOf(departmentKey)) {
    if (normaliseUnit(unit) === want) return unit;
  }
  return null;
}

const normaliseUnit = (value) =>
  String(value ?? '')
    .replace(/[​-‏⁠﻿]/g, '')   // zero-width junk from copy-paste
    .toLowerCase()
    .replace(/[\s_\-.,]/g, '');

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
  // "President" is how the roster writes the president's own team — the
  // director, the deputies, the assistants and the project secretaries all
  // carry it. It means the same teamspace as ประธานโครงการ.
  exec: ['exec', 'executive', 'director', 'projectdirector', 'ประธานโครงการ',
    'president', 'presidents', 'presidentoffice', 'ฝ่ายประธาน', 'ประธาน'],
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

/**
 * The spellings each department answers to.
 *
 * The hand-written aliases first, then every live department's own Thai and
 * English labels — which is what makes a department added on the admin page
 * placeable from the sheet's Department column without anybody adding it here
 * as well. A built-in alias always wins over a label, so renaming a
 * department cannot steal another one's spellings.
 */
function rebuildLookup() {
  LOOKUP.clear();
  for (const d of DEPARTMENTS) {
    for (const label of [d.th, d.en]) {
      const spelling = normalise(label);
      if (spelling) LOOKUP.set(spelling, d.key);
    }
  }
  for (const [key, spellings] of Object.entries(ALIASES)) {
    for (const spelling of spellings) LOOKUP.set(normalise(spelling), key);
  }
}

export const departmentFromLabel = (label) => LOOKUP.get(normalise(label)) || null;

// The chart as transcribed, until a request loads what the admin page changed.
applyOrg();

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
