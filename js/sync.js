// Cloud sync: keeps this device's sessions in step with the account's sessions on the server
// (worker/sessions.js). The device stays the working copy, so the app works offline; a sync:
//   1. uploads deletes made here,
//   2. uploads courses added here, and downloads the shared course list,
//   3. uploads sessions imported or changed here since their last upload,
//   4. downloads everything that changed on the server since the last sync and merges it.
// For each session the newer modifiedAt wins. See "Sync in the app" in cloud-sync-plan.md.
import { sessionKind } from './parse.js';
import { sortSessions } from './store.js';

const API = '/api/sessions';

/** state: 'signed-out' | 'offline' | 'error' */
export class SyncError extends Error {
  constructor(state, message = state) {
    super(message);
    this.state = state;
  }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      redirect: 'manual', // an expired Access login answers with a redirect to its sign-in page
      cache: 'no-store',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError('offline');
  }
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) throw new SyncError('signed-out');
  let out = null;
  try { out = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new SyncError('error', out?.error || `The server answered ${res.status}.`);
  return out;
}

/**
 * Sync this device with the account `userId`. Changes `data` in place; the caller saves it,
 * also after an error (whatever finished before the error is kept).
 * Returns { state: 'ok', pushed, pulled } or { state: 'other-account' }; throws SyncError.
 */
export async function syncNow(data, userId) {
  // This device's sessions belong to another account (someone else signed in here before).
  if (data.sync.userId && data.sync.userId !== userId) return { state: 'other-account' };
  data.sync.userId = userId;
  let pushed = 0, pulled = 0;

  for (const t of [...data.deleted]) {
    await api('DELETE', `${API}/${t.id}`, { modifiedAt: t.at });
    data.deleted = data.deleted.filter(x => x !== t);
    pushed++;
  }

  // Before sessions: a session's course must be on the server first.
  if (await syncCourses(data)) pulled++;

  for (const s of [...data.sessions]) {
    if (s.uploadedAt === s.modifiedAt) continue;
    const sent = s.modifiedAt;
    const res = await api('PUT', `${API}/${s.id}`, toServer(s));
    s.userId = userId;
    pushed++;
    if (s.modifiedAt !== sent) continue; // changed again meanwhile: goes up next time
    if (res.applied) s.uploadedAt = sent;
    else if (res.session.deleted) data.sessions = data.sessions.filter(x => x !== s); // deleted elsewhere, later
    else { // the server kept its own version: take it, shots included
      applyFields(s, res.session);
      if (res.session.shots) s.shots = res.session.shots;
    }
  }

  for (let more = true; more;) {
    const page = await api('GET', `${API}?since=${encodeURIComponent(data.sync.cursor || '')}`);
    for (const srv of page.sessions) if (mergeFromServer(data, srv, userId)) pulled++;
    data.sync.cursor = page.cursor;
    more = page.more;
  }
  if (pulled) sortSessions(data);
  if (await syncSettings(data)) pulled++;
  data.sync.lastSyncAt = new Date().toISOString();
  return { state: 'ok', pushed, pulled };
}

/**
 * Upload courses added here, then take the server's list (courses are shared between accounts).
 * Courses here that the server doesn't have are kept and go up next time. Returns true if the
 * list here changed.
 */
async function syncCourses(data) {
  for (const c of data.courses.filter(c => c.pending)) {
    await api('PUT', `/api/courses/${c.id}`, { name: c.name, location: c.location || null });
    delete c.pending;
  }
  const { courses } = await api('GET', '/api/courses');
  const before = JSON.stringify(data.courses);
  const onServer = new Set(courses.map(c => c.id));
  const missing = data.courses.filter(c => !onServer.has(c.id)).map(c => ({ ...c, pending: true }));
  data.courses = [...courses.map(c => ({ id: c.id, name: c.name, location: c.location || null })), ...missing]
    .sort((a, b) => a.name.localeCompare(b.name) || (a.location || '').localeCompare(b.location || ''));
  return JSON.stringify(data.courses) !== before;
}

// Settings that follow the account (the bag, Rapsodo units, which sessions feed each club).
// Landing zone and target yardage stay per device.
const SHARED_SETTINGS = ['units', 'window', 'bag', 'removedClubs'];
const sharedSettings = settings => Object.fromEntries(SHARED_SETTINGS.map(k => [k, settings[k] ?? null]));

/** Upload settings changed here, or take newer ones from the server. Returns true if they changed here. */
async function syncSettings(data) {
  const sync = data.sync;
  let srv;
  if (sync.settingsModifiedAt && sync.settingsModifiedAt !== sync.settingsUploadedAt) {
    const sent = sync.settingsModifiedAt;
    srv = await api('PUT', '/api/settings', { settings: sharedSettings(data.settings), modifiedAt: sent });
    if (srv.applied) {
      sync.settingsUploadedAt = sent;
      return false;
    }
  } else {
    srv = await api('GET', '/api/settings');
  }
  // A device that never changed its settings takes the account's; otherwise the newer change wins.
  if (!srv.modifiedAt || (sync.settingsModifiedAt && sync.settingsModifiedAt >= srv.modifiedAt)) return false;
  for (const k of SHARED_SETTINGS) {
    if (srv.settings[k] !== undefined) data.settings[k] = srv.settings[k];
  }
  sync.settingsModifiedAt = sync.settingsUploadedAt = srv.modifiedAt;
  return true;
}

/** Forget this device's sessions and sync state (used when a different account signs in here). */
export function clearDevice(data) {
  data.sessions = [];
  data.deleted = [];
  data.settings.bag = null; // the bag was the other account's
  data.settings.removedClubs = [];
  data.sync = { userId: null, cursor: '', lastSyncAt: null, settingsModifiedAt: null, settingsUploadedAt: null };
}

// Fields a device can change after import. Source, file name, import time and shots never change.
const MUTABLE = ['kind', 'date', 'type', 'label', 'units', 'score', 'holes', 'courseId'];

function toServer(s) {
  return {
    source: s.source,
    kind: sessionKind(s),
    courseId: s.courseId || null,
    fileName: s.fileName || null,
    date: s.date || null,
    type: s.type || null,
    label: s.label || null,
    units: s.units || null,
    score: s.score ?? null,
    holes: s.holes ?? null,
    dateGuessed: !!s.dateGuessed,
    excluded: !!s.excluded,
    // Never synced or edited since import: the server keeps its own copy if it has one.
    fresh: !s.uploadedAt && s.modifiedAt === s.importedAt,
    importedAt: s.importedAt || s.modifiedAt,
    modifiedAt: s.modifiedAt,
    shots: s.shots,
  };
}

/** Apply one session from the server to this device. Returns true if anything changed here. */
export function mergeFromServer(data, srv, userId) {
  const i = data.sessions.findIndex(s => s.id === srv.id);
  const local = i >= 0 ? data.sessions[i] : null;

  if (srv.deleted) {
    // Deletes already uploaded from here are done.
    data.deleted = data.deleted.filter(t => !(t.id === srv.id && t.at <= srv.modifiedAt));
    // A change made here after the delete wins (it goes back up and restores the session).
    if (!local || local.modifiedAt > srv.modifiedAt) return false;
    data.sessions.splice(i, 1);
    return true;
  }

  const tomb = data.deleted.find(t => t.id === srv.id);
  if (tomb) {
    if (tomb.at >= srv.modifiedAt) return false; // deleted here after the server's change
    data.deleted = data.deleted.filter(t => t !== tomb); // changed elsewhere after the delete: keep it
  }

  if (!local) {
    const s = { id: srv.id, userId, source: srv.source, fileName: srv.fileName, importedAt: srv.importedAt, shots: srv.shots };
    applyFields(s, srv);
    data.sessions.push(s);
    return true;
  }
  if (local.modifiedAt >= srv.modifiedAt) return false; // this device has the same or a newer version
  applyFields(local, srv);
  local.userId = userId;
  return true;
}

function applyFields(s, srv) {
  for (const k of MUTABLE) {
    if (srv[k] != null) s[k] = srv[k];
    else delete s[k];
  }
  if (srv.dateGuessed) s.dateGuessed = true; else delete s.dateGuessed;
  if (srv.excluded) s.excluded = true; else delete s.excluded;
  s.modifiedAt = srv.modifiedAt;
  s.uploadedAt = srv.modifiedAt; // matches the server: nothing to upload
}
