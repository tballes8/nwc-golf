// Settings API: the settings that follow a user between devices (the bag and removed clubs,
// Rapsodo units, and which sessions feed each club). Stored as JSON on the user's row. Like sessions, the newer
// change (modifiedAt, set by the device) wins; an older upload is ignored and the server
// answers with what it has.

import { json, HttpError, readJSON } from './http.js';
import { ISO_TIME } from './sessions.js';

const bad = message => { throw new HttpError(400, message); };

export async function getSettings(db, userId) {
  return json(await current(db, userId));
}

export async function putSettings(db, userId, request) {
  const { settings, modifiedAt } = (await readJSON(request, 20_000)) || {};
  if (!ISO_TIME.test(modifiedAt ?? '')) bad('modifiedAt must be an ISO time like 2026-11-22T18:04:05.123Z.');
  const clean = cleanSettings(settings);
  await db.prepare(`
    UPDATE users SET settings = ?, settings_modified_at = ?
    WHERE id = ? AND (settings_modified_at IS NULL OR settings_modified_at < ?)`)
    .bind(JSON.stringify(clean), modifiedAt, userId, modifiedAt).run();
  const now = await current(db, userId);
  return json({ applied: now.modifiedAt === modifiedAt, ...now });
}

async function current(db, userId) {
  const row = await db.prepare('SELECT settings, settings_modified_at FROM users WHERE id = ?').bind(userId).first();
  return { settings: row?.settings ? JSON.parse(row.settings) : null, modifiedAt: row?.settings_modified_at ?? null };
}

function cleanSettings(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) bad('settings must be an object.');
  if (s.units != null && s.units !== 'yd' && s.units !== 'm') bad('units must be yd or m.');
  if (s.window != null && s.window !== 'recent' && s.window !== 'all') bad('window must be recent or all.');
  return { units: s.units ?? null, window: s.window ?? null, bag: clubList(s.bag, 'bag'), removedClubs: clubList(s.removedClubs, 'removedClubs') };
}

function clubList(v, name) {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length > 40) bad(`${name} must be a list of up to 40 club codes.`);
  if (!v.every(c => typeof c === 'string' && c.length >= 1 && c.length <= 30)) bad(`Each club in ${name} must be a short club code.`);
  return [...new Set(v)];
}
