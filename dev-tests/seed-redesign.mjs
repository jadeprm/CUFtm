// Seeds the dev database with things the redesign draws: a space, tasks with
// start dates, finished tasks spread over weeks, an appointment, office hours.
import { getSql } from '../lib/db.js';
process.env.DATABASE_URL='postgres://postgres:pw@127.0.0.1:5432/fairv2'; const { sql, ready } = getSql(); await ready;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
const add = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
await sql`DELETE FROM spaces WHERE id = 'sp_demo'`;
await sql`INSERT INTO spaces (id, name, description, colour, icon, created_by) VALUES ('sp_demo', 'ทีมเวทีกลาง', 'เตรียมเวทีกลางและคิวการแสดงทั้งหมด', 'teal', 'S', 'Jade_Pres')`;
await sql`INSERT INTO space_members (space_id, username, role) VALUES ('sp_demo','Jade_Pres','owner'),('sp_demo','Kungking_HeadCon','member') ON CONFLICT DO NOTHING`;
await sql`DELETE FROM tasks WHERE id LIKE 't_demo%'`;
const mk = async (i, title, status, start, due, prio, space, doneAgo) => {
  await sql`INSERT INTO tasks (id, code, title, status, priority, start_date, due_date, created_by, department, space_id, done_at)
            VALUES (${'t_demo' + i}, ${'D' + String(i).padStart(3, '0')}, ${title}, ${status}, ${prio}, ${start}, ${due}, 'Jade_Pres', 'content', ${space},
                    ${doneAgo === null ? null : new Date(Date.now() - doneAgo * 86400000)})`;
  await sql`INSERT INTO task_people (task_id, username, via) VALUES (${'t_demo' + i}, 'Jade_Pres', 'named') ON CONFLICT DO NOTHING`;
  if (i % 2) await sql`INSERT INTO task_people (task_id, username, via) VALUES (${'t_demo' + i}, 'Kungking_HeadCon', 'named') ON CONFLICT DO NOTHING`;
};
await mk(1, 'ออกแบบผังเวที', 'doing', add(today, -4), add(today, 6), 'high', 'sp_demo', null);
await mk(2, 'จองระบบเสียง', 'review', add(today, -2), add(today, 3), 'highest', 'sp_demo', null);
await mk(3, 'คิวการแสดงวันแรก', 'todo', add(today, 2), add(today, 12), 'medium', 'sp_demo', null);
await mk(4, 'ซ้อมใหญ่', 'todo', null, add(today, 18), 'medium', 'sp_demo', null);
await mk(5, 'ทำป้ายบอกทาง', 'feedback', add(today, -6), add(today, 1), 'low', null, null);
for (let k = 0; k < 14; k += 1) {
  const ago = [1, 2, 2, 4, 6, 8, 9, 13, 15, 20, 23, 30, 37, 44][k];
  await mk(10 + k, 'งานที่เสร็จแล้ว ' + (k + 1), 'done', add(today, -ago - 3), add(today, -ago + (k % 3 === 0 ? -1 : 1)), 'medium', k < 4 ? 'sp_demo' : null, ago);
}
await sql`DELETE FROM appointments WHERE id LIKE 'ap_demo%'`;
await sql`INSERT INTO appointments (id, owner, kind, title, starts_at, ends_at, created_by) VALUES
  ('ap_demo1', 'Jade_Pres', 'focus', 'เขียนแผนงานเวที', ${today + 'T09:30:00+07:00'}, ${today + 'T11:30:00+07:00'}, 'Jade_Pres'),
  ('ap_demo2', 'Jade_Pres', 'personal', 'คุยอาจารย์ที่ปรึกษา', ${add(today, 1) + 'T13:00:00+07:00'}, ${add(today, 1) + 'T14:00:00+07:00'}, 'Jade_Pres')`;
await sql`DELETE FROM office_hours WHERE owner = 'Jade_Pres'`;
for (const d of ['tue', 'thu']) await sql`INSERT INTO office_hours (id, owner, weekday, from_at, to_at, slot_min, place) VALUES (${'oh_demo' + d}, 'Jade_Pres', ${d}, '15:00', '17:00', 30, 'ห้องชมรม')`;
await sql`DELETE FROM office_hours WHERE owner = 'Kungking_HeadCon'`;
await sql`INSERT INTO office_hours (id, owner, weekday, from_at, to_at, slot_min, place) VALUES ('oh_demok', 'Kungking_HeadCon', 'mon', '10:00', '12:00', 30, 'Zoom')`;
console.log('seeded'); process.exit(0);
