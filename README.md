# Fair Tasks

A task tracker for the fair committee. Thai and English, accounts driven by your Google Sheet, departments from the org chart, a calendar, and reminders.

No Slack. No paid service. Vercel's free plan and its free Postgres are the whole stack.

---

## What was built, against your list

| # | Asked for | Built |
| --- | --- | --- |
| 1 | Thai and English | Full translation, toggle in the header, remembered per person |
| 2 | Admin page managing users | Directory with access badges, department assignment, suspend, password-reset authorisation. Membership and access come from your sheet — see the note below |
| 3 | Set password on first use; reset via admin | First sign-in sets a password. Forgotten ones need an Admin or Co-Admin to authorise, then the person sets their own. Nobody ever types someone else's password |
| 4 | Profile page | Picture, display name, position, role, department. Picture and display name are editable |
| 5 | Tag real users on tasks | Searchable picker with avatars and positions |
| 6 | Optional time on tasks | Date plus optional time |
| 7 | Task detail popup | Title, description, due date and time, people, departments, status, reminder settings |
| 8 | Departments from the org chart | All eleven from your chart, taggable as everyone / heads only / members only, plus "all heads" and "all members" |
| 9 | Main page of only my work | "My tasks" — tasks you're tagged in, directly or through a department |
| 10 | Calendar, 1 / 7 / 30 days | With an "only mine" filter |
| 11 | Reminders, customisable per task | On being added, 7 days before, 1 day before, and on the due date. The creator picks which |

### One thing that works differently from the brief

You chose to keep the Google Sheet as the master for accounts. That is a real trade-off, and it means **adding and removing people happens in the sheet, not in the app** — the admin page shows a Sync button and a link to the sheet instead of an "Add user" form.

The reason is honesty about what would otherwise happen: if the app let you set someone's access to Admin, the next sync would silently reset it to whatever the sheet said. A control that quietly undoes itself is worse than no control. So the app refuses that edit and tells you where to make it.

Everything the sheet does not own — passwords, profile pictures, department assignments, suspensions — is owned by the app and is never touched by a sync. That is tested.

---

## ⚠️ Change your sheet's sharing first

Your sheet is currently **"Anyone with the link can edit."** Since the sheet decides who gets Admin, anyone who ever sees that link can make themselves Admin here.

Open the sheet → **Share** → change "Anyone with the link" from **Editor** to **Viewer**.

Viewer is all the sync needs. People you've explicitly shared it with can still edit.

---

## Setup

### 1. Replace the old files

Delete everything from the previous version — `api/`, `src/`, `index.html`, `app.js`, `manifest.json`, `test/` — then upload this project. The safest route on GitHub is to delete the old files first, since a leftover file that imports a package no longer listed will fail the build.

Upload `api/`, `lib/`, `public/`, `test/` and `package.json`. `package.json` matters this time — it now lists `web-push`, and Vercel installs it during the build.

### 2. Connect the database

Vercel → **Storage** → **Neon** → **Create** → connect it to your project. Vercel sets `DATABASE_URL` itself; there is nothing to copy.

Then **Deployments** → top one → **⋯** → **Redeploy**.

### 3. First sign-in

Open your site. Enter the username exactly as it appears in the sheet — `Jade_Pres`. The app pulls the roster automatically on its first request, recognises you, and asks you to set a password.

Everyone else does the same with their own username.

### 4. Hourly reminders

Reminders need something to poke the app each hour, because Vercel's free plan only allows a once-daily schedule.

1. In Vercel → Settings → Environment Variables, add `CRON_SECRET` with any long random string. Redeploy.
2. Sign up free at [cron-job.org](https://cron-job.org).
3. Create a job that fetches `https://your-site.vercel.app/api/cron?key=YOUR_SECRET` every hour.

Without this, reminders simply never fire — nothing else breaks. The same endpoint also refreshes the roster from the sheet, so adding someone to the sheet brings them in within the hour without anyone pressing Sync.

### 5. Phone notifications

Nothing to configure. The app generates its own signing keys the first time someone switches notifications on, and keeps them in the database — there is no key to paste anywhere, and no Apple or Google developer account involved.

What each person does once:

**Android / computer.** Profile → เปิดแจ้งเตือน → allow. Done.

**iPhone and iPad.** Apple only delivers notifications to a site that has been installed, so there is one extra step:

1. Open the site in **Safari** (Chrome on iPhone cannot do this).
2. Tap **Share** → **Add to Home Screen**.
3. Open the app from the new icon, go to Profile, and tap เปิดแจ้งเตือน.

The Profile page detects an iPhone still in a browser tab and shows these steps instead of a button that could not work.

---

## How access levels behave

| | Admin | Co-Admin | Editor |
| --- | --- | --- | --- |
| Create and edit any task | ✅ | ✅ | ✅ |
| See the directory | ✅ | ✅ | ✅ |
| Authorise password resets, suspend, set departments | ✅ | Editors only | ❌ |
| Act on an Admin or another Co-Admin | ✅ | ❌ | ❌ |
| Sync from the sheet | ✅ | ✅ | ❌ |

Every one of these is enforced on the server and tested, not just hidden in the interface. Hiding a button is not security; refusing the request is.

---

## Run the tests

```bash
npm test          # needs a Postgres; set DATABASE_URL
```

70 checks covering the permission boundaries, the password-reset flow, department tagging, reminder scheduling, and that a sheet sync never destroys passwords, pictures or department assignments.

---

## Files

```
public/index.html     page shell
public/styles.css     all styling, both themes
public/app.js         the whole client
public/i18n.js        every visible string, th + en
api/auth.js           sign in, first password, reset
api/users.js          directory, profile, account management, sheet sync
api/tasks.js          tasks, sub-tasks, attached work, tagging
api/events.js         events — dates with no work attached
api/notifications.js  the bell + urgent acknowledgements
api/push.js           phone notifications and announcements
api/cron.js           hourly reminder run
api/meta.js           department tree
public/manifest.json  makes the site installable on a phone
public/sw.js          service worker: shows pushes, handles taps
lib/db.js             schema and connection
lib/auth.js           password hashing, sessions, permission rules
lib/push.js           web push: keys, encryption, delivery
lib/scope.js          statuses, priorities, who may see what
lib/sheet.js          Google Sheet reader and sync
lib/departments.js    your org chart, in code
test/run.mjs          the test suite
test/sw.mjs           service worker tests
```

---

## Who can change what

| | See it | Change status | Edit / delete | Split into parts | Attach work |
| --- | --- | --- | --- | --- | --- |
| Admin / Co-Admin | every task | yes | yes | yes | yes |
| The person who created it | — | yes | yes | yes | yes |
| Someone tagged in it | yes | yes | no | no | yes |
| Someone else in the department | yes | no | no | no | no |

An Editor whose sheet row says `All` **sees** every task, but that is visibility only — they cannot edit other people's tasks. Editing authority comes from the access level and from owning the task, never from how much you can see.

Sub-tasks work the same way: the owner breaks a task into parts and gives each part to someone, and only that person (or an admin) can tick their own part off.

---

## Importing from a spreadsheet

The "นำเข้าจากไฟล์" button takes a pasted CSV, a Google Sheet link, or a `.csv` file, and it now imports **two different things** — tasks or events. The switch at the top of the dialog picks which, and the column list underneath changes with it. Switching throws away whatever you had previewed, because the same column name means different things on the two sides.

Nothing is ever saved from the preview alone. Every row is shown back to you first with what it parsed, and rows with a problem are greyed out and left behind; only the sound ones are created.

**Tasks** — `title, description, assignees, departments, teamspace, due date, due time, priority, status, parts, links, notify`

Only `title` is required. Two columns hold more than one thing each:

- **parts** — sub-tasks, written `what@who`, separated by semicolons: `ทำหนังสือขอใช้สถานที่@Jade_Pres; ยืนยันผังเวที@Kaew_VP`. The name after `@` is optional; a part with nobody on it can be handed out later. Anyone named only in a sub-task is put on the task as well, so they can see it.
- **links** — finished work, written `label|url`, separated by semicolons: `ผังเวที|https://drive.google.com/file/d/xxx/view; https://example.org/notes`. The label is optional. A Google Drive, Docs, Figma or Canva address is recognised and labelled as such.

Because those two columns use `|` and `,` inside a single item, **semicolons** separate the items — not commas. The people and department columns are the other way round and accept either.

**Events** — `title, description, starts on, starts at, ends on, ends at, all day, place, who, departments, colour, notify`

An event has a start and an end rather than a deadline, and nobody owes anything on it, so there is no status, no priority and no sub-tasks. Leave `who` and `departments` both blank and the event is for the whole committee. An end date before the start is caught in the preview rather than saved.

Both templates download from the dialog itself — the button hands you whichever one matches the switch — and both are in this folder as `fair-tasks-template.csv` and `fair-events-template.csv`. They open in Excel with Thai intact.

---

## Keeping it quick

Two free-tier facts decide how fast the app feels, and one of them you can fix in five minutes.

**The database sleeps.** Neon's free plan shuts the database down after a few minutes with no traffic, and waking it costs a second or two on whichever request arrives first. Point a free pinger at `https://your-site.vercel.app/api/meta?ping=1` every 5 minutes and it stays awake. That endpoint does one trivial query, needs no sign-in, and exposes nothing. Use the same [cron-job.org](https://cron-job.org) account as the hourly reminder job.

**Saving is written to be one conversation, not twenty.** Creating a task used to take about forty separate round trips to the database and sent each phone notification one after another. It is now fifteen, with the notifications going out together — and the app no longer waits for any of it: the task appears in the list the moment you press the button and quietly firms up when the server agrees. If a save ever does fail, the task disappears again and you are told, which is the honest trade for it feeling instant.

---

## Google Calendar

Four separate feeds, on the Profile page. Each one becomes **its own calendar** in Google, which is the only way to give them different colours — Google paints a subscribed calendar in one colour, so committee dates and personal deadlines have to be separate subscriptions.

| Feed | What is in it |
| --- | --- |
| งานของฉัน | Tasks you are tagged in, plus events that concern you |
| งานของฝ่าย | Every task in the departments you have access to |
| กิจกรรมอย่างเดียว | Events only — no deadlines |
| ทั้งหมด | Everything |

To subscribe: copy a link, then in Google Calendar on a **computer** go to Other calendars → **From URL** → paste → Add calendar. Then click the three dots beside the new calendar to rename it and pick a colour. The "Add to Google" button on each row opens that page with the link already filled in.

Two honest limits. Google decides how often it re-reads an external feed — usually a few hours, sometimes up to a day — so a task added this minute will not appear instantly. And the feed is read-only: ticking something off in Google does nothing here. The link is also a secret, since anyone holding it can read those tasks; "ออกลิงก์ใหม่" issues a fresh one and kills the old.

Writing into people's calendars instantly, with colours set by the app, would need a Google Cloud OAuth app. Unverified, Google caps that at 100 users and shows everyone a warning screen, so it was not worth it for a committee this size.

---

## If notifications don't arrive

Open **Profile → แจ้งเตือนเข้ามือถือ** on the device in question. The panel reports what the *server* knows, not what the browser believes — those can disagree, and when they do it is always the server that matters.

- **ปิดอยู่, with an orange "เครื่องนี้ยังไม่ได้ลงทะเบียน" box** — the phone allowed notifications but the registration never reached the server. Tap **ลงทะเบียนเครื่องนี้ใหม่**. If it fails, the error from the server is printed underneath.
- **เปิดอยู่** — tap **ส่งทดสอบ**. If it does not arrive, the exact refusal from Apple or Google is printed: the service name, the HTTP status, and their own wording (`BadJwtToken`, `VapidPkHashMismatch`, and so on). That line is the answer; it is not decoration.
- **A test that says it sent but no banner appears** — iOS does not show a banner while the app is the one you are looking at. Lock the screen or switch to another app, then send another test.
- **On a Mac, switched on but nothing shows** — macOS has its own switch on top of the browser's. System Settings → Notifications → Google Chrome → allow, and pick Banners or Alerts. Check Focus / Do Not Disturb too. Chrome also has to be running: fully quit, nothing arrives. The Profile page shows these steps on a Mac.

---

## Honest limits

**Passwords.** Salted scrypt, HttpOnly cookies, no plaintext anywhere. Sensible for an internal club tool; not bank-grade. There's no two-factor and no rate limiting beyond Vercel's own. Nobody should reuse a password here that protects anything important.

**Phone notifications need the hourly pinger.** Being added to a task, and any announcement, pushes immediately. But the due-date reminders — 7 days, 24 hours, due today — only go out when something calls `/api/cron`, and Vercel's free plan allows that only once a day. Set up a free hourly ping at cron-job.org (see Setup) or deadlines will be reminded about late.

**iPhone needs the Home Screen step.** Apple will not deliver a push to a site sitting in a Safari tab. Everyone on an iPhone has to open the site in Safari, tap Share → Add to Home Screen, then turn notifications on from inside the app. The Profile page walks them through it. Apple's delivery is also less reliable than Android's — roughly 70–85% of pushes arrive, against 90–95% — and iOS sometimes drops a subscription after a long quiet spell, which is why the app silently re-registers every time someone opens it.

**"Urgent" is not an Apple Critical Alert.** Those bypass silent mode and Do Not Disturb, and Apple grants them only to native apps holding an entitlement it issues case by case — a web app cannot have one, whatever it does. What urgent does here is everything the web genuinely allows: high-priority delivery, a notification that stays on screen until dealt with, a stronger vibration, and — the part that actually matters for a committee — the message blocks the app until the person taps รับทราบ, so you can see exactly who has and has not seen it.

**No history or undo.** Deleting a task asks once, then it's gone.

**Free Postgres sleeps.** The first request after a quiet spell takes a few seconds, unless you set up the 5-minute ping above.

**Anyone with a username and no password set can claim it.** The first person to reach a never-used account sets its password. With an 18-person internal roster that's usually right, but tell people to sign in early rather than leaving accounts unclaimed.

**Department heads were guessed** from the ตำแหน่ง column — anyone whose title contains ประธานฝ่าย is marked a head. Check the Users page and untick anyone that's wrong; your choices there survive every sync.
