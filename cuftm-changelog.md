# CUFTM changelog — entry for 2026-10-19c

> This repository has no `cuftm-changelog.md`, so this file holds only the new entry. Paste it at the top of your own changelog.

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
