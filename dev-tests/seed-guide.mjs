/**
 * Demo data for the user-guide screenshots.
 *
 * The dev database is what the suites left behind — "งานที่เห็นได้แต่ลบไม่ได้",
 * "No parts or links", half-finished letters. None of that can go on a
 * projector in front of the committee, so this clears the work tables and
 * puts one plausible week in their place, for the three people the guide
 * follows: a member (ปลอย), a unit lead (นิว) and a ประธานฝ่าย (กุ๊งกิ๊ง).
 *
 *   node dev-tests/seed-guide.mjs
 *
 * Development only. It deletes every task, event, meeting and document, so
 * run the API suite afterwards if you need its fixtures back.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@127.0.0.1:5432/fairv2';
await import('./neon-local.mjs');
const { getSql } = await import('../lib/db.js');
const { sql, ready } = getSql(); await ready;

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
const add = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

await sql`DELETE FROM documents`.catch(() => {});
await sql`DELETE FROM meetings`.catch(() => {});
await sql`DELETE FROM events`.catch(() => {});
await sql`DELETE FROM tasks`.catch(() => {});
await sql`DELETE FROM notifications`.catch(() => {});

// ---- the week ------------------------------------------------------------
let n = 0;
const task = async (title, note, status, prio, due, people, extra = {}) => {
  n += 1;
  const id = 't_gd' + n;
  await sql`INSERT INTO tasks (id, code, title, description, status, priority, start_date, due_date,
                               created_by, department, unit)
            VALUES (${id}, ${'T' + String(100 + n)}, ${title}, ${note}, ${status}, ${prio},
                    ${extra.start ?? add(today, -3)}, ${due}, ${extra.by || 'Kungking_HeadCon'},
                    'content', ${extra.unit || null})`;
  for (const u of people) {
    await sql`INSERT INTO task_people (task_id, username, via) VALUES (${id}, ${u}, 'named') ON CONFLICT DO NOTHING`;
  }
  return id;
};

await task('ทำสคริปต์พิธีกรเวทีกลาง', 'ร่างสคริปต์เปิดงานและช่วงแนะนำการแสดง ส่งให้หัวหน้าหน่วยตรวจก่อนวันซ้อม',
  'doing', 'high', add(today, 2), ['Ploy_StaffCon'], { unit: 'Stage' });
await task('รวบรวมรายชื่อวงดนตรีที่ตอบรับ', 'ใส่ชื่อวง ผู้ติดต่อ และเวลาที่สะดวก ลงในชีตของฝ่าย',
  'todo', 'highest', add(today, 1), ['Ploy_StaffCon', 'Fah_StaffCon'], { unit: 'Stage' });
await task('ออกแบบผังเวทีกลาง', 'ขนาดเวที จุดวางลำโพง และทางขึ้นลงของนักแสดง',
  'review', 'medium', add(today, 4), ['New_UnitCon', 'Ploy_StaffCon'], { unit: 'Stage' });
await task('จองระบบเสียงและไฟ', 'ขอใบเสนอราคาสามเจ้า แล้วเทียบราคาก่อนเสนอประธานฝ่าย',
  'todo', 'high', add(today, 6), ['New_UnitCon'], { unit: 'Stage' });
await task('สรุปคิวการแสดงวันแรก', 'เรียงลำดับการแสดงพร้อมเวลาเข้าออกเวที',
  'todo', 'medium', add(today, 9), ['Fah_StaffCon'], { unit: 'Stage' });
await task('ติดต่อขอยืมเต็นท์จากคณะ', 'ทำหนังสือขอยืมและนัดวันรับของ',
  'doing', 'medium', add(today, 5), ['Fah_StaffCon']);
await task('ทำป้ายบอกทางหน้างาน', 'ออกแบบป้ายและส่งโรงพิมพ์',
  'done', 'low', add(today, -2), ['Ploy_StaffCon'], { start: add(today, -10) });
await task('เก็บภาพบรรยากาศวันซ้อม', 'ถ่ายภาพไว้ใช้ทำสรุปหลังงาน',
  'todo', 'low', add(today, 14), ['Ploy_StaffCon']);
await task('ตรวจความพร้อมเวทีก่อนวันงาน', 'เดินเช็กตามรายการที่หน่วยทำไว้',
  'todo', 'high', add(today, 16), ['New_UnitCon', 'Fah_StaffCon'], { unit: 'Stage' });

// ---- two things on the calendar -----------------------------------------
const ev = async (i, title, place, on, at, to, people) => {
  const id = 'ev_gd' + i;
  await sql`INSERT INTO events (id, code, title, place, starts_on, starts_at, ends_at, all_day, created_by, department)
            VALUES (${id}, ${'E' + String(100 + i)}, ${title}, ${place}, ${on}::date, ${at}, ${to}, false, 'Kungking_HeadCon', 'content')`;
  for (const u of people) await sql`INSERT INTO event_people (event_id, username) VALUES (${id}, ${u}) ON CONFLICT DO NOTHING`;
};
await ev(1, 'ซ้อมใหญ่รอบสุดท้าย', 'หอประชุมจุฬาฯ', add(today, 8), '14:00', '18:00',
  ['Ploy_StaffCon', 'Fah_StaffCon', 'New_UnitCon', 'Kungking_HeadCon']);
await ev(2, 'เดินสำรวจพื้นที่จัดงาน', 'ลานพระบรมรูปสองรัชกาล', add(today, 3), '09:00', '11:00',
  ['New_UnitCon', 'Kungking_HeadCon']);

// ---- a meeting that is waiting for replies and agenda items -------------
const mkMeeting = async (i, title, on, at, to, place, people, agenda) => {
  const id = 'mt_gd' + i;
  await sql`INSERT INTO meetings (id, code, title, meets_on, meets_at, ends_at, place, created_by, department, status)
            VALUES (${id}, ${'M' + String(100 + i)}, ${title}, ${on}::date, ${at}, ${to}, ${place},
                    'Kungking_HeadCon', 'content', 'planned')`;
  for (const [u, reply] of people) {
    await sql`INSERT INTO meeting_people (meeting_id, username, reply) VALUES (${id}, ${u}, ${reply}) ON CONFLICT DO NOTHING`;
  }
  let k = 0;
  for (const [t, who] of agenda) {
    k += 1;
    await sql`INSERT INTO meeting_agenda (id, meeting_id, slot, title, kind, proposed_by, minutes)
              VALUES (${'ag_gd' + i + '_' + k}, ${id}, ${k}, ${t}, 'item', ${who}, 10)`;
  }
};
await mkMeeting(1, 'ประชุมฝ่ายเนื้อหา ครั้งที่ 5/2569', add(today, 2), '17:00', '18:30', 'ห้อง 201 อาคารจุลจักรพงษ์',
  [['Kungking_HeadCon', 'yes'], ['New_UnitCon', 'yes'], ['Ploy_StaffCon', 'none'], ['Fah_StaffCon', 'none']],
  [['ความคืบหน้าคิวการแสดง', 'New_UnitCon'], ['งบประมาณระบบเสียง', 'Kungking_HeadCon']]);
await mkMeeting(2, 'ประชุมคณะกรรมการโครงการ ครั้งที่ 4/2569', add(today, 12), '18:00', '20:00', 'ห้องประชุมชั้น 2',
  [['Kungking_HeadCon', 'yes'], ['Jade_Pres', 'yes'], ['Sunday_Sec', 'yes']], []);

console.log('seeded for', today);
process.exit(0);
