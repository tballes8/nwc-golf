// Courses API. Courses are shared between accounts: any signed-in golfer can pick a course
// another added, which GPS and hole data will need later. Only names and locations are shared,
// never who added a course or anyone's sessions.
//
// A course's ID is made from its name and location by the app (courseIdFor in js/courses.js),
// so the same course added on two devices, or by two golfers, is one row. The first spelling
// stays: adding a course that's already here changes nothing and answers with the stored one.

import { json, HttpError, readJSON } from './http.js';
import { SESSION_ID } from './sessions.js';

export const COURSE_ID = SESSION_ID; // letters, digits, - and _, up to 64
const MAX_TEXT = 100;
const MAX_COURSES = 5000; // far more than testers will add; keeps the download bounded

const bad = message => { throw new HttpError(400, message); };
const tidy = v => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : v);

export async function listCourses(db) {
  const { results } = await db.prepare('SELECT id, name, location FROM courses ORDER BY name, id LIMIT ?').bind(MAX_COURSES).all();
  return json({ courses: results.map(toClient) });
}

export async function putCourse(db, userId, id, request) {
  const b = (await readJSON(request, 2_000)) || {};
  if (typeof b !== 'object' || Array.isArray(b)) bad('Send the course as a JSON object.');
  const name = tidy(b.name), location = tidy(b.location) || null;
  if (typeof name !== 'string' || !name || name.length > MAX_TEXT) bad(`name must be text of 1 to ${MAX_TEXT} characters.`);
  if (location != null && (typeof location !== 'string' || location.length > MAX_TEXT)) bad(`location must be text of up to ${MAX_TEXT} characters.`);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO courses (id, name, location, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING`).bind(id, name, location, userId, now, now).run();
  const row = await db.prepare('SELECT id, name, location FROM courses WHERE id = ?').bind(id).first();
  return json({ course: toClient(row) });
}

const toClient = r => ({ id: r.id, name: r.name, location: r.location ?? null });
