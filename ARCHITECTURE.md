# Architecture: Front-End & Back-End Separation

Fair Tasks (`cuftm`) is a zero-build full-stack web application deployed on Vercel (static browser frontend + Node.js Serverless API + Neon PostgreSQL).

## Layer Boundaries

```text
cuftm/
├── public/                 ← FRONT-END (static browser SPA, zero server imports)
│   ├── index.html          App shell & asset loader
│   ├── api-client.js       Dedicated FE ↔ BE HTTP client (`window.FairAPI`)
│   ├── app.js              UI state, router, views & components (no raw `fetch()`)
│   ├── i18n.js             Thai UI strings
│   ├── i18n-en.js          English UI strings (lazy-loaded)
│   ├── styles.css          Base layout & components
│   ├── phone.css           Mobile layout rules (<= 720px)
│   ├── theme.css           Design tokens (light/dark), page colours, 2026-11 redesign
│   ├── sw.js               Push notification Service Worker
│   └── vendor/             Self-hosted pdf.js & qrcode.js
│
├── api/                    ← BACK-END HTTP ENTRYPOINTS (12 Vercel Serverless Functions)
│   ├── auth.js             Authentication, sessions, password & email verification
│   ├── users.js            Directory, profiles, avatars, RBAC user management
│   ├── tasks.js            Tasks, sub-tasks, attachments, Spaces
│   ├── events.js           Committee events & meetings
│   ├── calendar.js         Personal schedules, office hours, Google Calendar, public booking
│   ├── documents.js        PDF approval chain, stamping, archiving
│   ├── notifications.js    In-app notification bell & acknowledgements
│   ├── push.js             Web Push subscriptions & committee announcements
│   ├── line.js             LINE Bot webhook, linking, Flex cards
│   ├── import.js           Bulk CSV import
│   ├── meta.js             Reference metadata, short links (/s/:code), share links, shelf, reports
│   └── cron.js             Hourly Vercel Cron reminders & Drive archiving
│
├── lib/                    ← BACK-END DOMAIN & INFRASTRUCTURE (server-only)
│   ├── db.js               Neon/Postgres connection & schema bootstrap
│   ├── http.js             Node (req, res) ↔ Web Request/Response adapter
│   ├── auth.js             Scrypt hashing, session cookies, permission helpers
│   ├── scope.js            Task vocabulary & server-enforced visibility/edit rules
│   ├── templates.js        Server-rendered HTML fallback templates (e.g. /s/:code 404)
│   └── ...                 Domain modules (approval, pdfsign, drive, mail, line, spaces, etc.)
│
├── server/                 ← LOCAL DEVELOPMENT SERVER
│   └── dev-server.mjs      Supports full-stack, backend-only, and frontend-only (proxied) modes
│
└── scripts/
    └── check-separation.mjs Automated FE/BE boundary verifier (`npm run check:separation`)
```

## Contract & Rules

1. **Single Frontend API Boundary (`public/api-client.js`)**:
   - All browser-to-server HTTP JSON, binary (`fetchBytes`), and download (`fetchBlob`) calls go through `window.FairAPI`.
   - `public/app.js` never invokes raw `fetch()` directly.
   - Setting `window.FAIR_API_BASE` allows hosting the static frontend on a separate origin from the backend API.
2. **Server-Enforced Security**:
   - All authentication, RBAC (`Admin` / `Co-Admin` / `Editor` / `Unit Editor` / `Inner`), and data scoping are enforced in `api/` and `lib/`.
3. **No HTML in API Route Handlers**:
   - `api/*.js` routes return JSON/binary/redirects; non-API fallback HTML pages live in `lib/templates.js`.
4. **Vercel 12-Function Limit**:
   - Keep `api/` at root with at most 12 files so zero-config Vercel deploys stay within platform limits.
5. **Local Development Modes**:
   - `npm run dev` — combined frontend + backend on `http://127.0.0.1:4700`
   - `npm run dev:backend` — backend API only on `http://127.0.0.1:4701`
   - `npm run dev:frontend` — static frontend on `http://127.0.0.1:4700` proxying `/api/*` to `:4701`
   - `npm run check:separation` — verifies all FE/BE boundary invariants
   - `npm test` — runs the full API & integration test suite (`test/run.mjs`)
