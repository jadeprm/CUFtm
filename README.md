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

Upload `api/`, `lib/`, `public/`, `test/` and `package.json`.

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
api/tasks.js          task CRUD, people and department tagging
api/notifications.js  the bell
api/cron.js           hourly reminder run
api/meta.js           department tree
lib/db.js             schema and connection
lib/auth.js           password hashing, sessions, permission rules
lib/sheet.js          Google Sheet reader and sync
lib/departments.js    your org chart, in code
test/run.mjs          the test suite
```

---

## Honest limits

**Passwords.** Salted scrypt, HttpOnly cookies, no plaintext anywhere. Sensible for an internal club tool; not bank-grade. There's no two-factor and no rate limiting beyond Vercel's own. Nobody should reuse a password here that protects anything important.

**Reminders are in-app.** They appear on the bell and in the list. There is no phone push notification: real web push needs a service worker plus VAPID keys, and on iPhone the site must be added to the Home Screen first. Say the word and I'll add it.

**No history or undo.** Deleting a task asks once, then it's gone.

**Free Postgres sleeps.** The first request after a quiet spell takes a few seconds.

**Anyone with a username and no password set can claim it.** The first person to reach a never-used account sets its password. With an 18-person internal roster that's usually right, but tell people to sign in early rather than leaving accounts unclaimed.

**Department heads were guessed** from the ตำแหน่ง column — anyone whose title contains ประธานฝ่าย is marked a head. Check the Users page and untick anyone that's wrong; your choices there survive every sync.
