# Cloud sync plan: D1 + Cloudflare Access (Nov 21, 2026)

Goal: a few invited testers sign in, and their sessions are stored in Cloudflare D1 and sync between their devices (PC and phone). This replaces moving data around with backup files. The app keeps working offline on the course.

Later, if testing goes well: our own accounts with email sign-in, open to anyone. This plan keeps that switch cheap (see "Moving to real accounts").

## Decisions

| Topic | Choice | Why |
|---|---|---|
| Database | D1 `nwc-golf`, ID `ba5c5e53-8670-4f00-aa5a-a56343dd0312` | Built into Workers, free tier far beyond our size, SQLite |
| Sign-in for now | Cloudflare Access (Zero Trust free plan, up to 50 users), one-time code by email | No password code to write or secure; testers are added by email address in the dashboard |
| What Access protects | `golf.nwc-analytics.com/api/*` only | The app itself stays public and keeps working offline; only data needs a login |
| Server code | One small Worker script (`worker/index.js`), plain JavaScript, no npm dependencies | Same no-build-step style as the app |
| Working copy | Still the phone/browser (localStorage) | Offline on the course; sync runs when there's signal |
| Conflicts | Last change wins, per session | One person editing their own sessions on two devices rarely conflicts |
| Courses | A `courses` table; each session points to one (`course_id`) | One spelling per course, so filtering works; a place for holes and GPS data later |
| Where a session was played | `kind` on each session: `range`, `sim` or `course` (a live round) | Course history can show live rounds and simulator rounds of the same course separately |

## How a request flows

1. The app calls `/api/...` on its own domain.
2. Cloudflare Access checks the `CF_Authorization` cookie. No valid login: Access answers with a redirect to its login page, which the app treats as "signed out".
3. With a valid login, Access passes the request to the Worker with a signed token (`Cf-Access-Jwt-Assertion` header).
4. The Worker verifies that token (signature against our team's public keys, audience tag, expiry), takes the email from it, finds or creates the user, and only ever reads or writes that user's rows.

The Worker checks the token itself instead of trusting that Access sits in front. That way, a misconfigured Access rule can't expose data.

Signing in: the app's **Sign in** button navigates the whole page to `/api/login` (a protected path). Access shows its email-code screen, then the Worker redirects back to the app. Sign-in lasts as long as the Access session duration (proposed: 1 month).

## Database tables

```sql
CREATE TABLE users (
  id         TEXT PRIMARY KEY,           -- random ID, never the email
  email      TEXT NOT NULL UNIQUE,       -- lowercased
  created_at TEXT NOT NULL
);

CREATE TABLE courses (
  id         TEXT PRIMARY KEY,           -- random ID
  name       TEXT NOT NULL,              -- "Oslo Golf Club"
  location   TEXT,                       -- city/region, to tell same-named courses apart
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Later, for shot entry and GPS: course_holes (course_id, hole, par, yards, pin/tee/hazard positions).

CREATE TABLE sessions (
  user_id      TEXT NOT NULL REFERENCES users(id),
  id           TEXT NOT NULL,            -- the app's fingerprint ID (random for sessions entered in the app)
  source       TEXT NOT NULL,            -- rapsodo-mlm2pro | e6-connect | app (entered in the app, later)
  kind         TEXT NOT NULL,            -- range | sim | course (live round)
  course_id    TEXT REFERENCES courses(id), -- null for range sessions
  file_name    TEXT,
  date         TEXT,                     -- YYYY-MM-DD
  type         TEXT,
  label        TEXT,
  units        TEXT,
  score        INTEGER,                  -- total strokes for a round, entered by the golfer (E6 exports have no putts)
  holes        INTEGER,                  -- holes played (9 or 18), so averages compare like with like
  date_guessed INTEGER NOT NULL DEFAULT 0,
  excluded     INTEGER NOT NULL DEFAULT 0,
  imported_at  TEXT NOT NULL,
  modified_at  TEXT NOT NULL,            -- set by the device that made the change (last change wins)
  synced_at    TEXT NOT NULL,            -- set by the server; devices pull "changed since"
  deleted      INTEGER NOT NULL DEFAULT 0, -- kept as a marker so deletes reach other devices
  PRIMARY KEY (user_id, id)
);

CREATE TABLE shots (
  user_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  n            INTEGER NOT NULL,         -- order within the session
  hole         INTEGER,                  -- E6 rounds and live rounds; null on the range
  stroke       INTEGER,                  -- stroke number on that hole (live rounds, later)
  club_code    TEXT NOT NULL,
  carry        REAL NOT NULL,
  total        REAL,
  ball_speed   REAL,
  club_speed   REAL,
  smash        REAL,
  side         REAL,
  apex         REAL,
  launch_angle REAL,
  launch_dir   REAL,
  spin         REAL,
  extra        TEXT,                     -- JSON: fields only one format has (brand, model, hole, back spin...)
  PRIMARY KEY (user_id, session_id, n),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id)
);
CREATE INDEX sessions_sync ON sessions(user_id, synced_at);
CREATE INDEX sessions_course ON sessions(user_id, course_id, date);
```

Courses are shared, not per user: a course added by one tester can be picked by another, which GPS data will need later. Only course names and locations are shared, never anyone's sessions.

How sessions get their course and kind:
- **E6:** `kind = sim`. The `course` column is matched to an existing course by name, or a new course is created. "Practice Area Targets" is E6's practice range, so it becomes `kind = range` with no course.
- **Rapsodo:** range, target-range and practice files are `range`. `studios-courses` files are `sim` with no course, since the file doesn't name one. You can pick the course on the Sessions screen.
- **Entered in the app (later):** `kind = course`, with the course picked when the round starts.

Shots get their own rows (not one JSON blob per session) so later features can query them in SQL: round analysis by hole, trends across sessions, comparing testers. Columns are the fields the stats use; everything else goes in `extra`, so a new format doesn't need a table change.

Shots never change after import, so each shot row is written once. A 150-shot session is about 150 row writes. The D1 free tier allows 100,000 a day.

## API

| Method and path | Does |
|---|---|
| `GET /api/me` | Signed-in email. 200 = signed in |
| `GET /api/login` | Protected; redirects back to the app after Access sign-in |
| `GET /api/sessions?since=<synced_at>` | Sessions changed since the last pull, with their shots (and delete markers) |
| `PUT /api/sessions/<id>` | Upload a new session with its shots, or update its date, excluded flag or label |
| `DELETE /api/sessions/<id>` | Mark deleted |
| `GET /api/courses?since=<updated_at>` | Courses added or changed since the last pull |
| `PUT /api/courses/<id>` | Add a course or fix its name/location |

Every query filters on the signed-in `user_id`.

## Sync in the app

- Each session gets `modifiedAt`, set whenever it's imported or edited. Deleting keeps a small marker (`{ id, at }`) so the delete can be uploaded.
- Sync runs when the app opens, after an import or edit, and when the phone comes back online. A **Sync now** button is there too.
- Steps: upload local changes made since the last sync, then download server changes since the last sync and merge them (newer `modifiedAt` wins).
- First sign-in on a device that already has sessions uploads them. Sessions already on the server (same ID) aren't uploaded twice.
- `userId: 'local'` on existing sessions becomes the signed-in user's ID.
- Settings: "Distances in Rapsodo files" and "Shots used for each club" sync with the account. Target yardage and landing zone stay per device.
- Sessions screen: "Signed in as tyrone@…, last synced 2 min ago", **Sync now**, **Sign out**. Signed out: **Sign in to sync**. The app works exactly as today without signing in.
- Download backup stays.
- Courses sync like sessions and are stored on the phone too, so course history works offline on the course.

## Course history (live rounds)

- A course picker on the Caddie screen: "Playing at: Oslo Golf Club". The app remembers it for the day.
- With a course picked, a Course view shows your history there: number of rounds played, average score (18-hole and 9-hole rounds averaged separately), and a round picker to look at one round. Simulator rounds count, labelled as sim.
- Sessions screen: each session shows its course and kind, and you can set or change the course and enter the score and holes played. Score is entered by hand: E6 exports don't include putts, so they can't give a score.

## Later: entering shots in the app

Not part of this plan's phases, but the tables are shaped for it: a live round is a session with `source = app`, `kind = course` and a course. Each shot is a row with `hole`, `stroke`, `club_code` and whatever gets measured (carry from GPS or entered yardage). Columns added then (lie, result, putts) are a table change in a later migration, not a redesign.

## Changes to existing files

- `wrangler.jsonc`: add `"main": "worker/index.js"`, the D1 binding (`DB`), the Access team domain and audience tag as `vars` (not secrets), and `"run_worker_first": ["/api/*"]` so the Worker only runs for API calls. Static files stay free and fast.
- `.assetsignore`: add `worker/` and `migrations/` so server code isn't served as files.
- `sw.js`: never cache `/api/*`. Today it caches every GET, which would store private data and stale or login responses. Bump `VERSION`.
- `.gitignore`: add `.dev.vars` and `.wrangler/` (local-only files).
- New: `worker/index.js`, `migrations/0001_init.sql`, `js/sync.js`.

## Local development

- Needs Node 22 or newer (this PC has Node 18) for `npx wrangler dev`, which runs the app, the Worker and a local copy of D1 together.
- Access can't run locally. The Worker accepts a stand-in email from a `.dev.vars` file (`DEV_EMAIL=...`), which is never committed or deployed. The Worker ignores it unless the request comes from localhost.
- Applying table changes to the live database is a deliberate step you run: `npx wrangler d1 migrations apply nwc-golf --remote` (after `npx wrangler login` once). It isn't automatic on push.

## Your dashboard steps (before phase 1 ships)

1. **Zero Trust** (left sidebar, or one.dash.cloudflare.com): pick a team name (it becomes `<team>.cloudflareaccess.com`) and the Free plan. Cloudflare may ask for a payment method even on Free.
2. **Login method**: One-time PIN is on by default. Nothing to add.
3. **Access > Applications > Add > Self-hosted**: domain `golf.nwc-analytics.com`, path `api/*`, session duration 1 month.
4. **Policy**: Allow; Include: Emails: you plus each tester.
5. Send me the **team domain** and the application's **Audience (AUD) tag** (on the application's Overview). Neither is secret.

## Phases

1. **Plumbing**: Worker, tables, `/api/me`, `/api/login`, sign-in and sign-out on the Sessions screen, `sw.js` fix. Then test sign-in on the PC and **in the iPhone Home Screen app**. Home Screen apps keep their own cookies, separate from Safari, and a login page on another domain can behave differently there. This is the main unknown, so it's tested before building sync on top.
2. **Sync**: sessions and courses API, `js/sync.js`, first-sign-in upload, merge, Sessions screen status.
2b. **Courses in the app**: course and kind on imported sessions, course picker on Sessions and Caddie, course history view. The local part (no sign-in needed) can be built before phase 1 if you want it on the course sooner.
3. **Testers**: add their emails to the Access policy and send them the link. Each tester only sees their own data.

## Moving to real accounts later

- Users are keyed by our own random ID with the email alongside, not by Access's identity. The app and tables don't care how someone signed in.
- Switching means replacing step 4 of "How a request flows": the Worker sends its own email sign-in link and sets its own session cookie, instead of reading Access's token. The same email maps to the same user, so testers keep their data.
- Then remove the Access application.

## Open questions

- Testers' clubs: E6 wedge names are mapped to this bag (Gap Wedge = AW, Sand Wedge = LW). Other testers may need their own mapping; that becomes a per-user setting before they import E6 files.
- Should testers be able to see anything of each other's (a shared leaderboard)? The plan assumes no. Course names are the one shared thing.
- Decided (Nov 21): course history shows rounds played, average score and a round picker; simulator rounds count; built after sync.
- Team domain: `https://nwc-golf.cloudflareaccess.com`. Access application `NWC Golf API` with policy `Testers`.
