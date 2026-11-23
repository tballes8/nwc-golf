// Sessions API: upload, delete and download one user's sessions and their shots.
//
// Sync rules (see "Sync in the app" in cloud-sync-plan.md):
// - Each session carries modifiedAt, set by the device that last changed it. The newer
//   modifiedAt wins; an older upload or delete is ignored.
// - The server stamps synced_at on every accepted change, so a device can ask for
//   "everything changed since my last pull" (GET with a cursor).
// - Deleting keeps the session row as a marker (deleted = 1) so other devices learn about
//   it, and removes its shots.
// - Shots never change after import. They're written when a session first arrives (or
//   comes back after a delete) and ignored on later uploads. Two devices can hold different
//   shots for the same session (shots with clubs not in the bag are left out at import, and
//   the bag may not have synced yet); the server's shots win, and it sends them back.
// - A fresh import (a device's copy that was never synced or edited) never overwrites a
//   session the server already has, even though its import time is newer: the same file
//   imported on a second device mustn't undo edits made on the first. It can bring back a
//   deleted one. When an upload isn't applied, the server answers with its own version.
// Every query is scoped to the signed-in user's ID.

import { json, HttpError, readJSON } from './http.js';

const MAX_BODY = 1_000_000; // bytes; a 300-shot session is about 100 KB
const MAX_SHOTS = 2000;
const PAGE = 25;            // sessions per download page

export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/; // as made by Date.toISOString()
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = new Set(['rapsodo-mlm2pro', 'e6-connect', 'app']);
const KINDS = new Set(['range', 'sim', 'course']);

// Shot fields with their own column; anything else goes in the extra JSON column.
const SHOT_COLUMNS = {
  hole: 'hole', stroke: 'stroke', clubCode: 'club_code', carry: 'carry', total: 'total',
  ballSpeed: 'ball_speed', clubSpeed: 'club_speed', smash: 'smash', side: 'side', apex: 'apex',
  launchAngle: 'launch_angle', launchDir: 'launch_dir', spin: 'spin',
};

/** Session IDs: the app's fingerprints (hex) now, random IDs for sessions entered in the app later. */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---- Routes ------------------------------------------------------------------

export async function putSession(db, userId, id, request) {
  const s = cleanSession(await readJSON(request, MAX_BODY));
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(UPSERT_SESSION).bind(
      userId, id, s.source, s.kind, s.courseId, s.fileName, s.date, s.type, s.label, s.units, s.score, s.holes,
      s.dateGuessed, s.excluded, s.importedAt, s.modifiedAt, now, s.fresh,
    ),
    db.prepare(INSERT_SHOTS).bind(userId, id, JSON.stringify(s.shots)),
  ]);
  const row = await db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE user_id = ? AND id = ?`).bind(userId, id).first();
  if (row.modified_at === s.modifiedAt && !row.deleted) return json({ applied: true });
  // The server kept its own version (newer, or this was a fresh import of a session it
  // already has). Send it back, shots included, so the device can take it.
  let shots;
  if (!row.deleted) {
    const { results } = await db.prepare(`SELECT ${Object.values(SHOT_COLUMNS).join(', ')}, extra FROM shots WHERE user_id = ? AND session_id = ? ORDER BY n`)
      .bind(userId, id).all();
    shots = results.map(toClientShot);
  }
  return json({ applied: false, session: toClientSession(row, shots) });
}

export async function deleteSession(db, userId, id, request) {
  const { modifiedAt } = (await readJSON(request, 10_000)) || {};
  if (!ISO_TIME.test(modifiedAt ?? '')) throw new HttpError(400, 'modifiedAt must be an ISO time like 2026-11-22T18:04:05.123Z.');
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE sessions SET deleted = 1, modified_at = ?, synced_at = ? WHERE user_id = ? AND id = ? AND modified_at < ?')
      .bind(modifiedAt, now, userId, id, modifiedAt),
    db.prepare('DELETE FROM shots WHERE user_id = ? AND session_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE user_id = ? AND id = ? AND deleted = 1)')
      .bind(userId, id, userId, id),
  ]);
  return json({ ok: true });
}

/** Sessions changed since the cursor ("syncedAt|id" from the previous page; empty = everything). */
export async function listSessions(db, userId, since) {
  const [at = '', after = ''] = String(since || '').split('|');
  if (at && !ISO_TIME.test(at)) throw new HttpError(400, 'since is not a cursor from this API.');
  const { results: rows } = await db.prepare(`
    SELECT ${SESSION_COLUMNS}
    FROM sessions
    WHERE user_id = ? AND (synced_at > ? OR (synced_at = ? AND id > ?))
    ORDER BY synced_at, id
    LIMIT ?`).bind(userId, at, at, after, PAGE + 1).all();

  const more = rows.length > PAGE;
  const page = rows.slice(0, PAGE);
  const live = page.filter(r => !r.deleted).map(r => r.id);
  const shots = new Map(live.map(id => [id, []]));
  if (live.length) {
    const { results } = await db.prepare(`
      SELECT session_id, ${Object.values(SHOT_COLUMNS).join(', ')}, extra
      FROM shots
      WHERE user_id = ? AND session_id IN (SELECT value FROM json_each(?))
      ORDER BY session_id, n`).bind(userId, JSON.stringify(live)).all();
    for (const r of results) shots.get(r.session_id).push(toClientShot(r));
  }
  const last = page[page.length - 1];
  return json({
    sessions: page.map(r => toClientSession(r, shots.get(r.id))),
    cursor: last ? `${last.synced_at}|${last.id}` : String(since || ''),
    more,
  });
}

// ---- SQL ---------------------------------------------------------------------

const SESSION_COLUMNS = `id, source, kind, course_id, file_name, date, type, label, units, score, holes,
  date_guessed, excluded, imported_at, modified_at, synced_at, deleted`;

// Insert, or update when this upload is newer (and not a fresh import over a live session; the
// last parameter is 1 for a fresh import). Source, file name and import time never change.
// A course the server doesn't know becomes no course rather than an error (the app uploads
// courses first, so this is only a safety net). A newer upload also undoes a delete.
const UPSERT_SESSION = `
  INSERT INTO sessions (user_id, id, source, kind, course_id, file_name, date, type, label, units, score, holes,
                        date_guessed, excluded, imported_at, modified_at, synced_at, deleted)
  VALUES (?, ?, ?, ?, (SELECT id FROM courses WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT (user_id, id) DO UPDATE SET
    kind = excluded.kind, course_id = excluded.course_id, date = excluded.date, type = excluded.type, label = excluded.label,
    units = excluded.units, score = excluded.score, holes = excluded.holes,
    date_guessed = excluded.date_guessed, excluded = excluded.excluded,
    modified_at = excluded.modified_at, synced_at = excluded.synced_at, deleted = 0
  WHERE excluded.modified_at > sessions.modified_at AND (sessions.deleted = 1 OR ? = 0)`;
// (In ON CONFLICT, "excluded." means the row being inserted; "excluded.excluded" is its excluded column.)

// All shots in one statement, from a JSON array bound as ?3 (D1 caps bound parameters per
// statement, and statements per request on the free plan). Only when the session is live and
// has no shots yet (new, or back after a delete): shots already stored never change.
const INSERT_SHOTS = `
  INSERT OR IGNORE INTO shots (user_id, session_id, n, ${Object.values(SHOT_COLUMNS).join(', ')}, extra)
  SELECT ?1, ?2, CAST(j.key AS INTEGER),
         ${Object.keys(SHOT_COLUMNS).map(k => `json_extract(j.value, '$.${k}')`).join(', ')},
         json_extract(j.value, '$.extra')
  FROM json_each(?3) AS j
  WHERE EXISTS (SELECT 1 FROM sessions WHERE user_id = ?1 AND id = ?2 AND deleted = 0)
    AND NOT EXISTS (SELECT 1 FROM shots WHERE user_id = ?1 AND session_id = ?2)`;

// ---- Checking what devices send -----------------------------------------------

const bad = message => { throw new HttpError(400, message); };

function text(v, max, name) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) bad(`${name} must be text of up to ${max} characters.`);
  return v;
}
function number(v, name) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${name} must be a number.`);
  return v;
}
function whole(v, name, min, max) {
  v = number(v, name);
  if (v != null && (!Number.isInteger(v) || v < min || v > max)) bad(`${name} must be a whole number from ${min} to ${max}.`);
  return v;
}

export function cleanSession(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) bad('Send the session as a JSON object.');
  if (!SOURCES.has(b.source)) bad('source is not a format this app knows.');
  if (!KINDS.has(b.kind)) bad('kind must be range, sim or course.');
  if (b.date != null && !(typeof b.date === 'string' && DAY.test(b.date))) bad('date must look like 2026-11-22.');
  if (!ISO_TIME.test(b.importedAt ?? '')) bad('importedAt must be an ISO time.');
  if (!ISO_TIME.test(b.modifiedAt ?? '')) bad('modifiedAt must be an ISO time.');
  if (b.units != null && b.units !== 'yd' && b.units !== 'm') bad('units must be yd or m.');
  if (b.courseId != null && !(typeof b.courseId === 'string' && SESSION_ID.test(b.courseId))) bad('courseId is not a course ID.');
  if (!Array.isArray(b.shots) || !b.shots.length || b.shots.length > MAX_SHOTS) bad(`shots must be a list of 1 to ${MAX_SHOTS} shots.`);
  return {
    source: b.source,
    kind: b.kind,
    courseId: b.courseId ?? null,
    fileName: text(b.fileName, 200, 'fileName'),
    date: b.date ?? null,
    type: text(b.type, 60, 'type'),
    label: text(b.label, 200, 'label'),
    units: b.units ?? null,
    score: whole(b.score, 'score', 1, 300),
    holes: whole(b.holes, 'holes', 1, 18),
    dateGuessed: b.dateGuessed ? 1 : 0,
    excluded: b.excluded ? 1 : 0,
    fresh: b.fresh ? 1 : 0,
    importedAt: b.importedAt,
    modifiedAt: b.modifiedAt,
    shots: b.shots.map(cleanShot),
  };
}

function cleanShot(s, i) {
  const name = `Shot ${i + 1}`;
  if (!s || typeof s !== 'object' || Array.isArray(s)) bad(`${name} must be an object.`);
  const row = {
    hole: whole(s.hole, `${name} hole`, 1, 99),
    stroke: whole(s.stroke, `${name} stroke`, 1, 50),
    clubCode: text(s.clubCode, 30, `${name} clubCode`) ?? bad(`${name} has no club.`),
    carry: number(s.carry, `${name} carry`) ?? bad(`${name} has no carry.`),
  };
  for (const k of ['total', 'ballSpeed', 'clubSpeed', 'smash', 'side', 'apex', 'launchAngle', 'launchDir', 'spin']) {
    row[k] = number(s[k], `${name} ${k}`);
  }
  // Everything else (brand, model, back spin, shot number...) is kept as-is in extra.
  const extra = Object.entries(s).filter(([k]) => !Object.hasOwn(SHOT_COLUMNS, k));
  if (extra.length > 40) bad(`${name} has too many fields.`);
  for (const [k, v] of extra) {
    const ok = v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200);
    if (k.length > 40 || !ok) bad(`${name}: ${k.slice(0, 40)} must be a short text, a number, true/false or empty.`);
  }
  row.extra = extra.length ? Object.fromEntries(extra) : null;
  return row;
}

// ---- Shaping rows for devices ------------------------------------------------

function toClientShot(r) {
  const core = {};
  for (const [k, col] of Object.entries(SHOT_COLUMNS)) if (r[col] != null) core[k] = r[col];
  return { ...(r.extra ? JSON.parse(r.extra) : {}), ...core };
}

function toClientSession(r, shots) {
  if (r.deleted) return { id: r.id, deleted: true, modifiedAt: r.modified_at };
  return {
    id: r.id,
    source: r.source,
    kind: r.kind,
    courseId: r.course_id,
    fileName: r.file_name,
    date: r.date,
    type: r.type,
    label: r.label,
    units: r.units,
    score: r.score,
    holes: r.holes,
    dateGuessed: !!r.date_guessed,
    excluded: !!r.excluded,
    importedAt: r.imported_at,
    modifiedAt: r.modified_at,
    ...(shots ? { shots } : {}),
  };
}
