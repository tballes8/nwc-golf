// Local storage for v1. Every record carries userId so cloud sync can be added later
// without changing the data shape.
const KEY = 'nwcgolf.v1';

const EMPTY = () => ({
  version: 1,
  sessions: [],
  settings: { units: 'yd', window: 'recent', zone: 8, target: 150 },
});

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY();
    const data = JSON.parse(raw);
    return { ...EMPTY(), ...data, settings: { ...EMPTY().settings, ...(data.settings || {}) } };
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

/** Ask the browser not to clear our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* not supported */ }
}

/** Add sessions, skipping ones already stored. Returns { added, duplicates }. */
export function addSessions(data, sessions) {
  const have = new Set(data.sessions.map(s => s.id));
  let added = 0, duplicates = 0;
  for (const s of sessions) {
    if (have.has(s.id)) { duplicates++; continue; }
    data.sessions.push(s); have.add(s.id); added++;
  }
  data.sessions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { added, duplicates };
}

export function backupBlob(data) {
  return new Blob([JSON.stringify({ app: 'nwc-golf', exportedAt: new Date().toISOString(), ...data }, null, 1)], { type: 'application/json' });
}

/** Read a backup file's sessions. Returns null if it isn't a backup from this app. */
export function readBackup(text) {
  try {
    const d = JSON.parse(text);
    if (d.app !== 'nwc-golf' || !Array.isArray(d.sessions)) return null;
    return d;
  } catch { return null; }
}
