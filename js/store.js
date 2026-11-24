// Local storage. The device is the working copy (offline on the course); js/sync.js keeps it
// in step with the account on the server. Every session carries userId: 'local' until its
// first upload, then the account's user ID.
const KEY = 'nwcgolf.v1';

const EMPTY = () => ({
  version: 1,
  sessions: [],
  // Courses this device knows: shared ones from the server, and ones added here
  // (pending: true until uploaded). See js/courses.js.
  courses: [],
  // bag: club codes the golfer carries; null = every club with shots (until the bag is edited).
  // removedClubs: clubs taken out of the bag or declined at import; their shots aren't imported.
  // playing: the course picked on Caddie, { id, day }; it counts for that day only.
  // units, window, bag and removedClubs sync with the account; zone, target and playing stay on this device.
  settings: { units: 'yd', window: 'recent', zone: 8, target: 150, bag: null, removedClubs: [], playing: null },
  deleted: [],  // sessions deleted here but not yet deleted on the server: [{ id, at }]
  sync: {
    userId: null,            // the account this device's sessions belong to
    cursor: '',              // where the last download stopped
    lastSyncAt: null,
    settingsModifiedAt: null, // last change to the synced settings on this device (null = never changed here)
    settingsUploadedAt: null, // the settingsModifiedAt last uploaded
  },
});

/** Fill in fields added since older versions of the app, so stored data is sync-ready. */
export function normalize(data) {
  const base = EMPTY();
  const out = { ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) }, sync: { ...base.sync, ...(data.sync || {}) } };
  out.deleted = Array.isArray(data.deleted) ? data.deleted : [];
  out.courses = Array.isArray(data.courses) ? data.courses : [];
  // A bag edited before removedClubs existed: the clubs taken out are the ones with shots
  // that aren't in it (otherwise the next import would ask about them as new clubs).
  if (data.settings?.bag && !Array.isArray(data.settings.removedClubs)) {
    const inBag = new Set(data.settings.bag);
    out.settings.removedClubs = [...new Set(out.sessions.flatMap(s => s.shots.map(x => x.clubCode)))].filter(c => !inBag.has(c));
  }
  for (const s of out.sessions) {
    // Sessions from before sync: treat the import time as the last change.
    if (!s.modifiedAt) s.modifiedAt = s.importedAt || new Date().toISOString();
  }
  return out;
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return normalize(raw ? JSON.parse(raw) : {});
  } catch {
    return EMPTY();
  }
}

export function save(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false; // storage full or blocked (private browsing)
  }
}

/**
 * Another copy of the app in this browser (a second tab or window) saved: call onChange with
 * what it saved. Every change is saved straight away, so the other copy's data is the latest;
 * taking it stops this copy from overwriting it with an older version at its next save.
 */
export function watchOtherCopies(onChange) {
  window.addEventListener('storage', e => {
    if (e.key === KEY || e.key === null) onChange(load()); // null: storage was cleared
  });
}

/** Ask the browser not to clear our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* not supported */ }
}

/** Newest session first. */
export function sortSessions(data) {
  data.sessions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/** Record that the synced settings (units, window, bag) changed here, so sync uploads them. */
export function touchSettings(data) {
  data.sync.settingsModifiedAt = new Date().toISOString();
}

/** Record that a session changed here, so sync uploads it (the newer change wins). */
export function touch(session) {
  session.modifiedAt = new Date().toISOString();
}

/** Delete a session here and remember to delete it on the server at the next sync. */
export function deleteSession(data, id) {
  data.sessions = data.sessions.filter(s => s.id !== id);
  data.deleted = data.deleted.filter(t => t.id !== id);
  data.deleted.push({ id, at: new Date().toISOString() });
}

/** Add sessions, skipping ones already stored. Returns { added, duplicates }. */
export function addSessions(data, sessions) {
  const have = new Set(data.sessions.map(s => s.id));
  let added = 0, duplicates = 0;
  for (const s of sessions) {
    if (have.has(s.id)) { duplicates++; continue; }
    s.modifiedAt = s.modifiedAt || s.importedAt || new Date().toISOString();
    data.sessions.push(s); have.add(s.id); added++;
    // Importing a session that was deleted here brings it back, here and on the server.
    data.deleted = data.deleted.filter(t => t.id !== s.id);
  }
  sortSessions(data);
  return { added, duplicates };
}

/** Backup file: sessions, courses and settings. This device's sync state stays out of it. */
export function backupBlob(data) {
  const { sync, deleted, coursesReady, ...rest } = data;
  return new Blob([JSON.stringify({ app: 'nwc-golf', exportedAt: new Date().toISOString(), ...rest }, null, 1)], { type: 'application/json' });
}

/** Read a backup file's sessions. Returns null if it isn't a backup from this app. */
export function readBackup(text) {
  try {
    const d = JSON.parse(text);
    if (d.app !== 'nwc-golf' || !Array.isArray(d.sessions)) return null;
    // Sessions from a backup are uploaded again at the next sync (the server skips ones it has).
    for (const s of d.sessions) delete s.uploadedAt;
    return d;
  } catch { return null; }
}
