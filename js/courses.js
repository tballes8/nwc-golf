// Courses: where sim rounds (and, later, live rounds) were played, and the history shown for
// the course being played today.
//
// Courses are shared between accounts (names and locations only; see worker/courses.js). A
// course's ID is made from its name and location, so two devices that add the same course
// offline (say, both import the same E6 round) end up with the same course, not two.
import { sessionKind } from './parse.js';

const tidy = s => String(s ?? '').trim().replace(/\s+/g, ' ');
const key = s => tidy(s).toLowerCase();
const slug = s => key(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

/** "Oslo Golf Club" -> "oslo-golf-club"; with a location, "oslo-golf-club--oslo-norway". */
export function courseIdFor(name, location) {
  const id = [slug(name), slug(location)].filter(Boolean).join('--').slice(0, 60).replace(/-+$/, '');
  // A name with no Latin letters or digits (e.g. Japanese) still gets an ID.
  return id || `c${hash(`${key(name)}|${key(location)}`)}`;
}

export const MAX_NAME = 100;

function sortCourses(data) {
  data.courses.sort((a, b) => a.name.localeCompare(b.name) || (a.location || '').localeCompare(b.location || ''));
}

/** Add a course on this device (uploaded at the next sync), or return it if it's already here. */
export function addCourse(data, name, location = '') {
  name = tidy(name).slice(0, MAX_NAME);
  location = tidy(location).slice(0, MAX_NAME) || null;
  const id = courseIdFor(name, location);
  let c = data.courses.find(x => x.id === id);
  if (!c) {
    c = { id, name, location, pending: true };
    data.courses.push(c);
    sortCourses(data);
  }
  return c;
}

/** Courses from a backup file: added if this device doesn't have them (uploaded at the next sync). */
export function restoreCourses(data, list) {
  if (!Array.isArray(list)) return;
  for (const c of list) {
    if (!c || typeof c.id !== 'string' || typeof c.name !== 'string' || findCourse(data, c.id)) continue;
    data.courses.push({ id: c.id, name: c.name, location: c.location || null, pending: true });
  }
  sortCourses(data);
}

/** The course with this name (any location), added if there isn't one. E6 files name the course. */
export function courseNamed(data, name) {
  return data.courses.find(c => key(c.name) === key(name)) || addCourse(data, name);
}

export const findCourse = (data, id) => (id ? data.courses.find(c => c.id === id) || null : null);

/** A round: a sim round or a live round (not a range session). */
export const isRound = s => {
  const k = sessionKind(s);
  return k === 'sim' || k === 'course';
};

/**
 * Give an imported E6 sim round its course, from the course column. Practice areas are range
 * sessions and get none; Rapsodo files don't name the course, so it's picked on Sessions.
 * Returns true if it set one.
 */
export function autoCourse(data, s) {
  if (s.courseId || s.source !== 'e6-connect' || sessionKind(s) !== 'sim' || !tidy(s.label)) return false;
  s.courseId = courseNamed(data, s.label).id;
  return true;
}

/** Holes played, from the hole numbers in the file (E6), rounded to 9 or 18. Null if unknown. */
export function guessHoles(s) {
  const holes = new Set(s.shots.map(x => x.hole).filter(h => h != null));
  if (!holes.size) return null;
  return holes.size > 9 ? 18 : 9;
}
export const roundHoles = s => s.holes ?? guessHoles(s);

const newestFirst = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.importedAt || '').localeCompare(a.importedAt || '');

/**
 * History at one course: every round there (sim rounds count), newest first, and the average
 * score for 18-hole and 9-hole rounds separately, so they compare like with like.
 */
export function courseHistory(sessions, courseId) {
  const rounds = sessions.filter(s => s.courseId === courseId && isRound(s)).sort(newestFirst);
  const average = holes => {
    const scores = rounds.filter(s => s.score && roundHoles(s) === holes).map(s => s.score);
    return scores.length ? { rounds: scores.length, score: scores.reduce((a, b) => a + b, 0) / scores.length } : null;
  };
  return {
    rounds,
    sims: rounds.filter(s => sessionKind(s) === 'sim').length,
    avg18: average(18),
    avg9: average(9),
    unscored: rounds.filter(s => !s.score).length,
  };
}

/** A round's shots hole by hole, in the order hit: [{ hole, shots: [{ clubCode, carry }] }]. */
export function roundByHole(s) {
  const holes = new Map();
  for (const x of s.shots) {
    if (x.hole == null) continue;
    if (!holes.has(x.hole)) holes.set(x.hole, []);
    holes.get(x.hole).push({ clubCode: x.clubCode, carry: x.carry });
  }
  return [...holes].sort((a, b) => a[0] - b[0]).map(([hole, shots]) => ({ hole, shots }));
}

/**
 * One-time update for sessions imported before courses existed: E6 sim rounds get their course.
 * Each one changed is marked as changed, so sync uploads it. Returns how many changed.
 */
export function migrateCourses(data, touch) {
  if (data.coursesReady) return 0;
  let n = 0;
  for (const s of data.sessions) {
    if (autoCourse(data, s)) { touch(s); n++; }
  }
  data.coursesReady = true;
  return n;
}

/** The course picked on Caddie, if it was picked today. */
export function playingCourse(data, today) {
  const p = data.settings.playing;
  return p && p.day === today ? findCourse(data, p.id) : null;
}
