-- NWC Golf: first database schema (see cloud-sync-plan.md).
-- Apply locally:  npx wrangler d1 migrations apply nwc-golf --local
-- Apply to live:  npx wrangler d1 migrations apply nwc-golf --remote

CREATE TABLE users (
  id         TEXT PRIMARY KEY,           -- random ID, never the email
  email      TEXT NOT NULL UNIQUE,       -- lowercased
  created_at TEXT NOT NULL
);

-- Shared between users: names and locations only.
CREATE TABLE courses (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  location   TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  user_id      TEXT NOT NULL REFERENCES users(id),
  id           TEXT NOT NULL,              -- the app's fingerprint ID
  source       TEXT NOT NULL,              -- rapsodo-mlm2pro | e6-connect | app
  kind         TEXT NOT NULL,              -- range | sim | course
  course_id    TEXT REFERENCES courses(id),
  file_name    TEXT,
  date         TEXT,                       -- YYYY-MM-DD
  type         TEXT,
  label        TEXT,
  units        TEXT,
  score        INTEGER,                    -- total strokes, entered by the golfer
  holes        INTEGER,                    -- holes played (9 or 18)
  date_guessed INTEGER NOT NULL DEFAULT 0,
  excluded     INTEGER NOT NULL DEFAULT 0,
  imported_at  TEXT NOT NULL,
  modified_at  TEXT NOT NULL,              -- set by the device that made the change
  synced_at    TEXT NOT NULL,              -- set by the server
  deleted      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX sessions_sync ON sessions(user_id, synced_at);
CREATE INDEX sessions_course ON sessions(user_id, course_id, date);

CREATE TABLE shots (
  user_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  n            INTEGER NOT NULL,           -- order within the session
  hole         INTEGER,
  stroke       INTEGER,
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
  extra        TEXT,                       -- JSON: fields only one format has
  PRIMARY KEY (user_id, session_id, n),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id)
);
