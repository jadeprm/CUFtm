/**
 * Who has to sign a document, and in what order.
 *
 * The committee's chain is staff → unit head → department head → project
 * director → secretary. Two rules shape everything else.
 *
 * A document only ever climbs. It enters the chain immediately ABOVE whoever
 * uploaded it, so a department head's letter does not come back to them for
 * their own approval, and a letter from the project director goes straight to
 * the secretary. Nobody approves their own work.
 *
 * And the chain is FROZEN when the document is submitted. Who had to sign is a
 * fact about that document on that day; if somebody changes job in November,
 * the letter they signed in September must still say they signed it.
 */

export const ROLES = ['unitHead', 'deptHead', 'director', 'secretary'];

/** Only these two levels put a signature into the PDF. The rest just approve. */
export const SIGNING_ROLES = ['deptHead', 'director'];
export const signsPdf = (role) => SIGNING_ROLES.includes(role);

export const ROLE_TH = {
  unitHead: 'หัวหน้าหน่วยย่อย',
  deptHead: 'ประธานฝ่าย',
  director: 'ประธานโครงการ',
  secretary: 'เลขานุการ',
};

/**
 * How high somebody sits, which is where a document from them starts.
 *
 * Secretaries are deliberately not on this ladder. They watch every document
 * and send the finished ones, but they do not approve, so ranking them among
 * the approvers would be meaningless. Their own documents are handled as staff
 * documents by the caller.
 */
export function rankOf(person) {
  if (!person) return 0;
  if (isDirector(person)) return 3;
  if (person.is_head || person.isHead) return 2;
  return 1;                      // staff, and unit heads the roster cannot see
}

export const isDirector = (person) =>
  Boolean(person) &&
  ((person.department === 'exec' && (person.is_head || person.isHead)) ||
    person.access === 'admin');

export const isSecretary = (person) =>
  Boolean(person) && (person.department === 'secretariat' ||
    (person.departments || []).includes('secretariat'));

/**
 * The people who could fill each role, best first.
 *
 * Returned as candidate LISTS rather than single names because the roster
 * cannot always tell: a department may have two heads, and it has no idea at
 * all which member runs a section. The uploader confirms the actual people, so
 * a wrong guess here costs a tap rather than sending a letter to the wrong
 * person.
 */
export function candidatesFor(role, { people, department, unit, uploader }) {
  const active = people.filter((p) => p.active !== false && !p.suspended);
  const inDept = (p) =>
    p.department === department || (p.departments || []).includes(department);

  switch (role) {
    case 'unitHead':
      // Someone in the same section whose title says they lead it, and who is
      // not already the department head — that is the next step up, not this one.
      return active.filter((p) =>
        p.username !== uploader.username &&
        inDept(p) && unit && p.unit === unit &&
        !(p.is_head || p.isHead) &&
        /หัวหน้า|ประธาน|head|lead/i.test(p.position || ''));

    case 'deptHead':
      return active.filter((p) =>
        p.username !== uploader.username &&
        inDept(p) && (p.is_head || p.isHead) && !isDirector(p));

    case 'director':
      return active
        .filter((p) => p.username !== uploader.username && isDirector(p))
        // The project director proper before the deputies.
        .sort((a, b) => scoreDirector(b) - scoreDirector(a));

    case 'secretary': {
      const secs = active.filter((p) => isSecretary(p));
      // A committee with no secretariat member yet must still be able to
      // finish a document, so the admins stand in rather than the chain
      // ending at a step nobody can ever take.
      return secs.length
        ? secs
        : active.filter((p) => p.access === 'admin' || p.access === 'coadmin');
    }

    default:
      return [];
  }
}

const scoreDirector = (p) => {
  const title = String(p.position || '');
  if (/^ประธานโครงการ/.test(title)) return 3;
  if (/รองประธานโครงการ/.test(title)) return 2;
  return 1;
};

/**
 * The chain a document from this person should follow.
 *
 * Every role above the uploader's own rank, in order, with the best candidate
 * pre-selected. A role with nobody to fill it is returned with an empty
 * candidate list rather than being dropped silently — the upload page shows it
 * as needing a choice, because a missing approver is something a person has to
 * decide about, not something software should quietly skip.
 */
export function proposeChain(uploader, { people, department, unit }) {
  const rank = isSecretary(uploader) ? 1 : rankOf(uploader);
  const wanted = [];

  // Only a staff member has a unit head above them, and only if the document
  // belongs to a section at all.
  if (rank < 2 && unit) wanted.push('unitHead');
  if (rank < 2) wanted.push('deptHead');
  if (rank < 3) wanted.push('director');
  wanted.push('secretary');

  return wanted.map((role, i) => {
    const options = candidatesFor(role, { people, department, unit, uploader });
    return {
      position: i + 1,
      role,
      username: options[0]?.username || null,
      options: options.map((p) => p.username),
      signs: signsPdf(role),
    };
  }).filter((step) => step.role !== 'unitHead' || step.options.length);
}

/** The step a document is waiting on, or null when nothing is outstanding. */
export const pendingStep = (steps) =>
  [...steps].sort((a, b) => a.position - b.position)
    .find((s) => s.state === 'waiting') || null;

/**
 * Whether this person may act on the document right now.
 *
 * Deliberately strict about order: being named later in the chain is not
 * permission to sign early, because a director signing before the department
 * head would defeat the point of having a chain at all.
 */
export function canAct(user, doc, steps) {
  if (!user || !doc) return false;
  if (doc.stage !== 'approving') return false;
  const step = pendingStep(steps);
  return Boolean(step && step.username === user.username);
}

/**
 * Who may put a corrected file in place of the one under review.
 *
 * Anyone above the uploader in this document's own chain, so a head who spots
 * a typo can fix it rather than bouncing the whole thing back to the start.
 * The person who uploaded it may also replace it while nobody has signed yet.
 */
export function canReplaceFile(user, doc, steps) {
  if (!user || doc.stage !== 'approving') return false;
  const named = steps.some((s) => s.username === user.username);
  if (named) return true;
  if (doc.created_by === user.username || doc.createdBy === user.username) {
    return !steps.some((s) => s.state === 'approved');
  }
  return false;
}

/** Secretaries watch everything; everyone else sees what concerns them. */
export function canSeeDocument(user, doc, steps) {
  if (!user) return false;
  if (isSecretary(user) || user.access === 'admin' || user.access === 'coadmin') return true;
  if ((doc.created_by || doc.createdBy) === user.username) return true;
  return steps.some((s) => s.username === user.username);
}

/**
 * The progress bar, as data.
 *
 * One entry per step plus the two ends, each carrying when it happened and who
 * did it. Built here rather than in the interface so the chat, the digest and
 * the page all describe a document's position the same way.
 */
export function progressOf(doc, steps) {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const out = [{
    key: 'submitted',
    label: 'ส่งเรื่อง',
    state: 'done',
    at: doc.created_at || doc.createdAt,
    username: doc.created_by || doc.createdBy,
  }];

  for (const step of ordered) {
    out.push({
      key: `step-${step.position}`,
      label: ROLE_TH[step.role] || step.role,
      role: step.role,
      state: step.state,
      at: step.acted_at || step.actedAt || null,
      username: step.username,
      comment: step.comment || '',
      signs: signsPdf(step.role),
    });
  }

  out.push({
    key: 'sent',
    label: 'ส่งให้ผู้รับ',
    state: doc.sent_at ? 'done' : (doc.stage === 'rejected' ? 'stopped' : 'waiting'),
    at: doc.sent_at || null,
    username: doc.sent_by || null,
  });
  return out;
}

/** How far along, as a fraction, for the bar itself. */
export function progressFraction(doc, steps) {
  if (doc.stage === 'rejected') return 0;
  const total = steps.length + 1;               // the steps, plus sending
  const done = steps.filter((s) => s.state === 'approved').length + (doc.sent_at ? 1 : 0);
  return total ? done / total : 0;
}
