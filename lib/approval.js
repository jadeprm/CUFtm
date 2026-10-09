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

export const ROLES = ['author', 'unitHead', 'deptHead', 'divisionHead', 'director', 'secretary', 'sender'];

/**
 * The roles that approve, in the order a letter climbs through them. The last
 * step of a chain is never one of these: it is whoever SENDS the finished
 * letter, which is either เลขานุการ or the writer themselves.
 */
export const APPROVAL_ROLES = ['author', 'unitHead', 'deptHead', 'divisionHead', 'director'];
export const SENDING_ROLES = ['secretary', 'sender'];
export const isSendingRole = (role) => SENDING_ROLES.includes(role);

/**
 * Which roles put a signature into the PDF, rather than merely approving.
 *
 * This is the DEFAULT for a step, not a rule about it. Signing and approving
 * are different acts and the committee needs them apart in both directions: a
 * department head may want to approve a letter without their signature showing
 * on it, and the project director's own letter needs his signature even though
 * there is nobody above him to approve it. So a step carries its own `signs`
 * flag, seeded from here and overridable.
 */
export const SIGNING_ROLES = ['author', 'deptHead', 'divisionHead', 'director'];
export const signsPdf = (role) => SIGNING_ROLES.includes(role);

export const ROLE_TH = {
  author: 'ผู้จัดทำ',
  unitHead: 'หัวหน้าหน่วยย่อย',
  deptHead: 'ประธานฝ่าย',
  divisionHead: 'ประธานฝ่ายอำนวยการใหญ่',
  director: 'ประธานโครงการ',
  secretary: 'เลขานุการ',
  sender: 'ผู้ส่งเอกสาร',
};

/**
 * How many ประธานฝ่าย a chain will propose on its own.
 *
 * Several ฝ่าย are run by two people and a letter from that ฝ่าย carries both
 * signatures, so proposing only the senior one meant somebody had to notice
 * the second was missing — and the form had no way to add them. Four is a
 * ceiling against a roster where is_head has been set too freely; anybody
 * proposed can be removed in the form.
 */
const MAX_CO_HEADS = 4;

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

/**
 * A head secretary.
 *
 * Read from the roster rather than kept as a separate list: somebody whose
 * title says หัวหน้าฝ่ายเลขานุการ is one, and the tick box on the admin page is
 * the one place it changes after that. Two things follow from being one — the
 * power to bring more secretaries in, and the power to decide which of them a
 * document lands on.
 */
export const isHeadSecretary = (person) =>
  Boolean(person) && isSecretary(person) && Boolean(person.is_head || person.isHead);

/** Who may add secretaries, and who may move a document between them. */
export const canManageSecretaries = (person) =>
  Boolean(person) && (isHeadSecretary(person) ||
    person.access === 'admin' || person.access === 'coadmin');

/**
 * Which secretary a new document should land on.
 *
 * Two ways, because neither suits every committee. 'department' honours a
 * mapping the head secretaries set — ฝ่ายเนื้อหา always goes to this person —
 * and falls back to spreading the load when a department has nobody assigned.
 * 'random' simply spreads it.
 *
 * Random rather than round-robin on purpose: round-robin needs a counter that
 * every request has to read and write, and the fairness it buys over a term's
 * worth of documents is not worth a shared row that every upload contends on.
 */
export function pickSecretary(candidates, { mode = 'random', byDepartment = {}, department } = {}) {
  const names = candidates.map((p) => (typeof p === 'string' ? p : p.username));
  if (!names.length) return null;

  if (mode === 'department' && department) {
    const wanted = byDepartment[department];
    if (wanted && names.includes(wanted)) return wanted;
  }
  return names[Math.floor(Math.random() * names.length)];
}

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
export function candidatesFor(role, { people, department, unit, uploader, parent = null }) {
  const active = people.filter((p) => p.active !== false && !p.suspended);
  const inDept = (p) =>
    p.department === department || (p.departments || []).includes(department);

  switch (role) {
    // The one role that is never a choice: the author is whoever wrote it.
    case 'author':
      return [uploader];

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

    /**
     * ประธานฝ่ายอำนวยการใหญ่ — the head of the division a ฝ่าย sits under.
     *
     * อำนวยการ 1, 2 and 3 each have their own ประธานฝ่าย and all three sit
     * under ฝ่ายอำนวยการใหญ่, so their letters pass through that chair before
     * they reach ประธานโครงการ.
     *
     * Matched on somebody's HOME department rather than their access list: a
     * head of อำนวยการ 2 usually has access to the whole division, and that
     * must not make them their own next approver.
     */
    case 'divisionHead':
      return active.filter((p) =>
        p.username !== uploader.username &&
        parent && p.department === parent &&
        (p.is_head || p.isHead) && !isDirector(p));

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
export function proposeChain(uploader, {
  people, department, unit, parent = null, secretaryPick = null, sendMode = 'secretary',
} = {}) {
  const rank = isSecretary(uploader) ? 1 : rankOf(uploader);
  const wanted = [];
  const pick = (role) => candidatesFor(role, { people, department, unit, uploader, parent });

  /**
   * The uploader's own signature, when the letter is theirs to sign.
   *
   * The chain only climbs, so somebody at the top of it gets no step of their
   * own — which is correct for APPROVAL (nobody approves their own work) and
   * quite wrong for SIGNING. A letter from the project director still carries
   * the project director's signature; it simply is not waiting on anybody
   * else's permission to do so. This step is his own, and it signs.
   *
   * Only for people whose signature is what a letter from them would carry — a
   * staff member's letter goes out over their head's name, not theirs.
   */
  if (!isSecretary(uploader) && rank >= 2) wanted.push('author');

  // Only a staff member has a unit head above them, and only if the document
  // belongs to a section at all.
  if (rank < 2 && unit) wanted.push('unitHead');

  /**
   * One step per ประธานฝ่าย, not one step for the ฝ่าย.
   *
   * Each co-chair signs in their own box, so each needs a step of their own;
   * `pick` is passed down so the form can swap any of them for someone else.
   */
  if (rank < 2) {
    const heads = pick('deptHead');
    const many = heads.slice(0, MAX_CO_HEADS);
    for (let i = 0; i < Math.max(1, many.length); i += 1) wanted.push({ role: 'deptHead', nth: i });
  }

  /**
   * The division chair, for a ฝ่าย that sits under one.
   *
   * Kept even when the roster offers nobody: a letter from อำนวยการ 2 does go
   * through อำนวยการใหญ่, so the right answer to "the roster cannot tell me
   * who" is to ask the person uploading, not to quietly skip a signature.
   */
  if (parent && parent !== department) wanted.push('divisionHead');

  if (rank < 3) wanted.push('director');
  // Whoever actually posts it. The chain always ends on one of these two.
  wanted.push(sendMode === 'self' ? 'sender' : 'secretary');

  return wanted.map((want, i) => {
    const role = typeof want === 'string' ? want : want.role;
    const nth = typeof want === 'string' ? 0 : want.nth;
    const options = pick(role);

    let chosen;
    if (role === 'sender') chosen = uploader.username;
    else if (role === 'secretary' && secretaryPick) chosen = secretaryPick(options);
    // Co-chairs take one candidate each, in order, so two steps are two people.
    else chosen = options[nth]?.username || null;

    return {
      position: i + 1,
      role,
      username: chosen || null,
      options: role === 'sender' ? [uploader.username] : options.map((p) => p.username),
      signs: role === 'sender' ? false : signsPdf(role),
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
  // The last step is sending, not approving — see canSend.
  if (isSendingRole(pendingStep(steps)?.role)) return false;
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

/**
 * Whether this person may throw the document away entirely.
 *
 * The uploader may, but only while nobody above them has acted: once a head
 * has put their name to something, it is no longer the uploader's alone to
 * erase. Admins may always, because somebody has to be able to clear a mistake.
 */
export function canDeleteDocument(user, doc, steps) {
  if (!user || !doc) return false;
  if (user.access === 'admin' || user.access === 'coadmin') return true;
  if ((doc.created_by || doc.createdBy) !== user.username) return false;
  // The author's own signature is not somebody above them having acted — a
  // head who signs their own letter on upload may still withdraw it.
  return !steps.some((s) =>
    s.role !== 'author' && (s.state === 'approved' || s.state === 'rejected'));
}

/**
 * Who may mark the letter as gone out.
 *
 * Whoever the last step names — เลขานุการ, or the writer when they said they
 * would send it themselves. A head secretary may also step in for a secretary
 * who is away, which is how it worked before this step had a name.
 */
export function canSend(user, doc, steps) {
  if (!user || !doc) return false;
  if (doc.stage === 'sent' || doc.stage === 'rejected') return false;
  const step = pendingStep(steps);
  if (!step || !isSendingRole(step.role)) return false;
  if (step.username === user.username) return true;
  /**
   * Standing in for somebody else is deliberately narrow. เลขานุการ's work is
   * shared, so the head secretaries and the admins can post any letter that is
   * waiting on a secretary. A letter whose writer said they would post it
   * themselves is theirs, and offering a secretary a ส่งแล้ว button on it
   * would invite somebody to close a letter they know nothing about — only
   * the admins can, and only so that one unreachable person cannot strand it.
   */
  if (step.role === 'secretary') return canManageSecretaries(user);
  return user.access === 'admin' || user.access === 'coadmin';
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
