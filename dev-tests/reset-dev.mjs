import pg from 'pg';
const c = new pg.Client({ connectionString: 'postgres://postgres:pw@127.0.0.1:5432/fairv2' });
await c.connect();
for (const t of ['doc_events','doc_steps','doc_files','documents','secretary_prefs',
                 'reminders_sent','notifications','task_departments','task_people','task_links','task_parts','tasks',
                 'event_people','event_departments','events','push_subscriptions','announcements',
                 'line_links','line_codes','line_recent','user_departments','sessions','meta','users']) {
  try { await c.query(`DELETE FROM ${t}`); } catch (e) {}
}
await c.end();
console.log('reset');
