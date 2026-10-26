import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { sendMail, mailConfigured } from './mail.js';
import { hashPassword, passwordProblem, setDepartments } from './auth.js';
import { USERNAME_SHAPE } from './rename.js';
import { isDepartment, matchUnit, departmentByKey } from './departments.js';

/**
 * Proving an email address, and joining without an admin typing you in.
 *
 * Codes are six digits, valid ten minutes, five tries each, and only a salted
 * hash is stored. Asking for a new one is limited per person and per address.
 */

const TTL_MIN = 10;
const MAX_TRIES = 5;
const COOLDOWN_S = 45;
const PER_HOUR = 6;
const MAX_OPEN_REGISTRATIONS = 300;

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const cleanEmail = (v) => String(v ?? '').trim().toLowerCase().slice(0, 200);
const newId = (p) => `${p}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
const digest = (salt, code) => createHash('sha256').update(`${salt}:${code}`).digest('hex');

/** People who may approve a newcomer: editors and above. */
export const APPROVER_ACCESS = ['editor', 'coadmin', 'admin'];

export async function issueCode(sql, { purpose, subject, email }) {
  const [recent] = await sql`
    SELECT max(created_at) AS last,
           count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour
    FROM email_otps WHERE purpose = ${purpose} AND (subject = ${subject} OR lower(email) = ${email})`;
  if (recent?.last && Date.now() - new Date(recent.last).getTime() < COOLDOWN_S * 1000) {
    return { ok: false, error: 'CODE_TOO_SOON', wait: COOLDOWN_S };
  }
  if ((recent?.hour || 0) >= PER_HOUR) return { ok: false, error: 'CODE_LIMIT' };

  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const salt = randomBytes(8).toString('hex');
  const id = newId('otp');

  /**
   * The row is written BEFORE the mail goes out, and the cooldown is checked
   * again by the insert itself. Two clicks (or two tabs) landing together both
   * pass the check above; this is what makes only one of them send.
   */
  const slot = Math.floor(Date.now() / (COOLDOWN_S * 1000));
  const claimed = await sql`
    INSERT INTO email_otps (id, purpose, subject, email, code_hash, salt, expires_at, slot)
    VALUES (${id}, ${purpose}, ${subject}, ${email}, ${digest(salt, code)}, ${salt},
            now() + (${TTL_MIN} || ' minutes')::interval, ${slot})
    ON CONFLICT (purpose, subject, slot) DO NOTHING
    RETURNING id`;
  if (!claimed.length) return { ok: false, error: 'CODE_TOO_SOON', wait: COOLDOWN_S };

  const sent = await sendMail({
    to: email,
    subject: 'รหัสยืนยันอีเมล CUFTM / CUFTM verification code',
    text: `รหัสยืนยันของคุณคือ ${code}\nใช้ได้ ${TTL_MIN} นาที ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร\n\n` +
          `Your verification code is ${code}\nIt works for ${TTL_MIN} minutes. If you did not ask for it, ignore this email.\n`,
  });
  if (!sent.ok) {
    await sql`DELETE FROM email_otps WHERE id = ${id}`;
    return { ok: false, error: sent.error };
  }
  return { ok: true };
}

/** Checks the newest unused code for this subject. */
export async function checkCode(sql, { purpose, subject, email, code }) {
  const [row] = await sql`
    SELECT * FROM email_otps
    WHERE purpose = ${purpose} AND subject = ${subject} AND lower(email) = ${email} AND used_at IS NULL
    ORDER BY created_at DESC LIMIT 1`;
  if (!row || new Date(row.expires_at) < new Date()) return { ok: false, error: 'CODE_EXPIRED' };
  if (row.attempts >= MAX_TRIES) return { ok: false, error: 'CODE_LOCKED' };
  await sql`UPDATE email_otps SET attempts = attempts + 1 WHERE id = ${row.id}`;
  const want = Buffer.from(row.code_hash, 'hex');
  const got = Buffer.from(digest(row.salt, String(code ?? '').trim()), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, error: 'CODE_WRONG' };
  await sql`UPDATE email_otps SET used_at = now() WHERE id = ${row.id}`;
  return { ok: true };
}

/** Binds a verified email to an existing account, if nobody else holds it. */
export async function bindEmail(sql, username, email) {
  const [taken] = await sql`
    SELECT username FROM users
    WHERE lower(email) = ${email} AND email_verified_at IS NOT NULL AND username <> ${username}`;
  if (taken) return { ok: false, error: 'EMAIL_TAKEN' };
  await sql`UPDATE users SET email = ${email}, email_verified_at = now(), updated_at = now()
            WHERE username = ${username}`;
  return { ok: true };
}

const ROLE_SHAPE = /เลขา|ผู้ช่วย|secretar|assistant|deputy/i;

/**
 * Who answers for a ฝ่าย, found from the roster rather than typed in: the
 * editors-and-above whose home is that department and who are either its head
 * or its secretary / assistant by ตำแหน่ง. Admins and co-admins can always
 * decide too, so a department with nobody listed is never stuck.
 */
export async function approversFor(sql, department) {
  const rows = await sql`
    SELECT username, display_name, nickname, position, is_head FROM users
    WHERE active = true AND suspended = false AND access = ANY(${APPROVER_ACCESS})
      AND department = ${department}
    ORDER BY is_head DESC, display_name`;
  return rows.filter((r) => r.is_head || ROLE_SHAPE.test(r.position || ''));
}

export async function startRegistration(sql, body) {
  const username = String(body.username ?? '').trim();
  if (!USERNAME_SHAPE.test(username)) return { status: 400, error: 'BAD_USERNAME' };
  const problem = passwordProblem(body.password);
  if (problem) return { status: 400, error: problem };
  const email = cleanEmail(body.email);
  if (!EMAIL_SHAPE.test(email)) return { status: 400, error: 'BAD_EMAIL' };
  const nickname = String(body.nickname ?? '').trim().slice(0, 60);
  const fullName = String(body.fullName ?? '').trim().slice(0, 120);
  const position = String(body.position ?? '').trim().slice(0, 120);
  if (!nickname || !fullName || !position) return { status: 400, error: 'MISSING_FIELDS' };
  const department = String(body.department ?? '').trim();
  if (!isDepartment(department)) return { status: 400, error: 'BAD_DEPARTMENT' };
  const unit = body.unit ? matchUnit(department, body.unit) : null;
  if (body.unit && !unit) return { status: 400, error: 'UNIT_NOT_IN_DEPARTMENT' };

  const [clash] = await sql`
    SELECT 1 AS x FROM users WHERE lower(username) = ${username.toLowerCase()}
    UNION ALL SELECT 1 FROM registrations
      WHERE lower(username) = ${username.toLowerCase()} AND status IN ('unverified', 'pending')`;
  if (clash) return { status: 409, error: 'USERNAME_TAKEN' };
  const [mailClash] = await sql`
    SELECT 1 AS x FROM users WHERE lower(email) = ${email} AND email_verified_at IS NOT NULL`;
  if (mailClash) return { status: 409, error: 'EMAIL_TAKEN' };

  const [{ open }] = await sql`SELECT count(*)::int AS open FROM registrations WHERE status IN ('unverified', 'pending')`;
  if (open >= MAX_OPEN_REGISTRATIONS) return { status: 429, error: 'REGISTRATION_BUSY' };

  const [{ users }] = await sql`SELECT count(*)::int AS users FROM users`;
  const firstRun = users === 0;

  // Found from the chart, not typed: the head, secretary and assistant of that ฝ่าย.
  const approvers = firstRun ? [] : (await approversFor(sql, department)).map((r) => r.username);

  const { hash, salt } = await hashPassword(String(body.password));
  const id = newId('reg');
  // With no mail provider and no members at all, the very first person has no
  // other way in — see api/auth.js. Everyone after them verifies by email.
  if (firstRun && !mailConfigured()) {
    await sql`INSERT INTO registrations (id, username, nickname, full_name, position, department, unit,
                email, password_hash, password_salt, approvers, status)
              VALUES (${id}, ${username}, ${nickname}, ${fullName}, ${position}, ${department}, ${unit},
                ${email}, ${hash}, ${salt}, ${approvers}, 'pending')`;
    const made = await approveRegistration(sql, id, { by: null, access: 'admin', verified: false });
    return { status: 201, ok: true, firstRun: true, ...made };
  }

  const sent = await issueCode(sql, { purpose: 'register', subject: id, email });
  if (!sent.ok) {
    return { status: sent.error === 'MAIL_NOT_CONFIGURED' ? 503 : 429, error: sent.error, wait: sent.wait };
  }
  await sql`INSERT INTO registrations (id, username, nickname, full_name, position, department, unit,
              email, password_hash, password_salt, approvers, status)
            VALUES (${id}, ${username}, ${nickname}, ${fullName}, ${position}, ${department}, ${unit},
              ${email}, ${hash}, ${salt}, ${approvers}, 'unverified')`;
  return { status: 201, ok: true, id, firstRun };
}

export async function resendRegistrationCode(sql, id) {
  const [reg] = await sql`SELECT * FROM registrations WHERE id = ${id} AND status = 'unverified'`;
  if (!reg) return { status: 404, error: 'NO_SUCH_REGISTRATION' };
  const sent = await issueCode(sql, { purpose: 'register', subject: id, email: reg.email });
  if (!sent.ok) return { status: sent.error === 'MAIL_NOT_CONFIGURED' ? 503 : 429, error: sent.error, wait: sent.wait };
  return { status: 200, ok: true };
}

export async function verifyRegistration(sql, id, code) {
  const [reg] = await sql`SELECT * FROM registrations WHERE id = ${id} AND status = 'unverified'`;
  if (!reg) return { status: 404, error: 'NO_SUCH_REGISTRATION' };
  const res = await checkCode(sql, { purpose: 'register', subject: id, email: reg.email, code });
  if (!res.ok) return { status: 400, error: res.error };
  await sql`UPDATE registrations SET status = 'pending' WHERE id = ${id}`;

  // The first person into an empty system has nobody to ask: they become the admin.
  const [{ users }] = await sql`SELECT count(*)::int AS users FROM users`;
  if (users === 0) {
    const made = await approveRegistration(sql, id, { by: null, access: 'admin', verified: true });
    return { status: 200, ok: true, firstRun: true, ...made };
  }

  // Tell the approvers, in the bell. Everyone who can decide is told.
  const admins = await sql`
    SELECT username FROM users WHERE active = true AND suspended = false AND access IN ('admin', 'coadmin')`;
  const targets = [...new Set([...reg.approvers, ...admins.map((r) => r.username)])];
  if (targets.length) {
    const title = `ขอสมัครเข้าระบบ: ${reg.nickname} (${reg.username})`;
    const body = `${reg.full_name} · ${reg.position} · ${departmentByKey(reg.department)?.th || reg.department}`
      + ` — เปิดหน้า "คำขอสมัคร" เพื่ออนุมัติ`;
    await sql`
      INSERT INTO notifications (id, username, task_id, kind, title, body)
      SELECT 'n_' || ${id} || '_' || u, u, NULL, 'announce', ${title}, ${body}
      FROM unnest(${targets}::text[]) AS t(u)
      ON CONFLICT DO NOTHING`;
  }
  return { status: 200, ok: true };
}

/** Creates the account from a registration. The email counts as verified. */
export async function approveRegistration(sql, id, { by, access = 'inner', verified = true }) {
  const [reg] = await sql`SELECT * FROM registrations WHERE id = ${id} AND status = 'pending'`;
  if (!reg) return { error: 'NO_SUCH_REGISTRATION' };
  const [clash] = await sql`SELECT 1 AS x FROM users WHERE lower(username) = ${reg.username.toLowerCase()}`;
  if (clash) return { error: 'USERNAME_TAKEN' };

  const name = reg.nickname || reg.full_name;
  await sql`
    INSERT INTO users (username, nickname, sheet_name, display_name, full_name, position, access,
                       department, all_departments, unit, is_head, active, off_sheet,
                       access_pinned, depts_pinned, password_hash, password_salt,
                       email, email_verified_at)
    VALUES (${reg.username}, ${reg.nickname}, ${name}, ${name}, ${reg.full_name}, ${reg.position}, ${access},
            ${reg.department}, ${access === 'admin'}, ${reg.unit}, false, true, true,
            true, true, ${reg.password_hash}, ${reg.password_salt},
            ${reg.email}, ${verified ? new Date().toISOString() : null})`;
  if (access !== 'admin') await setDepartments(sql, reg.username, [reg.department]);
  await sql`UPDATE registrations SET status = 'approved', decided_by = ${by}, decided_at = now(),
            password_hash = '', password_salt = '' WHERE id = ${id}`;
  if (by) {
    await sql`UPDATE notifications SET read_at = now() WHERE id LIKE ${'n\\_' + id + '\\_%'}`;
    await sendMail({
      to: reg.email,
      subject: 'บัญชี CUFTM ของคุณได้รับอนุมัติแล้ว / Your CUFTM account is approved',
      text: `บัญชี ${reg.username} ได้รับอนุมัติแล้ว เข้าสู่ระบบได้ที่ task.chulafair.com\n\n` +
            `Your account ${reg.username} is approved. Sign in at task.chulafair.com\n`,
    });
  }
  return { ok: true, username: reg.username };
}

export async function rejectRegistration(sql, id, { by, reason }) {
  const [reg] = await sql`SELECT * FROM registrations WHERE id = ${id} AND status = 'pending'`;
  if (!reg) return { error: 'NO_SUCH_REGISTRATION' };
  await sql`UPDATE registrations SET status = 'rejected', decided_by = ${by}, decided_at = now(),
            reason = ${String(reason ?? '').slice(0, 300)}, password_hash = '', password_salt = ''
            WHERE id = ${id}`;
  await sql`UPDATE notifications SET read_at = now() WHERE id LIKE ${'n\\_' + id + '\\_%'}`;
  await sendMail({
    to: reg.email,
    subject: 'คำขอสมัคร CUFTM ไม่ได้รับการอนุมัติ / CUFTM request not approved',
    text: `คำขอสมัครของ ${reg.username} ไม่ได้รับการอนุมัติ${reason ? `: ${reason}` : ''}\n` +
          `Your request for ${reg.username} was not approved${reason ? `: ${reason}` : ''}\n`,
  });
  return { ok: true };
}
