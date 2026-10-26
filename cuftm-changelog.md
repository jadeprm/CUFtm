# CUFTM (task.chulafair.com · short links on chulafair.com) — change log

**How changes reach the repository, since 22 October 2026:** the changed files are written straight into `Downloads/CUFtm-clean` on Jade's Mac — no more dated zips. That folder is the single local copy; everything older was deleted on 22 October after a tidy-up found 124 MB of half-overlapping downloads, two of which were both labelled `2026-10-19c` and contained different work.

The rule the zips existed to enforce still holds and is now the reason the single folder is safer: **a partial update is worse than none.** A half-copied set broke tasks.js on 2026-10-08, and reusing the filename `cuftm-complete-update.zip` for two different packages meant the 10-09 documents work was never deployed (10-10). When only some files change, every one of them has to land, and the version string below is how to check that it did.

**Checking what is live:** Profile → เวอร์ชันที่ใช้งานอยู่ shows the page's version and the server's. They must match; if they differ the deploy was incomplete. The string lives in `lib/version.js` (server), as `var APP_VERSION` near the top of `public/app.js` (page), and in every `?v=` in `public/index.html` — bump all three with each package; run.mjs §77 fails if they drift apart.

**Posts are read from the roster's ตำแหน่ง column, not from Access.** ต๊อดติ is a Co-Admin because he manages people, which is not a reason to offer him as ประธานโครงการ. If a post ever stops being offered to the right person, look at that column first.

**Working on this in a new container:** copy `Downloads/CUFtm-clean` across, `npm install`, create the `fairv2` database, and run `node srv2.mjs` — `dev-tests/neon-local.mjs` points the Neon driver at the local Postgres. The suites expect Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.


## 2026-10-27 (b) — one request, one email · version `2026-10-27b`
Schema `2026-10-27b`. Still 12 functions. FULL zip.
- **The OTP no longer goes out twice.** Two sends landing together (a double tap, Enter plus a click, two tabs) both passed the cooldown check and both emailed. The code row is now claimed first under a unique (purpose, subject, 45-second slot) index and only the winner sends; the "send code" button also locks once pressed and "send again" waits 45 s. If the mail provider refuses, the claimed row is removed so the person can retry at once.
- **Found while testing, unrelated:** task, event, meeting and report codes were padded with `lpad(…, 4)`, which *truncates* past 9,999 (M10000 → M1000, a duplicate-key crash). Now a `code_pad()` SQL function pads without truncating. No live impact yet; it would have hit at 10,000 items.
- Tests: §106 fires three simultaneous requests and expects one email.

## 2026-10-27 — Emails on the manage-users page, approvers found automatically · version `2026-10-27a`
No schema change. Still 12 functions. FULL zip.
- **Emails on หน้าจัดการผู้ใช้:** admins and co-admins see every member's email (✓ when verified, "ยังไม่ได้ผูกอีเมล" when not); an editor receives the emails of the people in the departments they look after. Everyone else still gets only the verified flag.
- **Registration no longer asks who the approver is.** The applicant picks a ฝ่าย and the page shows who will be asked: the editors-and-above whose home is that ฝ่าย and who are its head, or secretary/assistant by ตำแหน่ง (เลขา / ผู้ช่วย). Admins and co-admins can always decide, so a ฝ่าย with nobody listed is never stuck. Only display names are shown publicly, never usernames.
- Tests: 1,6xx server checks pass (§104 reworked, §105 new); `join.mjs` updated.

## 2026-10-26 — Members live in the app, every account has a verified email, and people can apply · version `2026-10-26b`
Schema `2026-10-26a` (adds `users.email`, `users.email_verified_at`, `email_otps`, `registrations`). Still 12 functions — everything rides `api/auth.js` and `api/users.js`. FULL zip.

### The Google Sheet is no longer the member database
Asked for in so many words: *เอาออกจาก google sheet มาใช้ฐานข้อมูลของเว็บให้หมด*. Done at runtime, kept as a tool:
- **Nothing reads the sheet while the app runs.** The hourly cron no longer syncs the roster (it used to close any account the sheet had no row for); sign-in no longer pulls the roster when the table is empty; the *Sync now* and *Open sheet* buttons and the two sheet notices are gone from the admin page; `?do=sync` returns `UNKNOWN_ACTION`.
- **Nothing is written to it either.** Adding a member, renaming a username and changing access/department/unit no longer append or edit sheet cells. The directory no longer reports `sheetWritable`/`sheetId`/`lastSync`.
- **What is still true:** a change made on the admin page is marked as set in the app (`access_pinned`/`depts_pinned`), so if `lib/sheet.js` is ever used again as a one-off import it cannot overwrite it. `lib/sheet.js` stays only as that import tool (and its CSV parser serves the bulk-import page); the test suite uses it to seed fourteen people. The *document register* sheet (`DOC_SHEET_ID`) is a different thing and is untouched.
- **A fresh, empty database:** the first person to apply becomes the admin (see below). A live database that already has members is unaffected — all existing accounts stay exactly as they are.

### Every account must prove an email
- **Resend**, by HTTP (`lib/mail.js`). Set `RESEND_API_KEY` in Vercel yourself (this code never sees it) and verify `chulafair.com` in Resend; `MAIL_FROM` is optional (default `CUFTM <noreply@chulafair.com>`).
- **The rule switches on only when mail can actually be sent.** With no key, nobody is locked out and the registration form says it cannot work yet. `EMAIL_REQUIRED=off` is the emergency switch if mail goes down while the rule is on.
- **Enforced on the server, not the page.** `currentUser()` treats an unverified account as signed out everywhere except the sign-in endpoint, which reports `emailRequired` so the page can show the *ผูกอีเมลของคุณ* step. A member signs in, is stopped on that step, receives a 6-digit code, and only then reaches the app. Existing members with no email meet it at their next sign-in (you chose *บังคับหลังล็อกอิน*).
- **Codes:** six digits, valid 10 minutes, five tries, stored only as a salted hash, one use, 45 seconds between requests, six per hour per address. One verified address belongs to one account (unique index).
- **The shared directory says whether an email is verified, never what it is.**

### People can apply without an admin creating the account
- *สมัครสมาชิก* on the sign-in screen. The applicant gives username, nickname, full name, **ตำแหน่ง**, **ฝ่าย**, **ฝ่ายย่อย/หน่วย**, email and a password, and names their **ประธานฝ่าย** (required), **เลขาประธานฝ่าย** and **ผู้ช่วยประธานฝ่าย** (optional) by username, nickname or full name. The server resolves each to an account and refuses anyone who is not an Editor, Co-Admin or Admin — and says which box failed.
- The applicant then proves their email with a code. Only then does the request reach the queue; the named approvers and every admin/co-admin get a bell notification.
- **Approval: any one of the named people, or any admin/co-admin, is enough** (you chose *คนใดคนหนึ่ง*). New page **คำขอสมัคร** (visible to Editor and above) lists the requests that name you; admins see all. Approve creates the account as a **member** in the chosen department/unit with the verified email attached, and emails the applicant; decline emails them too.
- The password is hashed at application time and the copy is wiped when the request is decided. Rejected/approved requests keep their record.
- **Not collected, on purpose:** รหัสนิสิต, phone numbers, health data.
- Abuse limits: at most 300 open requests, the per-address code limits above, usernames and verified emails unique.

### Tests
`node test/run.mjs` — **1605 checks** (§104 is the new section: the email rule, codes, registration, approvers, decline, lock-out after five tries, the emergency switch; §52/§56/§100 rewritten for "no sheet"). `dev-tests/join.mjs` drives the form, the email step and the queue in a browser; `srv2.mjs` now seeds a fresh development database itself and has `/__mail`, `/__mailon`, `/__mailoff`.

### What needs doing on Jade's side
1. Deploy the whole FULL zip.
2. Create a Resend account, verify `chulafair.com`, put `RESEND_API_KEY` in Vercel. Until then nothing changes for current users.
3. Once it is set, every current member will be asked for their email at their next sign-in — worth a line in the LINE group first.

## 2026-10-26 — R0002: the tab that came back blank · version `2026-10-26a`
No schema change. Still 12 functions. FULL zip.

**The first bug report the reports page has produced**, which is itself worth noting: นิตา filed it with the page, the browser, the window size, the version and what she was doing, and that is most of why it was answerable at all.

> ค้างเวลาเข้าแท็บอื่น · เจอว่าต้องทำอะไรบางอย่างในชีท เลยเพิ่มแท็ปชีท พอกลับมาดูซุฟต้ม มันจะเป็นหน้าดำ ๆ ว่าง ๆ ไม่มีอะไรเกิดขึ้น ต้องกดปิดแล้วเข้าใหม่ · macOS · Safari · 1262x620

### What is not known
**Why Safari empties the page.** Not reproducible in the suites' Chromium: simulated tab switches across six pages left every one of them intact, and WebKit is not available here to try properly. Guessing at a cause and shipping the guess would have been the wrong move.

### What is known, and was fixable
**`renderPage()` clears `main` first and draws second.** Anything thrown in between leaves a blank page with no way back but reloading the tab — so a bug in any one page reads as "the whole app died", and nobody can say which page or why. That shape is the reason R0002 was unreportable, whatever triggers it.

And the one place it mattered most swallowed the evidence:

```js
api('/api/tasks').then(function (d) { S.tasks = d.tasks; renderPage(); }).catch(function () {});
```

A throw inside `renderPage()` landed in that empty catch, after `main` had already been cleared. Blank page, no error, no clue.

Three changes:

- **The dispatch is wrapped.** A page that cannot be drawn now says so, with the error message and a reload button, and the rest of the app still works. Every future bug of this class arrives as something somebody can send in rather than as an empty rectangle.
- **Coming back to the tab heals it.** `backFromAway()` does not care what emptied the page, because nobody knows: it checks the one thing always true of the symptom — signed in, nothing on screen — and draws again. On `visibilitychange`, on `focus` (a window switch, which does not always fire the first), and on `pageshow` with `persisted` (restored from the browser's own cache, where the DOM may be anything).
- **One redraw, not two.** The two refreshes each called `renderPage()`; now they settle together and draw once. Half the chances to throw, and nothing swallowed.

### Tests
- **run.mjs §103 is new (8 checks)** — the dispatch wrapped, the message carrying the error, the self-heal checking what is on screen, all three events wired, the empty catch gone, and the single redraw.
- **`dev-tests/polish.mjs` §6 is new** — the page wiped by hand, which is the same end state whatever caused it, then brought back by a window focus and by a tab switch, shell included.
- **1574 checks**, 33 browser suites.

## 2026-10-25 — everybody may write work down · version `2026-10-25e`
No schema change. Still 12 functions. **Shipped as one FULL zip — see below.**

### The rule that described nobody
The access ladder was built around a distinction: *an editor runs a section and hands work out, a member does the work they are given.* It is a coherent rule and it fitted no one on this committee. A สมาชิกฝ่าย who notices the posters have not been ordered writes it down — the alternative was messaging somebody senior to type it in, which is how a tracker becomes a thing people work around rather than in.

`canEditTasks` is now `Boolean(user)`, and `cannotAssign` no longer stops a member either. Both locks were on the same door and opening one without the other would have been a worse rule than either: being able to write down a job and not being able to say whose it is.

This finishes a change that went in three steps over three days — meetings on the 24th (§95), tasks and events now — each one for the same reason and each one arriving as a separate report from somebody who had hit it.

**What stops this being a free-for-all is not a permission.** Being named is an invitation: it arrives, it can be declined, and whoever did the naming was shown first whether that person was even free. Everything else holds — somebody else's task is still not yours to rewrite, and nobody gained an account control on the way.

### The one thing still held back
A **short link** is a public address on the committee's own domain that goes on a poster. Publishing under the committee's name is a different act from organising its work, so it kept the old answer rather than being opened by a change that was about something else — `canMakeShortLink` in `lib/auth.js`, which is just the rule `canEditTasks` used to be. Say the word and it goes too.

### One zip, the whole app
The recurring failure here is not a bug, it is a **partial deploy**: `tasks.js` on 10-08, the documents work never shipping on 10-10, and this week the page at `2026-10-24a` with `api/` and `lib/` still at `2026-10-22d` — new buttons on screen with nothing behind them. Every one of those was a package of changed files where some of them landed.

From this release the package is the **entire project** — `api/`, `lib/`, `public/`, `test/`, `dev-tests/`, `package.json`, `vercel.json`, the lot — minus `node_modules` (installed, not shipped) and the test screenshots (output, not input). About 5 MB and 123 files. Extract it over the folder and nothing can be half-updated, because there is no half.

### Tests
- **run.mjs §102 is new (9 checks)** — a สมาชิกฝ่าย putting work on a ประธานฝ่าย and a co-admin, tagging a whole ฝ่าย, creating an event and a meeting, the invitation still being an invitation, somebody else's task still not theirs to rewrite, no account control gained, and the short link still refused.
- Four checks that asserted the old rule now assert the new one: two in §64, one in §65, and `dev-tests/polish.mjs` on the "start here" card — which now offers the first task to exactly the person who had nothing on their plate.
- **1566 checks**, 33 browser suites.

## 2026-10-25 — the Drive archive, connected by a button · version `2026-10-25d`
Schema **`2026-10-25d`** (migrates itself: `oauth_states.purpose`). Still 12 functions.

Every PDF the committee has ever signed is still in Neon, because `lib/drive.js` has been finished and switched off since the day it was written. The code was never the problem: getting a refresh token meant an OAuth playground, a scope typed by hand, a long string pasted into Vercel and a redeploy — four chances to get it wrong and one person who could do it. So it never got done.

It is now a button on the admin page.

### Why a refresh token and not the service account
Unchanged and worth repeating, because it looks like duplication: a service account has **no Drive storage of its own**. It can edit a spreadsheet shared with it, and an upload to a personal Drive fails with `storageQuotaExceeded` because there is no personal Drive to put it in. So the archive acts as a real Google account — the committee's, not whoever is president this year.

### What the button does
`?do=drive-start` → Google's consent screen → the existing `google-callback`. One redirect URI, not two: Google wants every one registered by hand, and a second is a second thing to get wrong the next time the domain moves. The new `oauth_states.purpose` column is what tells the two flows apart, read from the state row rather than guessed from the scope — so a **cancelled** consent still lands on the page the person started from.

- **Scope `drive.file` and nothing wider.** The narrowest scope that can upload: it reaches files this app created and nothing else in that account. Even holding the token, the archive cannot read one other document in the committee's Drive.
- **`access_type=offline` with `prompt=consent`.** Without the second, a reconnection comes back with no refresh token at all and the archive stops a week later for no visible reason.
- **The token is sealed** with the same AES-256-GCM key as every other stored Google token and kept in `meta`, one row for the whole committee — the archive is a place, not a preference. A database dump holds no usable credential.
- **Admin and co-admin only**, to start it and to disconnect it. Disconnecting revokes the grant at Google too, so the app stops appearing in that account's list; the files already moved stay where they are.

### One OAuth client, two names
`lib/drive.js` asked for `GOOGLE_OAUTH_CLIENT_*` and `lib/googlecal.js` for `GOOGLE_SIGNIN_CLIENT_*`. One client serves both, and a committee that has already set up the Calendar link should not paste the same two values again under a second pair of names — so each is now read under either name. For most setups **there is nothing left to configure**: the button is simply there.

### driveConfigured() stays synchronous
It gates three call sites in `api/cron.js` and `lib/meetingstore.js`, neither of which has `sql` to hand. Rather than thread a database handle through all of them for a value that changes about once a year, `lib/db.js` puts the sealed token on the module once per request, on the same cached read as the org chart and the circles. Same pattern, third time.

### Tests
- **run.mjs §101 is new (18 checks)** — the archive off with no token, the Calendar client counting as the archive's, an editor turned away, the consent URL being for `drive.file` and nothing wider and asking offline, the state marked as Drive, the token stored sealed and switching the archive on, a replayed state refused, somebody else's state refused, consent without the Drive box refused rather than half-stored, and disconnecting leaving the archive off.
- The token endpoint stub can now be told what to answer, so the tests are about handling Google's reply rather than about the exchange.
- **1557 checks**, 33 browser suites.

## 2026-10-25 — AdSense verification, which is not advertising · version `2026-10-25c`
No schema change. Still 12 functions.

"Couldn't verify your site", on `chulafair.com`. Two separate reasons, and the second one was mine.

### The site being verified is not this one
`chulafair.com` is the public ChulaFAIR 2027 page — its own project, its own `/admin`, its own `robots.txt` and `sitemap.xml`, none of which exist in this repository. CUFTM is `task.chulafair.com`. The tag added in `2026-10-24c` went into CUFTM, so AdSense was looking at a site that had never heard of it. Nothing in this codebase can fix that; the tag has to go on that site.

It is also the better site to monetise. It is public, bilingual and has actual content, where `task.chulafair.com` is a sign-in box — thin content, and the kind of page a review can fail.

### Verification by JavaScript does not work
Even on `task.chulafair.com` it would have failed. The script is injected by `renderAuth()` so that Auto ads cannot follow anybody into the app — which is right for ads and useless for verification, because **the crawler reads the HTML source, not the rendered page.** There was nothing to find.

So verification is now done by the two things a crawler actually reads, and neither of them is an advertisement:

- **`<meta name="google-adsense-account">`** in `index.html`. A meta tag. It loads nothing, draws nothing, and reaches no visitor.
- **`public/ads.txt`**, served at `/ads.txt`. A static text file. AdSense refuses to serve to a site whose ads.txt does not name its publisher, so this is the permission as well as the proof.

Neither causes a single ad to appear. The script that does is still loaded only on the sign-in screen, and `ADSENSE_CLIENT = ''` in `public/app.js` still switches that off on its own, leaving the invisible half in place.

### Tests
- **run.mjs §98 gained 3 checks** — the meta tag present in the source, the ads.txt line in the exact format AdSense parses, and the publisher id being the same string in all three places. The existing check that no ad *script* is in `index.html` is unchanged and still the one that matters: that file is every screen at once.
- `dev-tests/srv2.mjs` now serves `.txt` as `text/plain`, so `/ads.txt` is readable in development.
- **1539 checks**, 33 browser suites.

## 2026-10-25 — the sheet is written to, not only read · version `2026-10-25b`
No schema change. Still 12 functions.

### What was already there, and what was missing
`lib/sheets.js` has authenticated write-back — a service account, the sheet shared with its robot address as Editor, the public link still view-only. It was written for **one** case: an access change. Two more had since appeared and neither reached the sheet:

- **A member added in the app** existed nowhere the committee looks. The sheet is the register of record; a name that is only in the app falls out of every printed list and every ฝ่าย count.
- **A corrected username** left the sheet saying the old one, so the next sync would read that row as somebody who does not exist and make a **second** account under it. The page warned about this in words; now it just does it.

`appendPerson()` and `renameInSheet()` close both. Appending writes only the half-dozen cells an account is made of — the roster also carries phone numbers, allergies and emergency contacts that people fill in by hand, and an integration that wrote a whole row would overwrite one of those sooner or later.

### The Access label the write-back could not spell
`ACCESS_LABEL` knew Admin, Co-Admin and Editor, because when it was written those were the only levels settable from the app. A row appended for a สมาชิกฝ่าย would have left the Access cell blank — and a blank cell is read by `normaliseAccess` as **Editor**, the opposite of what was asked for. `Unit lead` and `Member` are written out now.

### off_sheet is not cleared when the row lands
Tempting and wrong. The sync reads the sheet through `export?format=csv`, which is close to live but not guaranteed to be; handing the row straight to the sheet's ownership means a sync in that window finds no such person and **closes an account ten minutes old**. `syncPeople` already clears the flag the first time it really sees the name, which is the moment that is actually safe.

### Everything still works with it switched off
Which is how the committee has been running: `GOOGLE_SA_EMAIL` and `GOOGLE_SA_PRIVATE_KEY` are not set, and the admin page says so. Adding somebody and renaming them both happen either way, and the page says which of the two it got — `เพิ่มแถวในชีตรายชื่อให้แล้ว`, or that the row has to be added by hand. A rename that could not reach the sheet marks the person off-sheet and names the old username to go and change.

### Turning it on
1. Google Cloud console → a project → enable the **Google Sheets API**.
2. Credentials → **Service account** → Keys → **JSON**.
3. Share the roster sheet with that service account's email as **Editor**. The link everyone else has stays Viewer, so nobody can still promote themselves to Admin by opening it — the rule from the start is intact.
4. Vercel → Environment Variables: `GOOGLE_SA_EMAIL` and `GOOGLE_SA_PRIVATE_KEY` (either real newlines or `\n`; `readKey()` takes both). Redeploy.

### Tests
- **run.mjs §100 is new (14 checks)**, against the same Google stub §52 uses: the appended row landing below the last one in use with the username, nickname and ตำแหน่ง in their own columns, `Member` written rather than left blank, the person staying off-sheet until a sync has seen them, a rename moving exactly one cell in the Username column, and all of it degrading honestly when Google answers 403.
- §96 and §99 were written when the write-back was off and asserted the old outcome; both now assert the new one.
- **1536 checks**, 33 browser suites.

---

### Also diagnosed today, no code change
**The hourly job stopped when the domain moved.** `cu-ftm.vercel.app/api/cron` now answers **302** to `task.chulafair.com`, because making the custom domain primary turns the old one into a redirect. cron-job.org's `redirectSuccess` defaults to **false** — a 3xx is scored as a failure — and it disables a job that keeps failing. The fix is the job's URL, not the code: point it at `https://task.chulafair.com/api/cron` and re-enable it. Vercel's own cron cannot replace it: Hobby is limited to **once per day**.

**The live site is a half-deploy.** `index.html` says `2026-10-24a` and `/api/meta` says `2026-10-22d` — the page was deployed and `api/` and `lib/` were not. Every server-side feature from 10-23b on is missing behind a UI that offers it. This is exactly what the version string exists to catch, and the profile page shows both numbers side by side.

## 2026-10-25 — a username can be corrected · version `2026-10-25a`
Schema **`2026-10-25a`** (migrates itself: every foreign key gains ON UPDATE CASCADE). Still 12 functions.

`Mochi_HeadOrganizer`, for somebody called Moji. The only way to fix that was to delete the account and make another one — which throws away every task she is on, every document she signed, every meeting she answered and her session. Jade's instruction was exactly the point: **แก้ username อย่าลบแอคเคาท์เดิม.**

### Why it was not already possible
A username here is not a label. It is the key about **sixty columns** hang off, across more than forty tables: `task_people`, `meeting_people`, `signatures`, `doc_steps`, `notifications`, `push_subscriptions`, `tasks.created_by`, `spaces.created_by`, and on. Changing it in one place and not the rest is worse than not changing it at all.

### Two mechanisms, deliberately
**Thirty-odd tables point at `users(username)` with a foreign key.** Those now carry `ON UPDATE CASCADE`, so they move inside the one `UPDATE`, atomically. That is the half that must not half-happen: a session or a signature pointing at a user who is not there is not a state worth risking, even for a moment.

The migration adds it by **looping over what the database has** rather than thirty hand-written ALTERs, so a table added next month is covered by the next deployment without anybody remembering the block exists. It costs nothing the rest of the time — the other keys it now follows (a task id, a document id) never change.

**The columns with no foreign key are swept afterwards**, in `lib/rename.js`, and are found by asking `information_schema` rather than from a list in the file. A list would be correct on the day it was written and quietly wrong the first time somebody adds a table. The pattern catches the house style — `username`, anything ending in `_by`, `owner`, `assignee` — plus two that do not follow it, and explicitly drops `line_user_id` and `user_agent`, which match the pattern and are not people.

Order matters: the row first, the sweep after. At no point does a foreign key point at a user who is not there, and the sweep is idempotent, so the columns the cascade already moved simply match nothing.

### What the server cannot fix
**The sheet still says the old name.** The next sync would read that row as somebody who does not exist and make a *second* account under it. Renaming marks the person `off_sheet` so at least the real account survives, and says so on screen — but changing the Username column in the sheet is a cell nobody here can write for Jade, so the page tells her to, by name.

### Smaller decisions
- **It reports what moved**, table by table. A rename that silently touched nothing looks exactly like one that worked, and the difference matters when it is somebody's signature.
- **Correcting only the capitals** (`jade_pres` → `Jade_Pres`) is a rename like any other. The uniqueness check excludes the row being renamed, or it would refuse to rename something for clashing with itself.
- **Renaming yourself reloads the page.** Everything it did next would be about a name that no longer exists.
- Identifiers go into the sweep by name, because Postgres will not take a table or column as `$1`. They come from `information_schema` and never from a request, and `quote()` refuses anything that is not a plain identifier anyway.

### Tests
- **run.mjs §99 is new (16 checks)** — an editor refused, a bad shape and a taken name refused, the account moving rather than being remade, her session surviving, every task and meeting coming with her and nothing left pointing at the old name, the sheet warning and the `off_sheet` mark, a capitals-only fix, renaming to the same thing, and a check straight at `pg_constraint` that no foreign key is left without `ON UPDATE`.
- **`dev-tests/org.mjs` extended** — the box opening on the right name, the directory showing the new one and not the old one beside it, and the line about the sheet.
- **1522 checks**, 33 browser suites.

## 2026-10-24 — AdSense on the sign-in screen · version `2026-10-24c`
No schema change. Still 12 functions. Shipped on top of `2026-10-24b` and `2026-10-24a` below, in one package.

Jade's publisher id, `ca-pub-6829067770704612`, with Auto ads switched on for task.chulafair.com.

### Why the tag is not in index.html
Because **index.html is the whole app.** One page, every screen. The tag Google hands you goes in the head, and in a single-page app that is not "ads on the login page" — it is Auto ads over the task board, inside documents, and on top of the committee's meeting agendas, for two hundred people trying to work.

So the script is injected by `renderAuth()` and by nothing else. Somebody who already has a session never draws that screen, so the script is never fetched for them at all.

### Signing in starts the app over
Auto ads does not stop when the screen it loaded on goes away: it keeps watching the page and placing anchors and overlays wherever it likes. Taking the elements away by hand is a game nobody wins, so `afterSignIn()` reloads instead — **but only when a script was actually loaded**, which is the signed-out case and only that.

The cost is close to nothing. Somebody signing in is already waiting on a round trip, the signed-in app is about to fetch everything anyway, and anybody with a session skips the whole path.

### It only runs on the real site
`ADSENSE_HOSTS = ['task.chulafair.com']`, plus `?ads=1` for testing. AdSense serves nothing on localhost anyway, and without the gate every browser suite in `dev-tests` would have started reloading mid-sign-in for a feature none of them are about. Clearing `ADSENSE_CLIENT` to `''` switches the whole thing off: no script, no reload, no change in behaviour.

### Worth knowing before expecting money
- **A sign-in box is thin content.** AdSense's policies want pages with something on them; a login screen for a private committee tool is the kind of page that can be found non-compliant, and the account is Jade's to lose. Putting the ads on the public holding page instead (`COMING_SOON`) would be the safer surface — say the word and it is a one-line change.
- **The audience is about two hundred people signing in a few times a week.** The number this earns is not going to be a number.

### Tests
- **run.mjs §98 is new (6 checks)** — nothing in index.html, the script loaded from `renderAuth` and nowhere else, the host gate present, the reload conditional on a script having loaded, and both sign-in paths going through `afterSignIn`.
- **`dev-tests/ads.mjs` is new** — with Google's script answered locally, so the suite does not depend on a third party being up: the tag on the sign-in screen with the right publisher id, gone once inside the app, never loaded for somebody with a session, and never loaded on localhost.
- **1506 checks**, 33 browser suites.

## 2026-10-24 — groups, labels, and anybody may call a meeting · version `2026-10-24b`
Schema **`2026-10-24b`** (migrates itself: `circle_groups`, `circle_people`, `user_tags`, `task_tags`). Still 12 functions. Shipped on top of `2026-10-24a` below, in one package.

### สมาชิกฝ่ายเรียกประชุมได้
`2026-10-24a` widened `canCreateMeeting` from editors to unit leads, which fixed the two ประธานฝ่าย who reported it and left the identical trap one rung lower. Jade asked for the rule to go, so it has: **anybody with an account may call a meeting.**

Nothing is given away by that. Calling a meeting invites people, it does not oblige them — they decline, only the organiser can change it, and who may *see* one is a separate rule. The + sheet now asks its four choices separately rather than gating the whole thing on `mayCreate()`: a สมาชิกฝ่าย may book a room and may not put work on anybody, and one blanket gate gets one of those two wrong whichever way it is set. §67's old "a member cannot call a meeting" check is now the opposite assertion, with the reason beside it.

### Who is on the board, when the ladder gets it wrong
The four circles — คณะกรรมการบริหาร, คณะทำงานหลัก, หัวหน้าทั้งหมด, ทุกคน — were questions asked of the roster: "who is at least a co-admin right now". That is a good first answer and was treated as the only one, which left two things unsayable. ต๊อดติ is a co-admin because he manages people, which is *a* reason to be on the board; the ผู้ช่วยประธาน who sits on the board without that access level could not be on it at all.

**`circle_people` holds `in` and `out` rows, not a membership list.** The derivation keeps running and these are the exceptions to it, which is why the admin page marks a pinned name as pinned: "on the board because they are a co-admin" and "on the board because somebody said so" are different facts, and only the second is anybody's to take back. Order matters in `inCircle` — a closed or suspended account is outside every circle whatever anybody pinned, because a circle is a way of reaching people.

### Groups the committee invents
`circle_groups` holds the ones nobody transcribed: "ทีมรื้อของวันเสาร์". A group has **no access floor**, so nothing derives membership — people are put in, or they walk in, and `selfJoin` is the difference. `applyCircles()` folds them into `CIRCLES` and `CIRCLE_KEYS` **in place**, on the same cached read as the org chart, so every picker in the app gets them without a single call site knowing they exist. Calling a meeting on one, and the standing-circle re-apply from `2026-10-24a`, both work for free; §97 checks the meeting case.

The four built-in circles cannot be renamed from a form (`NOT_A_MADE_GROUP`). They are described in `lib/circles.js` and referred to by name across the app; renaming คณะทำงานหลัก from the admin page would leave the code and the committee talking about different things.

### The page stopped working out who is in a circle
`circleMembers()` recomputed the access ladder in the browser, which was the same rule the server used and is no longer the whole rule. The server now stamps every directory row with the circles that person is actually in, and the page reads rather than recomputes. One answer, from the side that owns it — and the ladder logic is gone from `public/app.js` entirely.

### Labels people keep for themselves
`user_tags` and `task_tags`, both scoped to a username. Deliberately **not a second ฝ่าย system**: a ฝ่าย says who you answer to and who may see what; "รอของ" means something only to the person who wrote it, and a shared label would have to be agreed on — which is the thing people reach for a private one to avoid. Up to twenty each, because a filter row of forty labels is not a filter row.

Three decisions worth keeping:
- **A label can go on anybody's task you can see**, not only your own. The case it is for is waiting on work that is not yours.
- **It lives on the read pane, saved on the tap**, not in the form behind แก้ไข — otherwise the person who may not change a task could not label it, which is exactly that person.
- **The same task going out to two people carries different labels**, and neither learns anything about the other's. §97 checks both directions, including that the tag list of somebody else comes back empty rather than filtered.

Deleting a label takes it off the work it was on, by the foreign key: a label nobody can see is not worth keeping on anybody's task.

### Tests
- **run.mjs §97 is new (27 checks)** — pinning in and out and the directory agreeing, un-pinning handing somebody back to the ladder, a suspended account outside every circle anyway, an editor refused a group, a made group deriving nobody, walking into an open one, being refused the board and a closed group and somebody else's membership, the built-ins refusing a rename, a meeting called on a made group inviting everybody in it, and the whole of labels including the privacy in both directions.
- §67's member-cannot-call-a-meeting check is now its opposite; §95 gained the สมาชิกฝ่าย case and a check that calling one does not make them able to rewrite it.
- The reset block clears `circle_people`, `circle_groups` and `user_tags`.
- **`dev-tests/org.mjs` extended** — the circles listed with what they derive from, inventing a group, putting somebody on the board through the members dialog and seeing them marked as pinned, and on the profile: joining an open group, making a label, and finding it above the work page. It clears its own groups, pins and labels at both ends.
- **1500 checks**, 32 browser suites.

## 2026-10-24 — two bug reports, and the committee's own org chart · version `2026-10-24a`
Schema **`2026-10-24a`** (migrates itself: `meetings.circles`, `users.off_sheet`, and the two `org_*` tables). Still 12 functions.

Two ประธานฝ่าย reported problems in LINE on the same evening. Both turned out to be rules rather than faults, and neither rule said so — which is the actual bug in both cases.

### "มันแจ้งว่าเกิดการผิดพลาดขึ้นตลอด"
ดาริณ (ประธาน Stage) and วุ้นเส้น (ประธาน Merch) both tapped นัดประชุม and got **เกิดข้อผิดพลาด กรุณาลองใหม่** every time — a message that tells somebody to repeat the exact thing that will not work.

`canCreateMeeting` allowed editors and above. Both of them are **Unit lead**, which sits below Editor, so the server refused with `CANNOT_CALL_MEETING` — and that code was not in `window.ERROR_KEYS`, so it fell through to the generic string. Three things were wrong and all three are fixed:

- **A ประธานฝ่ายย่อย can now call a meeting.** They run something; convening their own unit is the job. A สมาชิกฝ่าย still cannot.
- **The page no longer offers what the server will refuse.** `mayCallMeeting()` in `public/app.js` mirrors the server's rule and gates all three entry points — the + sheet, the calendar button, the teamspace button. They were gated on `mayCreate()`, which only excludes viewers.
- **Every meeting refusal now says what is wrong.** `CANNOT_CALL_MEETING`, `NOT_MY_MEETING`, `TITLE_REQUIRED`, `NOT_YOUR_ITEM`, `NO_SUCH_MEETING`, `MEETING_IS_OVER`, `CANNOT_REWORD_OTHERS` and nine more were all unmapped. run.mjs §95 now fails if any of the four worst of them falls back to `errGeneric`.

### "รบกวนดูให้หน่อยว่าแอดหนูเข้าไปรึยัง"
วุ้นเส้น could not see a รายงานการประชุม other people had. She had not been invited — and she could not have been, because **the invitation was a list of names frozen on the day it was sent.**

The picker expands ทุกคน into usernames in the browser and sends only the names. Her account was created on 22 October; the meeting predated it; nothing would ever have added her. This is the whole class of "am I added yet" messages.

- **A meeting now stores the circle it was invited on** (`meetings.circles`) as well as the names. The page sends both: the names are what the organiser looked at and approved, the circle is what they meant.
- **`topUpStandingInvites()` re-applies every standing circle after a roster sync** — the one moment the answer can change. Only to meetings still ahead and still `planned`: adding a name to last week's attendance would be a lie. It never removes anybody, because somebody taken off a circle may still have been at the meeting and may already have replied. The sync reports how many it added.
- **The reply route covers the gap between syncs**: somebody inside a stored circle who is not yet on the list gets their row written when they answer, instead of `NOT_INVITED`.
- A note on the edge: a selection that happens to cover a circle exactly is treated as that circle. Inviting precisely the two people in คณะกรรมการบริหาร means a co-admin appointed later joins those meetings. That is the behaviour the group names imply, and it is why only the **widest** covered circle is used for the label.

### A ฝ่าย's own meeting is that ฝ่าย's business
`canSeeMeeting` now also passes for anybody with access to the meeting's `department`. The column was being written on every meeting and read by nothing. A ประธานฝ่าย should not have to be named on the invitation to read what their own section decided.

Deliberately narrow: a meeting with **no** ฝ่าย — which is what the chair's committee-wide meetings are, since the ฝ่าย comes from whoever called it — stays exactly as private as its guest list. The merchant head still cannot see เนื้อหา's meetings; §95 checks both directions.

### The committee changes its own org chart
เสื้อโครงการ existed in the committee for a month before it existed in the app, because adding a หน่วย meant editing `lib/departments.js` and shipping a deployment. Adding a person meant a row in the roster sheet and a wait for the next sync. Neither is a decision anybody outside the committee should be standing in the middle of.

**`lib/departments.js` is now a base, not the whole truth.** `DEPARTMENTS`, `DEPARTMENT_KEYS` and the lookup map are rebuilt **in place** by `applyOrg()` from two overlay tables — in place, because every other module imports them once at load and handing out a fresh array would leave half the app reading last request's chart. `getSql()` folds the overlay into the `ready` promise every endpoint already awaits, cached 30 seconds per warm instance and cleared by `forgetOrg()` the moment the admin page changes something.

What an admin or co-admin can now do, from the admin page:

- **Add a ฝ่าย**, optionally under another one — the parent rule still means granting the parent grants the children. Its Thai and English labels become spellings the roster sheet's Department column is matched against, so a new ฝ่าย can place people without anybody editing aliases.
- **Rename a ฝ่าย.** The key never changes and is shown on the card, because the key is what every task, grant, meeting and document points at.
- **Add or put away a หน่วย**, which is where "unit workspace as a sub-category of departments" lands: each ฝ่าย's card lists its หน่วย as chips underneath it, and one of the buttons on a chip makes that หน่วย a teamspace whose membership rule is the หน่วย itself — everybody filed there joins automatically.
- **Add a member** the sheet has not caught up with. No password is set: the person claims the account the same way everybody else does, so the rule that no admin ever knows another person's password is untouched. A co-admin cannot create an admin, which would otherwise be the way around `ONLY_ADMIN_SETS_ACCESS`.

**Nothing is ever deleted.** Putting a ฝ่าย or a หน่วย away takes it out of the pickers; everything already pointing at it is left alone, and the หน่วย case says how many people are still filed there rather than letting an admin find out later.

`users.off_sheet` marks somebody added here. The sync closes every account it cannot find a row for, which is right for a roster the sheet owns and would have closed these the same hour. The flag clears itself the moment their name does appear in the sheet.

### The one that would have been missed
`/api/meta` serves the reference data — including the chart — **without touching the database on purpose**: it is the cheapest thing the app serves and the page asks for it on every load. So the admin page showed a new หน่วย and every picker in the app did not. `dev-tests/org.mjs` caught it; the branch now awaits `ready` when there is a database and falls back to the transcribed chart when there is not.

The second one it caught: `makeDepartmentKey` only avoided keys in the *live* chart, so re-adding a ฝ่าย that had been put away collided on the primary key. Keys of hidden ฝ่าย count as taken — handing the same key to a new one would quietly merge the two.

### Tests
- **run.mjs §95 (16 checks)** — who may call a meeting, the error strings not being generic, ฝ่าย visibility both ways, the circle stored as a rule, a new member picked up by a top-up and not before, no double-adding, and a meeting that has happened never being added to.
- **run.mjs §96 (20 checks)** — adding a person and the chart: an editor refused both, a duplicate username whatever the capitals, a co-admin refused an admin, a sync not closing an app-created account, a renamed ฝ่าย keeping its key, a หน่วย added to a transcribed ฝ่าย, the same หน่วย spelled with a stray space not added twice, and putting one away reporting who is still filed under it.
- The reset block now clears `org_units` and `org_departments`. Without it a run that added a ฝ่าย left the next one working from a chart nobody wrote down.
- **`dev-tests/org.mjs` is new** — the section exists, a ฝ่าย shows its หน่วย underneath it, adding a หน่วย reaches the pickers and not only the chart, adding a ฝ่าย, adding a member, and an editor being offered none of it. It clears its own fixtures at both ends.
- **1473 checks**, 31 browser suites.

## 2026-10-23 — the feed · version `2026-10-23b`
Schema **`2026-10-23b`** (migrates itself: two columns on `posts`). Still 12 functions.

The server side of the feed already existed — `lib/feed.js`, the routes on `api/notifications.js`, the tables, the `feed` notification category. What was missing was the page, which is what this release is, plus pinning, which Jade asked for.

### Why it is not the announcements page
Jade chose this split when asked, and it is the decision the rest of the design hangs off. An **announcement** is the committee speaking TO somebody: it comes from an admin, it buzzes a phone, it is read once. The **feed** is the committee talking AMONG itself: anybody posts, nothing buzzes, and the value is that it is still there next week. Collapsing them gives you one of two bad things — every photo of a Saturday work session interrupting two hundred people, or announcements nobody notices in a stream of photos.

So **the only thing in the feed that notifies anybody is a reply to your own post.** Not likes: a popular photo would be forty notifications, and the one that mattered would be lost among them.

### The page
- **A composer open to everybody**, including a สมาชิกฝ่าย who cannot create a task. Text, up to four pictures, and a ฝ่าย picker that defaults to ทั้งโครงการ — a post nobody can find is worse than one a few extra people scroll past.
- **Pictures laid out by how many there are.** One gets the full width at its own shape; two sit side by side; three or four become a grid. A fixed grid letterboxes a single portrait photo into a thin strip, and most phone photos are portrait.
- **Replies in place**, open already when a post has some and folded when it has none — a conversation behind a button is a conversation nobody joins.
- **Three tabs and a ฝ่าย dropdown**, not a tab per ฝ่าย. The first build gave an admin seventeen buttons over three lines, because an admin is in all fourteen ฝ่าย. The three real modes are tabs; which ฝ่าย is a different question and gets a dropdown, which also stays on one line on a phone.
- **A ••• menu** per post: pin (admins), edit, delete, and tell an admin. Opening one closes any other — two lists of actions stacked gives no way to tell which post either belongs to.
- **Editing changes the words, never the pictures.** Swapping the photo under a post people have already replied to is a different post wearing the same replies; the dialog says so and says to delete and post again instead.

### Pinning
`pinned_at` rather than a boolean, because a committee eventually pins two things and then the order it pinned them in is the order they belong in. **Admins only** — posting is open to everybody precisely because a post costs nobody anything, and the top of two hundred people's page is a different thing. **Five at most**, or the held list becomes a second feed above the feed.

The part worth knowing: **a pinned post is its own list, not a sort order.** The feed pages by `created_at < cutoff`, which is what makes it cheap and correct — and a pinned post from September sorted to the top of that query would either repeat on every page or be skipped on page two. It comes back as a separate array on the first page only, and is excluded from the stream, so it is never drawn twice. Checked in both suites.

### Tests
- **run.mjs §94 is new (30 checks)** and covers the whole feature, since none of it had any: a member posting with pictures, ฝ่าย scoping both ways including the pictures, likes counting once and telling nobody, a reply notifying the author, the post owner being able to clear a reply off their own post, who may rewrite and delete, and all of pinning — a member refused, an admin allowed, the separate list, no duplicate in the stream, nothing riding along with page two, and the five-post cap. **1438 checks.**
- **`dev-tests/feed.mjs` is new**, for what only exists in a browser: the composer, two pictures laying out as a pair, replies folding and unfolding, the like button leaving no zero behind when taken back, only one ••• menu open at once, a ฝ่าย post invisible to another ฝ่าย, and the whole thing at 390px with a thumb-sized ถูกใจ. It clears any leftover pins at both ends — five is a real cap, so a previous run fills it and the next one's pin is refused by a rule working exactly as intended, which is the most confusing kind of red.

### A mistake worth recording
I overwrote `lib/feed.js` with a fresh implementation, not having noticed the file already existed — the clue was `Write` reporting "updated" rather than "created", and I missed it. Nothing was lost: the original was recovered in full from the session transcript and restored, and the duplicate schema block and routes I had added were removed. But the reason it was recoverable at all is luck, and the reason it happened is that I did not look before writing.

## 2026-10-23 — two pages called เอกสาร, and a pop-up nobody could find · version `2026-10-23a`
No schema change (`2026-10-22d` still). Still 12 functions. Wording and placement only.

### Two tabs with the same name
The bottom bar on a phone showed the SHORT label, and two of them were the identical word **เอกสาร** — one for sending official letters, one for the new shelf of links. That is not a naming quibble: it is two tabs you have to press to tell apart.

| | was | now |
|---|---|---|
| letters | เอกสาร / เอกสาร | **ส่งเอกสาร** / ส่งเอกสาร |
| the shelf | เอกสารสำคัญ / เอกสาร | **รวมข้อมูลสำคัญ** / ข้อมูลสำคัญ |

Jade's words, and they are better than mine were: "ส่งเอกสาร" says what the page is *for* rather than what it contains, and "รวมข้อมูลสำคัญ" stops the shelf reading as a kind of เอกสาร at all — which it is not, since most of what belongs on it is a link to a sheet or a form. English follows: **Send a document** and **Key information**. The shelf's one-line intro changed with it.

### The pop-up composer was several screens down
It sat below **ประกาศที่ส่งไปแล้ว**, which grows without limit — so after a few weeks of announcements the one control for putting a notice in front of the whole committee was far below the fold, and Jade could not find it. It now sits directly under the announcement form. The two things an admin comes to that page to *do* belong together at the top; the record of what was already done belongs underneath.

### Tests
run.mjs §93 is new (7 checks), and they are about the class of mistake rather than these two instances:
- **no two tabs may share a short label**, in either language, across all nine — this is the check that would have caught the original clash, and will catch the next one;
- the two new names are what they should be, and are genuinely translated rather than left in Thai;
- **every nav label in `index.html` matches its Thai string.** The shell carries the words as untranslated defaults so the tab bar is right in the instant before app.js runs, and the two drift apart silently;
- the pop-up composer appears before the sent-announcements log in the source.

**1408 checks.** All 29 browser suites still pass — every one of them reaches a page by route or `data-page`, never by its visible label, which is why a rename of this size touched none of them.

## 2026-10-22 — a paper can belong to one วาระ · version `2026-10-22d`
Schema **`2026-10-22d`** (migrates itself: one nullable column on `meeting_files`). Still 12 functions.

Asked for from a screenshot of a meeting with three papers in one undifferentiated list. A committee's papers divide two ways in practice — the minutes of last time and the joining link belong to the meeting; the budget spreadsheet belongs to วาระที่ 4.2 and is noise everywhere else — and a flat list cannot say which is which.

**The default is unchanged, and that is the whole design.** `meeting_files.agenda_id` is nullable; null means the paper is for the meeting as a whole, which is what every existing row is and what the picker still offers first, already chosen. Nobody who liked the old behaviour has to do anything differently — which is what "หรือขึ้นรวมแบบเดิมก็ได้" asked for.

### What changed on the page
- **One picker above the two attach buttons**, not one each, because it is one question. It is hidden entirely when the agenda is empty: a choice between one thing is not a choice.
- **The list groups itself**, meeting papers first, then one group per วาระ that has any. A group with nothing in it never appears — an empty heading per วาระ would be longer than the list it organises.
- **Headings appear unless the only group is the meeting's own.** "More than one group" is not quite the rule: when every paper sits under 4.1 there is still one group, and saying nothing leaves the reader unable to tell they are filed at all. The heading is redundant in exactly one case — everything belongs to the meeting, which is what the list meant before.
- **A paper count on each agenda row**, which is the point of the change: the agenda is what somebody reads while the meeting runs, and "4.1 has two documents" is worth knowing at the moment 4.1 comes up. Pressing it jumps to that group and flashes it. The counts are recomputed whenever the list is redrawn, so moving a paper changes both places at once rather than leaving one stale.
- **Each row can be re-filed from a dropdown on itself.** A committee that has been attaching everything to the meeting has a list to sort out, and the alternative is detaching and re-uploading — which loses a file held here and leaves a second copy in Drive for one that is not. On a phone the dropdown is simply there and full width; on a computer it fades in on hover, because it is for tidying up rather than for reading.

### The rules behind it
- **An agenda id is checked against this meeting's own agenda**, on both the upload and the move. An id from another meeting would file the paper where nobody could see it, and the symptom — "I attached it and it vanished" — is miserable to chase. Anything unrecognised is refused rather than quietly ignored.
- **`ON DELETE SET NULL`, not `CASCADE`.** Removing a วาระ must not destroy the paper somebody attached to it. The paper falls back to the meeting, where it can be seen and re-filed. Checked in both suites.
- **Moving is allowed to whoever may remove**: the person who attached it, and whoever runs the meeting. Filing is a lighter act than removing so nothing stricter is warranted, and anything looser would let one invitee reshuffle another's papers.

### Tests
- **run.mjs §92 is new (17 checks)**: the default staying null, filing at upload time, a foreign agenda id refused on both paths, moving to a วาระ and back, a stranger refused the move, and — the one that matters most — two papers surviving the deletion of the วาระ they were filed under. **1401 checks.**
- **`dev-tests/agenda.mjs` extended (14 checks)**: it already builds a meeting with a real agenda, so the papers box is tested on the same one. ทั้งการประชุม offered first and pre-selected, the list splitting into groups once something is filed, the heading surviving when the single group is a วาระ, the count appearing on the agenda row, and the count following a move rather than going stale.

## 2026-10-22 — the committee's own voice · version `2026-10-22c`
Schema **`2026-10-22c`** (migrates itself: five new tables, one new sequence). Still 12 functions.

Three features in one release, and they share a principle worth stating because it decided every detail below: **reporting is open to everybody; interrupting everybody is open to almost nobody.**

### Reporting a bug, suggesting a feature — `#/reports`
A fault used to reach me as a message in a LINE group, which is to say it reached me if I happened to be reading. The report scrolled away, the screenshot expired, and nobody could tell whether the thing had been fixed, dismissed, or simply missed. Five people would report the same fault, each certain they were the first.

**Anybody may file one**, including a สมาชิกฝ่าย who cannot create a task — the people who find bugs are the people doing the work, and making them ask a ประธานฝ่าย to pass it on is how a fault goes unreported.

The form's field order is the argument of the whole feature. **"ตอนนั้นกำลังทำอะไรอยู่" comes before the description**, because it is the single most useful sentence in any bug report and the one people leave out when the form is a blank box. Asked first, it gets answered; asked last, it gets skipped. Up to three screenshots. The page fills in the route, the browser, the screen size, whether they are in the installed app, and the build they are actually running — and **shows them that line before they send**, because quietly attaching facts about somebody's device to something they wrote is not a thing to do behind their back.

**The duplicate check is live.** As somebody types a title, anything already open that matches appears underneath with a **เจอเหมือนกัน** button. Matching is by word overlap, not substring: "กดปุ่มบันทึกไม่ได้" and "ปุ่มบันทึกกดไม่ติด" are the same fault and share no substring. Five people reporting one thing becomes one report with five people on it — less to read, and better evidence.

**Urgent wakes people, so it is constrained.** The reporter ticks it (they are the one standing in front of the broken thing) and an admin can raise or lower it afterwards. Only a BUG can be urgent — a suggestion, however good, is not an emergency, and allowing it to be marked as one would teach everybody to ignore the alert. The form says plainly that the tick wakes people up.

**Many people hitting one thing is itself urgent.** At five **เจอเหมือนกัน** the rota is told once — once ever, hence `nudged_at`. Told, not escalated: the severity stays an admin's to set, and a counter should not be able to wake people night after night. The same five promotes a report one severity band in the ordering, so a เรื่องเล็ก six people hit sorts above a ติดขัด one person hit, but can never outrank a genuine ใช้งานไม่ได้เลย.

**Who sees what.** Everybody sees the list — title, kind, how many hit it, what became of it. That openness is doing a job: it is how a duplicate gets caught and how the committee can see that reporting something here leads somewhere. Held back to the rota and the reporter: the screenshots (whatever was on somebody's screen may be a letter or a private message), the browser line, and the triage notes.

**The reporter hears back.** When a state changes they get a notice with the admin's note. Without it the feature quietly dies: somebody reports two things, hears nothing either time, and reasonably concludes that reporting is a way of talking to yourself. A severity being *lowered* tells them nothing, on purpose — "your report has been downgraded" would mostly teach people not to tick the box honestly.

### Who gets woken: the rota
**จัดการผู้ใช้ is not where this lives** — it is a button under the daily summary. Admins are always told and are listed without a checkbox, because a tickbox you cannot untick is worse than a sentence saying so. An admin adds **co-admins only**: being woken at night by a broken page is a job with power attached. A co-admin cannot add themselves. Anybody on the rota can read every report in full at any time, which is what Jade asked for.

### The daily summary
A tab on the reports page with one **คัดลอกทั้งหมด** button. Plain text, assembled by the server so what gets pasted is the same whoever pastes it, in two groups: **ของวันนี้**, and **ยังค้างอยู่จากก่อนหน้านี้** — a report filed on Tuesday and ignored on Wednesday is the one most likely to be ignored again, and a summary showing only today's arrivals is how that happens. Each entry carries the code, what they were doing, the device, the version and whether a screenshot exists. The day is worked out in Bangkok time by the database, so "today" means the same day to everybody reading it.

### The pop-up — admin / co-admin only, on the announce page
A notice in LINE reaches whoever is reading LINE; a notice in the bell reaches whoever presses the bell. Neither reaches somebody who opened the app to check their own tasks, which is the one moment nearly everybody passes through. So this is the most intrusive thing in the app, and therefore the most constrained:

- **Once per person** (`popup_seen`), unless the author deliberately chooses daily or every-load. A notice that reappears every visit is one people learn to dismiss before reading — and once they have learnt that, the next one does not work either.
- **It ends by itself.** Every pop-up has a window, so nobody has to remember to take down the notice about last Tuesday.
- **Only one box at a time**, even with three live. Two stacked over the page is how somebody dismisses both unread.
- **Three live at most.** More than that and it is a queue, not a notice.
- **A tap on the background does not close it.** Every other dialog in the app closes that way because every other dialog is something the person asked for. This one they did not.
- Text, an optional poster, an optional link, and an audience — whole committee or chosen ฝ่าย, through the same `resolveAudience` the announcements use, so a ฝ่าย pop-up reaches that ฝ่าย and nobody else (the 11 October lesson, not re-learnt).

The editor shows a **live preview at a phone's width**, because a notice that fits a laptop and takes two screens on a phone is the mistake this is here to catch. The poster's real pixel size is read out of the file's header (PNG, JPEG and WebP, by hand — a dependency for reading two integers is a dependency to maintain for a year) and used to reserve the box's height, so it does not grow as the picture lands and move the dismiss button out from under a thumb. Editing the words keeps the picture; `image: null` removes it. **ให้คนที่เคยเห็นแล้วเห็นอีกครั้ง** is a deliberate choice rather than something inferred from what changed — only the admin knows whether a correction is worth interrupting people twice. Each one reports how many of the committee have seen it and how many followed the link, which is the only honest measure of whether it worked.

### The shelf of important documents — `#/shelf`
Every committee keeps its paperwork as a pinned LINE message with fourteen Drive URLs in it, and it fails the same way every year: the template everybody needs is the eleventh line of a message from September, so people stop looking and ask in the group chat, and somebody answers with the link, and next week somebody else asks again.

Folders inside folders, like Drive, because that is the shape people already think in. **One table for both** (`kind`, `parent_id`) — which is what makes moving things free: dragging a whole folder of แบบฟอร์ม into another is one UPDATE of one column, exactly like moving a single link. Six levels deep at most, not for a technical reason but because past that the breadcrumb no longer fits on a phone, which is where a filing system stops helping.

**A branch can belong to one ฝ่าย.** Null means the whole committee; set, it means that ฝ่าย plus anybody who sees across ฝ่าย anyway. อำนวยการ 2's internal paperwork does not belong on everybody's shelf, and without this the page fills with other people's folders until it is as unusable as the pinned message was. Somebody may only scope a branch to a ฝ่าย they are in — otherwise "put this in อำนวยการ 2's folder" becomes a way to hide a link from everybody including อำนวยการ 2. **A node whose parent is hidden is hidden too**, however permissive its own scope: a link inside that folder is inside that folder, and showing it loose at the root would be a leak dressed up as a convenience. The count on a folder counts only what the viewer can see — "8 รายการ" that opens on three reads as something being kept from them.

Members read all of it and add none of it, for the same reason they cannot create a task. Whoever added something can change it, plus admins — deliberately not everybody who may add, or any Editor could quietly reorganise another ฝ่าย's folder. **A folder with things in it is an admin's to delete even for whoever made it**, because by then other people have filed things in it. The confirmation says how many go with it: "ลบโฟลเดอร์นี้ไหม" is a question people say yes to; "ลบโฟลเดอร์นี้ และ 19 รายการข้างในไหม" is a question they read.

Folders are `<button>` and links are `<a>` — not cosmetic: an anchor is what gives "open in a new tab" on a middle-click and a long-press menu on a phone, which is how a page of links actually gets used. Addresses go through the app's own `safeUrl`, so a `javascript:` address never reaches a shelf the whole committee clicks without looking. Each link is labelled by its host rather than by ninety characters of query string.

### Also in this release
- **`เสื้อโครงการ` added to the org chart** (`lib/departments.js`, under อำนวยการ 1). The contact-list sheet has had that unit for a while; the code did not, so its ประธาน had nowhere to be filed.
- `test/e2e.mjs` and `DEPLOY.md` deleted at last — both were Slack-project leftovers that could not run and shipped inside the deployment.

### Tests
- **run.mjs §91 is new (86 checks)** covering all three: a member reporting, a suggestion refused urgency, a non-image refused, who may read the private half, the rota's gate on triage and on the summary, the reporter being told what became of it, a lowered severity telling nobody, the nudge firing once at the threshold, duplicate handling, the summary's contents and ordering, the pop-up's once-per-person and per-ฝ่าย behaviour, the three-live cap, the picture surviving a words-only edit, and the shelf's depth limit, move-into-itself refusal, ฝ่าย scoping, cascade delete and reordering. **1384 checks.**
- **`dev-tests/voice.mjs` is new** — the browser side, because each feature has a part that exists only there: the live duplicate check as a title is typed, the pop-up refusing to close on a background tap, the preview tracking what is typed at a phone's width, the breadcrumb walking back out of a folder, and all of it at 390px with a thumb-sized เจอเหมือนกัน.
- **`dev-tests/quiet.mjs` now stubs the pop-up endpoint for every other suite.** A live pop-up outlives the run that made it and lands over whatever page the next suite is driving, failing it with "intercepts pointer events" — a failure that looks nothing like its cause, and exactly how links.mjs's leftover QR code used to break the following run. Answered at the network edge rather than with a flag in app.js: it is a fact about the test browser, not a behaviour the app should carry. `voice.mjs` opts back in and clears its own fixtures at both ends.

**Two bugs the tests found, both real:**
- The pop-up was gated on the getting-started guide being *finished*, so anybody who never linked LINE — a large part of the committee, permanently — would never have seen a notice at all. Now it is gated on whether a dialog is actually on screen when its turn comes: the guide still wins a first visit, and it gives up rather than queueing behind whatever is open, because a box appearing the instant something else closes is dismissed by the same movement.
- The report detail drew its screenshot strip from the count, which is in the open half of the payload — so somebody who may not fetch the images got a row of broken pictures and a row of 403s. Now gated on the detail itself having come back.

## 2026-10-22 — cuftm-2026-10-22b-pdf-reader.zip · version `2026-10-22b`
No schema change (`2026-10-18a` still). Still 12 functions. Includes 10-22a.

### Reading a letter without leaving the app, and a real download
The file chips were ordinary links with `target="_blank"`. On a computer that opens the browser's PDF viewer, which is fine. On a phone it hands the file to whatever reader the system picks — and for anyone who installed this to their home screen there is then **no address bar, no back button and no app**: the way back is to close the whole thing and sign in again. There was also no obvious way to save a copy.

So a PDF chip now opens a reader **inside the app**: the page drawn with the pdf.js the app already ships, a pager when there is more than one page, and two buttons — **ดาวน์โหลด** and **ปิด**. The browser's own viewer is still offered, as a quiet **เปิดในแท็บใหม่** link above the page rather than a third button (a third button wraps onto its own row on a phone and pushes ปิด off the bottom of the screen, which is the exact trap this is meant to end).

On a phone the way out is the ✕ in the header, and the sheet drags down to dismiss — the app already hides a footer "ปิด" that only repeats the ✕, and the reader follows that rule like every other dialog.

**The download is a real download.** `&download=1` on the file endpoint serves the PDF as an `attachment` rather than `inline`, and the button fetches the bytes and hands over a blob, which is the one approach that behaves the same in Safari, in Chrome and inside an installed app. The file lands under a name worth having: **the เลขรันเอกสาร first**, then the title — that number is how the committee refers to the letter everywhere else, so it is what somebody will search their downloads folder for.

The Word original is unchanged: it was always a straight download, because nothing renders a .docx in a tab.

A file that has been archived to Drive, or removed when a letter was sent back, says so in the reader with a link to Drive where there is one, instead of a blank page.

### Tests
- run.mjs: five checks — the PDF served `inline` for the reader, `&download=1` serving it as an attachment, the name leading with the เลขรันเอกสาร, the same bytes either way, and the flag not being a way around who may see a file. 1298 checks.
- `dev-tests/pdfread.mjs` is new: on a computer, the chip opens the reader rather than a tab, the page draws, the footer holds exactly ดาวน์โหลด and ปิด, the download really is an attachment, and closing returns to the letter. On a phone, the page fits 390px with no sideways scroll, the ✕ is on screen and thumb-sized, the duplicate ปิด stays hidden, ดาวน์โหลด sits above the home indicator, and tapping ✕ returns to the letter.

## 2026-10-22 — cuftm-2026-10-22a-shortlink-domain.zip · version `2026-10-22a`
No schema change (`2026-10-18a` still). Still 12 functions.

### Short links and their QR codes move to chulafair.com
The app lives at **task.chulafair.com**; the short links now live at **chulafair.com**, which is the point of having a short domain — it goes on a poster and gets read aloud across a room.

`shortlinkUrl()` (lib/line.js) reads a new **`SHORTLINK_URL`** and falls back to `siteUrl()` when it is unset, so nothing changes for anyone who does not set it. `?do=link` builds every `shortUrl` from it, and because the page draws the QR and the A4 print sheet from that same value, both follow with no change of their own.

The loop check follows too: `siteHosts()` now counts the short-link host as this site, so a link pointing at `chulafair.com/s/ABC` is refused like any other self-reference.

**To turn it on:**

1. **Vercel → Settings → Domains:** add `chulafair.com` to this same project. By default Vercel redirects a non-primary domain to the primary one, which works — `chulafair.com/s/ABC` → `task.chulafair.com/s/ABC` → the target — but it is one hop longer and the person watching the address bar sees the app's domain. Turning the redirect off, so `chulafair.com` serves the project directly, keeps the short address all the way through. Either is fine; the direct one is better.
2. **Vercel → Settings → Environment Variables:** `SHORTLINK_URL` = `https://chulafair.com` (Production). **Then redeploy.**

**Links already printed keep working.** Codes live in the database, not in the domain, so every old `cu-ftm.vercel.app/s/CODE` poster still resolves as long as that domain stays on the project — and the page now prints the new address for anything made from here on. Nothing was renumbered.

### Tests
Five new checks: short links staying put with `SHORTLINK_URL` unset, moving when it is set (trailing slash trimmed), the printed address and the QR taking that value, the app still advertising its own address everywhere else, and the short-link host counting as this site in the loop check. 1293 checks.

## 2026-10-20 — cuftm-2026-10-20a-domain.zip · version `2026-10-20a`
No schema change (`2026-10-18a` still). Still 12 functions.

### Moving to task.chulafair.com

**The move itself needs no code.** Every address the app hands out — short links, the QR codes beside them, the links the LINE bot sends, push notifications — comes from `siteUrl()` in `lib/line.js`, which reads `SITE_URL` and falls back to whatever Vercel calls the deployment. Set the variable and everything follows.

Four settings, in this order:

1. **Vercel → Settings → Environment Variables:** `SITE_URL` = `https://task.chulafair.com` (Production). **Then redeploy** — a variable only reaches deployments created after it was saved.
2. **Vercel → Settings → Domains:** make `task.chulafair.com` the **primary** domain so `cu-ftm.vercel.app` redirects to it. Every QR code already printed keeps working: the redirect carries the `/s/CODE` path across.
3. **Google Cloud console → the OAuth client:** add `https://task.chulafair.com/api/auth?do=google-callback` to the authorised redirect URIs. Keep the old one until nobody is on the old address. Without this, linking Google Calendar fails with a redirect-URI mismatch.
4. **LINE Developers → Messaging API:** change the webhook to `https://task.chulafair.com/api/line`. The rich-menu and chat links need nothing — they are built from `SITE_URL`.

Two things to expect. **Everybody signs in again:** the session cookie is host-only (no `Domain=`, deliberately), so a session on the old address does not carry to the new one. And **calendar subscriptions made on the old address keep working**, because the old host still resolves; new ones are issued on the new address automatically, since the page builds that link from wherever it is being viewed.

### The one thing the move does break, fixed here
A short link may not point at another short link on this site — a pair of them is a redirect loop the browser gives up on. That check compared the target against the ONE address the app advertises. After the move, `cu-ftm.vercel.app/s/ABC` reaches the same `/s/` and would have sailed through.

`siteHosts()` (lib/line.js) now lists **every** address this deployment answers on — `SITE_URL`, the Vercel production and preview hosts, and anything in a new optional `EXTRA_HOSTS` (comma-separated, for a second custom domain) — and `readTarget` refuses a `/s/` target on any of them. Somebody else's `/s/` is still a perfectly good destination.

### Tests
Six new checks: the old address and the new one both refused as self-targets, another site's `/s/` still accepted, and `siteHosts()` collecting all four sources in order while `siteUrl()` keeps advertising just the one. 1288 checks.

### Still worth deleting
`test/e2e.mjs` and `DEPLOY.md` are both from the old Slack project — `DEPLOY.md` documents setting up a Slack app and has nothing to do with this one. Neither runs; both ship inside the deployment.

## 2026-10-19d — the two 2026-10-19c builds, merged · version `2026-10-19d`
No schema change (`2026-10-18a` still). Still 12 functions.

**Two different packages were both called `2026-10-19c`** and neither contained the other. This repository held the audit pass — readable colours, the first-day home, the lighter page, the i18n split, the move to `dev-tests/`. The package shipped from the document work held the ลงลายเซ็น fix. `2026-10-19d` is this repository plus that fix, and it is the only build that has both. Anything still labelled `2026-10-19c` is half of it.

### The ลงลายเซ็น fix, brought across
The form has a **ลงลายเซ็น** tick beside every step — a head may approve a letter without their name appearing on its face. Taking the tick off removed that person from the marks page, which is right. But the tick was never sent to the server, and `createDocument` demanded a box from every step whose ROLE signs, regardless. So the form stopped asking for a box the server would not submit without, and ส่งเรื่อง answered **ต้องวางช่องลงนามอย่างน้อยหนึ่งจุด** forever, naming nobody.

- The tick is sent (`signs` per step) and honoured: a box is required from a step that is actually signing, not from a role. A step that is not signing stores no boxes.
- `MARK_REQUIRED` already carried `who`; the page now says *ยังไม่ได้วางช่องลงนามของ: …* and jumps back to that person with their tick restored.
- A letter **nobody** signs is a valid letter — approvals without stamps — and now submits.
- On the same page, two hint lines said the same thing in different words. One instruction now, above the name picker.

### Dev tooling that the move to `dev-tests/` had broken
None of this ships to users; all of it stopped the suites running at all.
- `dev-tests/srv2.mjs` resolved `./api/*` against its own folder and `test/sheet.csv` against the shell's, so it worked from no directory at all. Both now resolve against the repository.
- `dev-tests/docchain.mjs` and `dev-tests/guide.mjs` imported `./lib/db.js` — now `../lib/db.js`.
- `dev-tests/links.mjs` loaded `node_modules/jsqr/...` from the shell's directory — now from the repository.
- `dev-tests/phone.mjs` asked for the size of an RSVP button on a meeting that had already started; since 18 October there are none, so it waited thirty seconds and threw.
- `dev-tests/polish.mjs` assumed Fah had no tasks, which `phonesweep.mjs` quietly makes untrue. It now empties her first, so run order stops mattering.
- `test/e2e.mjs` is left alone but is dead: it imports `@slack/bolt` and `../src/listeners/index.js` from the old Slack project, neither of which exists here. It cannot run and it ships inside the deployment. **Worth deleting.**
- New suites: `dev-tests/movesig.mjs`, `dev-tests/revive.mjs`, `dev-tests/signsoff.mjs`.

### Tests
1283 API checks, 27 browser suites, all passing against this tree.

## 2026-10-19c — readable colours, a first-day home, a lighter page

Built from the audit of 2026-10-19. All 15 findings were addressed; #13 only partly (see below).

### Live bugs fixed
- **Due-date chips in dark mode.** `.due-chip.u-now/u-soon/u-ahead` used fixed light colours, so in dark mode they stayed bright pastel pills. They now use the `--u-*` tokens, which have dark values. (#1)
- **The floating + covered the last task row on a phone.** The page now leaves room for the bottom bar plus the button. (#6)

### Contrast
- The list's group headers are now the soft status pill in the status ink, ringed in the status colour. White on solid amber was 2.15:1. (#2)
- Filled buttons and the active sidebar item use `--accent` with `--accent-ink`, 5.1:1. The brand `--pink` is unchanged everywhere else; white on it was 3.96:1. (#3)
- `--ink-faint` is darker: light `#75657d`, dark `#a08ca8`. It is 4.6:1 or better on every surface. (#4)
- There is a new `--line-strong` for input, select and textarea borders, 3.3:1. `--line` was 1.26:1, so fields barely had an edge. (#4)
- Priority flags use the new `--prio-low/high/highest` tokens, with dark values. High was a 2.5:1 orange. (#5)
- `--danger` (light) is now `#c42a3f`, and `--u-now` (light) is now `#b14a06`. Both were just under 4.5:1 on their soft fills.

### What a new member sees
- **Documents, empty:** says what the page is for (letters that need a signature) and offers an upload button. Before, it said only ยังไม่มีเอกสาร. (#7)
- **Home, first day:** somebody with no tasks gets a เริ่มต้นใช้งาน card first, with three steps:
  - where their work will appear
  - link LINE and turn on notifications (opens the guide)
  - add a task, offered only to people allowed to create
  
  The four charts of zeros are hidden until they have work. (#9)
- The "รับผิดชอบ" badge is now a quiet neutral chip. It is on almost every row in ของฉัน, so it no longer competes with status. The rarer kinds (through the department, following) keep their tint. (#8)
- Stacked avatars overlap by 3px instead of 7px, so the second initial is no longer hidden ("J/" for JA). (#11)

### Page weight
- `vendor/qrcode.js` (57 KB) no longer loads on every page. `openQr` fetches it the first time a QR is opened. (#10)
- English strings moved to `public/i18n-en.js`, and `i18n.js` now holds Thai and `ERROR_KEYS` only. `ensureLang` fetches English before drawing, for people using English. A Thai user no longer downloads about 117 KB (about 32 KB compressed) of English strings and QR code on every cold load. (#14)

### One source for colour
- **Tokens (#13):** every colour token, for both themes, is declared once, in `theme.css`. `styles.css` declared its own as well. Some dark values (`--meet`, the `--u-*` ramp, `--shadow-3`) only applied because a more specific selector in `styles.css` out-ranked `theme.css`. That was silent and fragile, and is now explicit.
- **Hard-coded colours (#12):** the hex values in `theme.css` rules that had a token twin now use it: pink, indigo, amber, violet, green, teal, the plum, status inks, and the new `--teal-ink`. Text colours that stayed light-only in dark mode (best-day chip, booking slots, office-hours label) now follow the theme.
- **Not done in #13:** merging the rules of the three stylesheets into one. That is still a multi-day job, and this release does not attempt it.

### Repository (#15)
- Removed stale second copies that differed from the live files:
  - `lib/public/`, `lib/api/`, `lib/lib/`, `lib/test/`, `lib/*.mjs`
  - `cuftm-viewers/`
  - the root-level copies of `app.js`, `auth.js`, `cron.js`, `db.js`, `tasks.js`, `users.js`, and the browser suites (`dev-tests/` holds the current ones)
- `lib/` held whole old copies of the client and API, so a zip of `lib/` shipped them. Nothing imported them.

### Version
- `2026-10-19c` in `lib/version.js`, `var APP_VERSION` in `public/app.js`, and every `?v=` in `public/index.html`.

### Tests
- **`test/run.mjs` §90 (new, 13 checks):**
  - no colour tokens in `styles.css` or `phone.css`
  - the two dark blocks are identical
  - every text pair meets its contrast floor, in both themes
  - due chips use tokens
  - group header and button colours
  - room under the +
  - QR library and English strings not in `index.html`
  - no stale copies left
- The string checks now read `i18n.js` and `i18n-en.js` together.
- **`dev-tests/polish.mjs` (new browser suite, 16 checks):**
  - a Thai sign-in loads neither file, and English loads once on switching
  - group header and badge colours
  - dark-mode due chips
  - the last row clears the + on a phone
  - first-day home, for a member and for a person with work
  - documents empty state
- **`dev-tests/redesign.mjs`:** the group-header check now expects the soft pill. The office-hours booking check matched the literal day numbers 12–19, so it failed every week after the one it was written in; it now finds next Monday's column by its date.
- **`dev-tests/guide.mjs`:** loads `i18n-en.js` before comparing the two languages.
- **Results:**
  - API suite: 1,277 checks pass.
  - Every browser suite passes. Each ran on its own against a freshly reset database, never at the same time as `run.mjs`.
  - `avail.mjs` failed one check when it ran straight after other suites, because of data they left behind. It passes run alone after a reset.

---

# Running history (from the document work)

The entries below were written against the packaged zips rather than this repository, so their file layout differs — the code they describe is in here.

## 2026-10-19 — cuftm-2026-10-19c-signs-tick.zip · version `2026-10-19c`
No schema change (`2026-10-18a` still). Still 12 functions. Includes 10-19a and 10-19b.

### Bug: unticking ลงลายเซ็น made a letter impossible to submit
Reported from the committee with a screenshot: **ต้องวางช่องลงนามอย่างน้อยหนึ่งจุด** on a form where every signer shown already had a box (✓2), and pressing ส่งเรื่อง again never helped.

The form has a **ลงลายเซ็น** tick beside every step — a head may approve a letter without their name appearing on its face. Taking the tick off removed that person from the marks page, which is right. But the tick was never sent to the server, and `createDocument` demanded a box from every step whose ROLE signs, regardless. So the form stopped asking for a box the server would not submit without, and the dialog was a dead end with no way out but going back and re-ticking — which nobody would guess, because the message named nobody.

Three parts to the fix:
- **The tick is sent** (`signs` on each step) and the server honours it: a box is required from a step that is actually signing, not from a role. A step that is not signing stores no boxes at all.
- **The refusal names people.** `MARK_REQUIRED` already carried `who`; the page now says *ยังไม่ได้วางช่องลงนามของ: …* and jumps back to that person with their tick restored, instead of a sentence pointing at nobody.
- A letter **nobody** signs is a valid letter — approvals without stamps — and now submits.

Also on that page: the two hint lines said the same thing in different words. One instruction now, above the name picker, and the "tap again to remove" note sits under it.

### Tests
- run.mjs: six new checks on the ลงลายเซ็น tick — a step told not to sign needs no box and keeps none, a signing step with no box is still refused *and named*, and a letter nobody signs goes through. 1271 checks.
- `signsoff.mjs` is new — the browser side of exactly what was reported: untick one signer in the real form, place the remaining box, press ส่งเรื่อง, and the letter is submitted with that step recorded as approving without a signature.

## 2026-10-19 — cuftm-2026-10-19b-revive-rejected.zip · version `2026-10-19b`
No schema change (`2026-10-18a` still). Still 12 functions. Includes everything in 10-19a.

### The signature on a letter belongs to the printed name — always
**This reverses yesterday's rule, and yesterday's rule was wrong.** When somebody stood in on another person's step, their own signature was stamped. The name under the box is typed into the letter by whoever wrote it, so one admin pressing for four ประธานฝ่าย produced the same handwriting under four different names — a letter reading "(นายปรเมศวร์ เอื้อวุฒิเกริก)" over somebody else's signature is not a letter anybody can send.

So `approve()` now stamps `step.username`'s signature, with no fallback: if that person has not saved one, the press is refused and says whose signature is missing, rather than quietly substituting the presser's.

Who really pressed is still recorded and still shown — **ดำเนินการโดย …** in the history, with their face — which is where that fact belongs. **มอบอำนาจให้เซ็นแทน** no longer decides the image (nothing does but the printed name); it is now the owner saying in advance who may act for them, and the history notes whether there was an authorisation. The wording on the profile says so.

**Letters already signed the wrong way fix themselves.** The mismatch between the recorded signer and the step's own person is the only way to find them, so the migration deliberately leaves it alone: the first time anybody opens such a letter, the record is corrected and the PDF re-stamped from the untouched original, once, and the history gets a `signature_corrected` line.


### A rejected letter can be brought back, with the signatures it already had
A **ตีกลับ** used to be the end of a letter. The PDFs are deleted, so a correction meant a brand-new document and a brand-new chain — which meant everybody who had already signed signed the same page a second time, over a wrong date.

What the rejection never deleted is the part that matters: the chain, who had already approved, and the exact rectangle each signature sits in. So reviving is just **putting the corrected PDF in**: `?do=revive` writes the new original, re-stamps the signatures already given from that record (`rebuildSigned`, same as everywhere else), and hands the letter back to its chain. The button is on the rejected letter itself — **อัปโหลดไฟล์ที่แก้แล้ว (กู้ลายเซ็นเดิม)** — with a line under it naming whose signatures are coming back, so it is not a leap of faith.

- **The step that said no is asked again.** It goes back to `waiting` with its comment cleared: it is a question about a file that did not exist when it was answered. The reason stays in the letter's history for good.
- **Nothing before it moves.** Those people approved this letter and are not asked twice — that is the whole point.
- **Who may:** เลขานุการ and whoever sends that particular letter, Co-Admins, Admins, and the person who wrote it (they are holding the corrected file). `canRevive` in lib/approval.js.
- **A file too short is refused before anything is written**, naming the page it needs — a signature silently dropped off the letter would be worse than being told to fix the file.
- A **เลขรันเอกสาร** already handed out goes back to อยู่ระหว่างอนุมัติ / รอเลขานุการ in the register rather than being left saying ตีกลับ for a letter that is being signed again.

### Tests
- run.mjs §89 is new (21 checks): the rejection deleting the PDFs, all four kinds of person who may revive and one who may not, the signatures coming back, the rejecting step clean and waiting while the approvals before it stand, the reason still in the history, the letter approvable for real afterwards, and a too-short file refused without half-reviving anything. 1258 checks.
- `revive.mjs` is new — the browser side, end to end: the director sends a letter back, the writer sees the button and the line saying whose signature returns, uploads the corrected PDF, and the letter is signed and back with the director.
- §87 rewritten for the new signing rule: pressing for somebody who has saved no signature is refused and names them, and the signature that lands is the step owner's. Four new checks cover the self-healing of a letter signed under the old rule — record, file and history. 1265 checks.

## 2026-10-19 — cuftm-2026-10-19a-move-signature.zip · version `2026-10-19a`
No schema change (`2026-10-18a` still). Still 12 functions.

### A signature can be moved after it has been stamped
Asked for on 19 October. A box is placed before anybody has seen the finished page, so the first time it is obvious that a signature sits across a line of text is *after* it has gone on — and until now the only way out was **ตีกลับ**: four people re-approving a letter whose words nobody disputed, because a box was two centimetres too low.

On an approved signing step the history now carries **ย้ายตำแหน่งลายเซ็น**. It opens the same canvas the boxes were placed on at upload, on that one signer: tap to move it, tap the box to take it away, the slider resizes it, and the pager walks the pages. Saving posts `?do=move-mark`.

Why this is safe in a way that re-approving is not: the signed copy is **always rebuilt from the untouched original** (`rebuildSigned`), so nothing about who agreed to what changes — the state, the time and the author of every approval are left exactly as they were, and the letter ends up as it would have if the box had been right the first time. Checked in both suites.

Who may: the owner of the signature, whoever stood in for them, the person who **wrote** the letter (they placed the boxes and are the one chased to fix them), and admins — `canMoveMark` in lib/approval.js. Never once the letter has been **sent**: from that moment the recipient holds the record and this copy has to match it. Never on a step still waiting, or one that approved without stamping.

The record keeps up: the move is written into the letter's history as `mark_moved` with the name of whoever did it, and if somebody else moves **your** signature you get a bell about it. It is your name on the page; being able to fix a box without re-running the chain should not mean it can be fixed behind your back.

### Tests
- run.mjs §88 is new (18 checks): the button appearing only on a stamped step, the move landing exactly where it was put, the approval and the letter's position in its chain untouched, the stamped copy rebuilt, the history line, several spots at once, a stranger refused, a page that does not exist refused, emptying every spot refused without disturbing the letter, and a sent letter closed to it on the server as well as in the page. 1237 checks.
- `movesig.mjs` is new — the browser side: the button on the right step and not on a waiting one, the editor showing the real signature with slider and pager, a tap moving it, and saving re-stamping the letter for real.
- Two suites that only failed depending on the clock and the calendar, both fixed rather than worked around: `phone.mjs` asked for the size of an RSVP button on a meeting that had already started, and since 18 October there are none to ask about, so it waited thirty seconds and threw; `redesign.mjs` picked the office-hours column with `/12|13|…|19/`, which on a day that is itself a Monday picks **today** instead of next Monday — it now finds the column by its date.

## 2026-10-18 — cuftm-2026-10-18a-approvals-word5mb.zip · version `2026-10-18a`
Schema **`2026-10-18a`** (migrates itself: two columns on `doc_steps`, one new table). Still 12 functions.

### Anybody in a letter's chain may approve or bounce it, at any stage
`canAct` (lib/approval.js) used to mean "the person whose step it is". It now means **anybody named anywhere in that letter's own chain**. A letter that had to go out on Friday sat waiting on one ประธานฝ่าย who was in an exam, and the people above and below them — all of whom were going to approve it anyway — could only watch.

Two things this is not. It is **not open to the committee**: somebody with no part in the letter is still nobody's approver (run.mjs §43 checks that). And it is **not skipping ahead**: the chain still advances one step at a time, in order, and is signed the same number of times.

What the record says, because this is the part that matters:
- `doc_steps.acted_by` — who actually pressed, when that was not the person named on the step. The history shows it: **ดำเนินการโดย …** under the step, with their face.
- `doc_steps.signed_by` — whose signature went on. Normally the presser's own: the letter should show who really approved it.

### Signing as somebody else, arranged in advance
Profile → ลายเซ็น → **มอบอำนาจให้เซ็นแทน**. The owner of a signature names up to five people who may sign **as them**, for every letter, until they take it back (`signature_delegates`; `?do=delegates`). A ประธานฝ่าย going abroad arranges it once instead of per document. When a delegate presses, the owner's signature is stamped and the history still records who pressed — "ดำเนินการโดย กุ๊งกิ๊ง · ลงนามแทน เจตน์". Only the owner can hand it out, and only to an active account.

### The Word file goes to 5 MB
`MAX_SOURCE` is 5 MB. It cannot arrive in one request — Vercel refuses a body over about 4.5 MB and base64 adds a third — so anything over 2 MB is **sliced and sent in pieces** (`?do=source-part`, 1.4 MB each), appended into one row with `bytes = bytes || …`. The pieces live under `kind = 'source-part'` and only become the real `source` when the last one lands, so an interrupted upload leaves a stub nobody can open rather than half a document. Going over 5 MB part-way is refused and the previous file is left untouched. The PDF is unchanged at 3 MB.

### "กด จะเข้าร่วม ไม่ได้"
The server stops taking RSVPs the moment a meeting starts — that rule is from 11 October and has not changed. What was wrong is that the page kept offering **จะเข้าร่วม** on a meeting from last night and answered the press with "เกิดข้อผิดพลาด กรุณาลองใหม่", because `TOO_LATE_TO_REPLY` was not in `ERROR_KEYS` and fell through to the generic message. The buttons now disappear when the meeting starts, replaced by a line saying so, and the error codes are mapped for the case of a page left open since yesterday.

### Two things found while rebuilding the dev environment
Both are real, both would have bitten a fresh deployment:
- **A brand-new database could not build its own schema.** `applySchema` is written in the order the app grew, so an ALTER on `doc_steps` sits above the CREATE TABLE that first made it — which never mattered against a database that already had the tables, and stops the very first request against an empty one. `migrate` now runs the file once leniently on a fresh database (anything referring to a table that does not exist yet is skipped, which leaves every CREATE TABLE applied) and then again for real. Every statement is idempotent, so the second pass costs nothing.
- **`dev-tests/neon-local.mjs`** is new. lib/db.js talks to Neon over HTTP, which on a laptop turns `postgres://…@127.0.0.1:5432/…` into `https://api.0.0.1/sql`; the shim serves Neon's own protocol from a local `pg` pool, so srv2 and the suites run against Postgres unchanged. Development scaffolding only — nothing in api/ or lib/ imports it.

### Tests
- run.mjs §87 is new: standing in on somebody's step (and the history naming who pressed), lending a signature and the owner's signature coming out on the page, taking it back, a 4.4 MB Word file going up in pieces and downloading back byte for byte, and an over-size upload refused without disturbing the file already there. §43 rewritten for the new rule. 1212 checks.
- Two fixtures that lived in `/tmp` and died with it are now made by the suites that need them — the signature PNG in run.mjs, and sigsize's letter (it used to borrow docchain's, so a docchain failure took sigsize with it).
## 2026-10-16 — cuftm-2026-10-16a-qr-download.zip · version `2026-10-16a`
Schema unchanged (`2026-10-15a`). Still 12 functions.

### The QR download
The PNG itself was always centred — 64px of quiet zone on all four sides, measured. What was wrong was the **download**: `a.href = canvas.toDataURL()` on an anchor that was never added to the document works in Chrome on a computer and in almost nothing else. Safari opens the data URL as a page instead, showing the code on a white background flush to the top-left corner, which is what "not centred when downloaded" was. It now saves through a blob, a real anchor in the document, and `revokeObjectURL` afterwards, which behaves the same everywhere.

And since what people do with these is print them: a second button, **แผ่นพร้อมพิมพ์ A4** — A4 at 300 dpi (2480×3508) with the link's name above, the code in the middle at about 13 cm, and the full address under it. The whole block is centred, not the code alone; centring the code and hanging the text off it left 595px of paper above and 855px below, which prints bottom-heavy. Now 715 / 735.

### Tests
- `links.mjs` downloads both files and measures where the ink actually sits: the plain PNG's quiet zone equal on all sides, the sheet A4-sized, centred across and down the page, and the printed code still readable by a real decoder.
- That decode runs **inside the page**. Handing an 8.7-megapixel sheet to Node as an array of 35 million numbers ran past the suite's time limit and the process was killed — every check passed, no summary printed, and the fixture left behind for the next run to trip over.
- Which was the other fix: the suite now deletes its VOLUNTEER and LOCAL codes at the end, win or lose. A leftover code made the NEXT run fail at "making one opens its QR code straight away", which is a confusing way to be told that the last run crashed.
- `api/cron.js` gained `CRON_QUIET_HOURS=off`, a seam for the tests: day-window reminders wait for 07:00 Bangkok, so run.mjs §86 passed in the afternoon and failed after midnight until the suite could lift it.

## 2026-10-15 — cuftm-2026-10-15b-meeting-alerts.zip · version `2026-10-15b`
Schema **`2026-10-15a`** (migrates itself: one new column). Still 12 functions.

### Meetings now tell people
Meetings were the one thing in the app that never said anything — an invitation appeared on the page and that was it.
- **When you are invited**, and when somebody is added to a meeting that already existed.
- **When it moves**: the day, the time or the place. The notice names which of the three changed and says "was → now". Editing the note or the agenda buzzes nobody.
- **When it is cancelled or deleted** — told before the row is removed, because afterwards there is nobody left to tell.
- **Before it happens**: 3 days / 1 day / 1 hour, ticked per meeting (a day and an hour are on by default), in the meeting form under เตือนก่อนประชุม. Day windows wait for 07:00 Bangkok; the hour one fires in the hour before. A meeting with no time set cannot use the hour window. Reminders go once per person per window (`reminders_sent`, shared with tasks and events).
- New **ประชุม** category in notification settings, and a per-meeting notification control in the meeting's summary — the same one tasks and documents have.
- The column: `meetings.notify`, default `'1d,1h'`. An empty string means "no reminders", which is why the code reads it with `??` and not `||` — `|| '1d,1h'` turned "none" back into the default, and the test caught it.
- Everything goes through `sortRecipients`, so somebody who has turned ประชุม down to the bell gets the bell and no buzz.
- **The bell row is always 'normal'**; only the push is raised for a cancellation. An urgent row opens a dialog over whatever the person is doing the next time they load the page — that is for an announcement somebody chose to send urgently, not for a meeting being moved. Four browser suites failed with "intercepts pointer events" before this was fixed, which is what that mistake looks like from the outside.

### The LINE morning summary is off
`sendDigests` returns immediately unless `LINE_DIGEST=on` is set. It was the only message this app ever paid LINE for, and between the bell, push and the bot answering "งานของฉัน" on demand it was one channel too many. The code and everybody's saved preference are untouched, so setting that variable brings it back exactly as it was. The switch is gone from the profile page (it promised a message that would not arrive) and the bot's เปิด/ปิดสรุป commands now say plainly that nothing is being sent.

### Tests
- run.mjs §86 is new — invitation, what-moved wording, a silent save, somebody added later, the day-before reminder firing once for everybody, reminders switched off per meeting, cancelling, deleting, and somebody who has silenced ประชุม hearing nothing. 1200 checks.
- §33 keeps the digest machinery under test by turning it on with `LINE_DIGEST=on`, after first checking that it sends nothing with the switch off.
- `oct14.mjs` §11 covers the form's reminder checkboxes and the invitation landing in the bell.

## 2026-10-15 — cuftm-2026-10-15a-task-permissions.zip · version `2026-10-15a`
Schema unchanged (`2026-10-11b`). Still 12 functions. Who may do what to a task changed, so this one is worth reading before deploying.

### ผู้รับผิดชอบ may edit the task
`canEditTask` (lib/scope.js) is now **the creator, the people it was given to, and the admins**. The people doing the work were left out and it was wrong: they are the ones who find out that the deadline moved or that half the description is missing, and routing that back through whoever typed the task is how a tracker stops matching the work.

What did **not** move, deliberately — these all sit on a new `runsTask` (creator + admins):
- **Deleting.** It takes the work off everybody else's list and there is no undo. The button only shows for whoever may actually do it (`mayDelete`, new on every task the API returns).
- **Sub-tasks.** Cutting the work into pieces is deciding what the work is; somebody handed one piece should not be re-cutting the others.
- **Ticking off somebody else's piece**, and **removing somebody else's attachment**.

**ผู้ติดตาม (viewers) are unchanged**: they see it, they may move the status if they are tagged, and they may not edit. Being asked to follow something is the opposite of being asked to do it.

A member who is on a task may now rewrite it — but still cannot create work, and still cannot change who is on it (`cannotAssign` is a separate lock and did not move).

### An Editor sees งานทั้งหมด
`canSeeTask` now returns true for anybody at Editor level or above. A ประธานฝ่าย needs to know what the other ฝ่าย are doing to the same deadline, and "your own departments only" meant asking in LINE for something the tracker already knew.
- It is **visibility only**. Editing still follows `canEditTask`, so seeing another ฝ่าย's task comes with no power over it — run.mjs §85 checks exactly that.
- Below Editor nothing changed: a unit editor and a member still see their own department, their own work and what they were tagged in.
- The page follows: the sidebar lists every ฝ่าย for them, the department filter on งานและกิจกรรม offers every ฝ่าย, and the "you only see your own departments" line is gone for them. Filing is still restricted — `myDepartments()` decides where work may be put, and that did not change.

### Tests
- run.mjs is 1184 checks. §11 now reads as "department access decides where you may FILE, and what a unit editor or member SEES" and measures the umbrella grants through `myDepartments` rather than through what is visible; §20 asserts the new editing circle and the watcher's lack of it; §85 is new.
- `oct14.mjs` gained sections 9 and 10 for both rules, including the edit button appearing and the delete button not, and is midnight-proof now (its "finished meeting" fixture is worked out in minutes — run at 00:20 the old one produced a meeting that had not started).

## 2026-10-14 — cuftm-2026-10-14a-notice-ui.zip · version `2026-10-14a`
Schema unchanged (`2026-10-11b`). Still 12 functions. New runtime dependency: **pdfkit**.

### หนังสือนัดประชุม, generated
A meeting's own page now makes the notice: **สรุปการประชุม → หนังสือนัดประชุม → สร้างไฟล์ PDF** (`/api/events?do=notice&id=…`, anybody who can see the meeting; 403 for anybody who cannot).
- Organisation, ที่/วันที่, เรื่อง, เรียน, when and where, the **whole ระเบียบวาระ** with its numbering, durations, details and who proposed each item, the closing line, a signature block, and the invitation list including outside guests.
- Dates are written in full Thai with the Buddhist year ("วันพฤหัสบดีที่ 15 ตุลาคม 2569").
- Set in **TH Sarabun New** — the free national font, subsetted to Latin + Thai in `lib/fonts.js`.
- Two traps, both hit and both worth knowing. **pdf-lib cannot do this**: it draws the glyphs a string maps to and applies no layout, so every Thai tone mark lands in the high position and "ผู้เข้าร่วม" prints as "ผูเขารวม" with the marks floating a line above. pdfkit runs text through fontkit's shaper, which is why the notice uses it while the signing code stays on pdf-lib. And the **TH Sarabun New on npm is a webfont conversion with the Thai GSUB stripped** (`latn` only), which fails the same way in any engine — the font here is the original, subsetted with `pyftsubset --layout-features='*' --no-hinting` (830 KB → 62 KB).

### The UI round
- **Document page time zone.** The server sends UTC and the page read the date and clock straight out of that string, so a letter signed at 17:05 showed 10:05 and anything after 7pm was filed under the day before. New `bkkStamp` / `stampDate` / `fmtStamp` in app.js; every stamp on the เอกสาร page and the notification popup is Bangkok wall time now, whatever the laptop's clock says.
- **ที่กำลังจะถึง drops things that have finished.** It compared dates only, so the 17:00 meeting sat at the top of the page all evening. A meeting or event is "coming up" until its end time (or an hour after it starts, when no end was given); all-day things stay all day. A page left open redraws itself every five minutes, so a tab opened in the afternoon is right at nine — it never re-fetches, it only re-reads what it has.
- **Long people lists fold on a computer too.** Eight watchers were four wrapped lines above the thing the task was opened for. Over six (four on a phone) collapse to a row of faces and a count, opening on a tap — the control existed but its CSS was phone-only.
- **One bar for เสนอวาระ.** Five standing วาระ meant five identical "title · minutes · เสนอวาระ" rows down the dialog, and which one you were typing into was worked out from how far down it was. One bar at the end, with the วาระ as its first field. Both the new-meeting form and a saved meeting.
- **A LINE OA step in the guide.** Between installing and notifications when LINE is configured: the Official Account's QR (drawn by LINE), its @id, an add-friend button, and the linking code — all in one card. `lib/line.js` gained `botProfile()`, which asks LINE for its own basicId rather than needing another env var.
- **เวลาของสัปดาห์นี้** fits its card: "8 ชม. 30 นาที" ran over the ring and into the legend on a computer. The ring holds the number, the line below says what it is, and the legend's labels wrap with the figure aligned right.
- **The profile uses the page.** It was a 34rem column with two thirds of the window empty beside it and nine settings boxes stacked below the fold. Two columns on anything over 1000px — who you are on the left, what the app does for you on the right.
- **จัดการผู้ใช้: order and filters.** The list was alphabetical, which put a สมาชิก above the ประธานโครงการ. It now sorts by access level, then board-wide access, then whether they head a ฝ่าย, then the department's place in the org chart, then the name — and anybody inactive or suspended sinks to the bottom. Three dropdowns beside the search box (ฝ่าย, สิทธิ์, สถานะ) with a count of what is showing.

### Tests
- New browser suite `dev-tests/oct14.mjs` — all eight sections above — added to the suite list. 1177 API checks still pass.
- `agenda.mjs` rewritten for the single bar, `guide.mjs` for the LINE step, `features.mjs`'s height limit raised by one day heading. `jsqr` is back in devDependencies — an `npm install` had pruned it and `links.mjs` could not start.
- Watch out: a crashed suite leaves its fixture behind (`links.mjs` and the VOLUNTEER code, `redesign.mjs` and its bookings). A failure that makes no sense is worth checking against the database before it is treated as a regression.

## 2026-10-11 — cuftm-2026-10-11c-signatures-scheduling.zip · version `2026-10-11c`
Schema unchanged (`2026-10-11b`). Still 12 functions.

### The pink box is the signature now
Placing a signature meant dragging a flat pink rectangle and hoping. Both sides can see the real thing instead.
- The placement boxes draw the signer's **actual signature image**, at its own proportions: `sigBoxSize()` solves the box height from the saved PNG's aspect and the page's, so what is on screen is exactly what `stampSignatures` will print (`fit()` centres it the same way `object-fit: contain` does). A box set at 26 % of the page width for a 3.5:1 signature comes out 3.5:1 — measured in the test, not assumed.
- A **size slider** (8–45 % of the page width) resizes every box belonging to the selected signer about its own centre, so a signature that comes out too big is one drag to fix.
- Signers with no saved signature get a `!` badge and are named in a notice, because an unsigned name is the thing nobody notices until the letter is out.
- **ดูลายเซ็นของฉันบนเอกสาร** — a fold-out on the letter itself, for the signer, rendering the real page with their own signature overlaid where it will land, before they approve. If it does not fit they can ask the sender to move it, or bounce it.
- Served by `?do=sigimg&user=…` (`image/png`, `private, no-store`). Any signed-in member may fetch any active member's — it appears on the circulated PDF anyway, and hiding it from the people placing it was the thing causing the problem.
- `oneDocument` now returns every box per step (`marks`) plus `hasSignature` / `sigW` / `sigH`.

### Scheduling warns instead of refusing
- **A time somebody is not free for can still be booked.** `freeSlots` returns every slot inside the host's office hours with `taken` and `reason`, rather than quietly dropping the busy ones — the guest sees ไม่ว่าง on the slot, a hint above the list, and a warning in the confirm step, and books anyway if they mean to (`anyway: true`). The host's notice says plainly that it lands on something they already had. An hour the host never offered is still refused (`NOT_OFFERED`) — this loosens *their availability*, not their office hours.
- **Find a time** keeps the clashing slots on the list too, marked and selectable, with a chip naming who is not free.
- **Office hours and availability take several days at once.** One row, day chips (จ อ พ พฤ ศ ส อา), the same hours saved on each day ticked; identical windows are folded back into one row when the form is reopened, so "every weekday 15:00–17:00" is one line rather than five.
- **ใช้เวลาว่างประจำสัปดาห์** copies the weekly free time from the profile straight into office hours, to trim — most people's office hours *are* their free time, and typing it twice was why many never set any.

### Tests
- run.mjs §82 rewritten for the new booking behaviour; 1177 checks, all passing.
- New browser suite `dev-tests/sigsize.mjs` (signature box proportions, the slider, the signer's check, multi-day office hours, booking over a clash). Added to the suite list.
- `avail.mjs` and `redesign.mjs` updated for the day chips — both suites had been driving a `<select>` that no longer exists — and `redesign.mjs` now clears the host's leftover appointments before section 5, since a crashed run's stale booking made a correct slot list look wrong.

## 2026-10-11 — cuftm-2026-10-11b-announce-docs.zip · version `2026-10-11b`
Schema `2026-10-11b`. Still 12 functions.

### The bug ต๊อดติ found: a ฝ่าย announcement went to the whole board
`resolveAudience` in api/push.js matched **anyone who could SEE the department**, not the people **in** it — the clause was `OR u.all_departments = true`, added deliberately on the theory that a ฝ่าย's notice is committee business the directors should see. In practice ต๊อดติ sent one to อำนวยการ 1–3 and it reached ประธานโครงการ, both รองประธาน, two ผู้ช่วย and the เลขานุการ, because the roster gives all of them "All". Reproduced on the fixture: 8 recipients, 6 of them wrong.
- Department announcements now reach department members only. (Tasks always did this correctly — `expandPeople` in api/tasks.js has excluded all-department people from the start, which is what made the two behave differently.)
- "All" in the roster means **no ฝ่าย at all** (`departments[0] ?? null`), so the board cannot be reached by ticking departments however many you tick. Two new ways in: a **บอร์ด** audience of its own, and a **ส่งถึงบอร์ดด้วย** tick under the department list, off by default and showing the count.
- The "จะส่งถึง N คน" line on the page mirrors the server exactly, umbrella expansion included.
- run.mjs §16 covers it: the board is out by default, in when ticked, ฝ่ายอำนวยการใหญ่ still covers อำนวยการ 1–3, and the sender is still left out of their own announcement.

### What เลขานุการ asked for
- **ตีกลับได้แล้ว.** `canAct` returns false on a sending step, so once a letter reached เลขานุการ their only button was ส่งแล้ว — the last people to read a letter had no way to send it back. New `canBounce` (lib/approval.js) = `canAct || canSend`, so whoever is **holding** the letter can bounce it with a reason, เลขานุการ included. It is not gated on `stage === 'approving'`: at the sending step the stage is `secretary`, which is exactly when this matters. A head secretary standing in for an absent secretary can too, by the same rule as posting it.
- **A Word file beside the PDF, from the upload form.** `doc_files` gained `kind = 'source'` with `file_name` and `mime`. Optional; .docx .doc .odt .rtf .pages, 3 MB (5 MB since 10-18). The PDF is still what gets signed and sent — the source is the copy to correct from.
  - It downloads as an attachment under its own name (`filename*=UTF-8''…`); the PDFs still open inline.
  - `?do=source` adds, replaces or removes it later — same permission as replacing the PDF, plus the writer of a letter that was just sent back.
  - **A rejection now keeps the source and deletes only the PDFs**, because the whole point is that somebody is about to edit it. A letter with nothing attached still loses every file, as before.
  - Archiving puts the source in Drive beside the PDF (`archiveFile` with its own mime), since the database copy is purged days later and it would otherwise simply vanish. The PDF picker is now explicitly `kind IN ('signed','original')`.
- The two file inputs have ids (`#doc-pdf`, `#doc-source`) and their labels point at them.
- `docOriginal` was "ไฟล์ต้นฉบับ" for the unsigned PDF, which now collides: renamed to "PDF ที่อัปโหลด" / "Uploaded PDF". The Word file is "ไฟล์ Word (แก้ไขได้)".
- run.mjs §84 and a new browser suite `dev-tests/docsrc.mjs`, which fills the real form in rather than posting to the API — the first version of it posted to the API and passed while the form was broken by a `var` declared in the wrong scope (`sourceFile` was not visible to `submit()`), which only docchain caught.

**Watch out when testing:** `test/run.mjs` wipes and re-syncs the users table, so running it while the browser suites are running signs everybody out mid-suite. Run one or the other.

## 2026-10-11 — cuftm-2026-10-11a-redesign.zip · version `2026-10-11a`
The whole-UI redesign. Schema `2026-10-11a` (migrates itself). Still 12 functions.
- **Look.** Chula pink leads (#e0457b) with indigo, teal, amber and violet. Dark plum sidebar (#2a1530). White cards, 14px radius, soft shadows. Font: Anuphan (Google Fonts), falling back to IBM Plex Sans Thai. All of it lives in `public/theme.css`, loaded last. `styles.css` and `phone.css` are untouched underneath.
- **Status colours, used everywhere a status appears:** ยังไม่เริ่ม grey, กำลังทำ blue, รอตรวจ amber, ตรวจแล้ว violet, เสร็จแล้ว green. They show as the card's left stripe, list group headers, board column tops, timeline bars and calendar chips. Urgency moved to the due chip.
- **Sidebar.** On a computer it has three modes, remembered per device in localStorage `fair-sb`: docked, icons only, or detached and floating (opened from ☰). It holds nav, Spaces, then departments (folded when there are more than 8). On a phone the same element is the drawer behind เมนู. `placeNav()` moves `#tabs` into the bottom bar, which holds หน้าแรก / ตาราง / งาน / เอกสาร / เมนู. Calendar, announcements, admin, profile and links are in the drawer.
- **หน้าแรก** (now the landing page, `#/home`) is built from data already loaded (`homeStats()`): a gradient greeting with a one-line brief and a "done this week" ring; four numbers (open, due within 7 days, overdue, done in 30 days); today's timeline including appointments; charts (finished per week, my tasks by status, on-time rate, best weekday); coming deadlines, 7 badges, the people I work with most, and my Spaces.
- **Work page.** The **list** is the default view (`fair-work-view2`): groups by status in their colour, foldable, rows about 44px, columns for who / due / priority / ฝ่ายหรือ Space. Board cards restyled. New **ไทม์ไลน์ (Gantt)** view with bars from `start_date` to `due_date`, a diamond when there is no start, and a today line; zoom by week or month; group by status, by ฝ่าย/Space, or none; dragging a bar moves both dates, dragging its grip moves only the deadline (desktop, editors only).
- **Tasks.** New `start_date` and `done_at`, stamped on reaching done and cleared on reopen; tasks already done were backfilled from updated_at. Plus `space_id`.
- **Spaces** (`lib/spaces.js`, riding `/api/tasks?do=space|spaces|space-leave`): anyone can create one; a space has a name, colour, a letter or emoji, named members, and optionally whole departments or sections. Being a member widens what you can see (`canSeeTask` checks `user.spaceIds`) and never hides anything. The owner or an admin can manage it; anyone else can leave. Archiving keeps the tasks and unfiles them. Each space has its own page `#/space/<id>`.
- **Repeating meetings**: every day, weekdays, weekly, every two weeks, or monthly, with a count or an end date; capped at 52 occurrences and a year ahead. Each occurrence is a real meeting row sharing `series_id`, copied set-wise in 4 statements (`copyMeeting`). Editing or deleting offers "เฉพาะครั้งนี้" or "ครั้งนี้และครั้งถัดไป". Meetings also gained an end time (`ends_at`).
- **ตารางของฉัน** (`#/schedule`, `lib/schedule.js`, riding `/api/calendar?do=…` with cookie auth): week grid on a computer, day view with a 7-day strip on a phone; meetings, events, deadlines, appointments, focus blocks, office hours and Google events; a time-allocation donut. **Office hours** are weekly windows split into 15–90 minute slots others can book, with a shareable link `#/schedule?book=<username>`; a booking is two `appointments` rows sharing `booking_id`. **Find a time** works like Outlook's scheduling assistant. Others only ever see "busy", never titles.
- **Google Calendar, two-way, connected by each person** (`lib/googlecal.js`, scope `calendar.events` + email). Their Google events show on their schedule and count as busy; appointments and bookings are written into Google and removed on cancel; an opt-in also pushes meetings and events using deterministic ids. Refresh tokens are AES-256-GCM encrypted in `google_links` and never reach the page. Env: optional `GOOGLE_SIGNIN_CLIENT_ID`/`_SECRET`, optional `GOOGLE_TOKEN_KEY`. Redirect URI `https://cu-ftm.vercel.app/api/auth?do=google-callback`.
- **User access list** (patch `2026-10-10c`): one line per person, tap to open, plus a search box.
- **Cache-busting:** every `?v=` in index.html must equal APP_VERSION (run.mjs §77).
- **Tests:** run.mjs §79 spaces, §80 start/done dates, §81 repeats, §82 schedule, §83 Google link (stubbed); new browser suite `dev-tests/redesign.mjs`; `quiet.mjs` sends a bare `/` to `#/work` for the older suites. Dev data for screenshots: `dev-tests/seed-redesign.mjs`.

## 2026-10-10 — cuftm-2026-10-10b-hierarchy.zip · version `2026-10-10b`
- **ประธานโครงการ is เจตน์, แก้ว and กร, nobody else.** `isDirector` reads the ตำแหน่ง column (`^ประธานโครงการ|^รองประธานโครงการ`) or a home department of `exec`, falling back to admins/co-admins when nothing matches. `isTopDirector` drives `rankOf`. Candidates sorted by `bySeniority`. Role dropdowns filtered via `roles[].options` / `pickList()`. run.mjs §78.

## 2026-10-09 — the เอกสาร page
Co-chairs (one deptHead step each, max 4); ประธานฝ่ายอำนวยการใหญ่ (`divisionHead`) for oper1/2/3; editable chain; `send_mode` secretary/self; `recipient_email` + `internal_unit`; เลขรันเอกสาร issued at submit. Schema `2026-10-09a`. run.mjs §76.

## 2026-10-08 — roles, notification settings, compact UI, LINE
Role labels from `task_people.via`; แจ้งเตือน/เงียบ/ปิด in `notify_prefs`; compact ที่กำลังจะถึง; LINE `sanitizeMessage` + `lineSafeUri`, text fallback, six-button rich menu (2500×1686).

## 2026-10-08 — task viewers; board, LINE cards, getting-started guide

## Earlier
Meeting colour/description/attachments; availability and clash warnings; open assignment across departments; phone UI rebuild.
