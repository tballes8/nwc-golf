// Run: node tests/sync.mjs   (Node 22.13+)
// End-to-end sync: several "devices" (each its own app data) sync through the real Worker and
// a real SQLite database built from migrations/, the way the app does it.
import assert from 'node:assert/strict';
import { testDB, fakeAccess, TEAM, AUD } from './helpers.mjs';
import { parseSessionFile } from '../js/parse.js';
import { normalize, addSessions, touch, touchSettings, deleteSession, readBackup } from '../js/store.js';
import { syncNow, clearDevice, SyncError } from '../js/sync.js';
import { buildProfiles } from '../js/stats.js';

const { default: worker } = await import('../worker/index.js');
const access = await fakeAccess();
const env = { DB: testDB(), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const tick = () => new Promise(r => setTimeout(r, 3)); // so each change gets a later timestamp

// The app calls fetch('/api/...'); route it to the Worker as the given person, or simulate trouble.
let signedInAs = 'golfer@example.com', network = 'up';
globalThis.fetch = async (url, init = {}) => {
  if (String(url).endsWith('/cdn-cgi/access/certs')) return new Response(JSON.stringify(access.certs));
  if (network === 'down') throw new TypeError('Failed to fetch');
  const headers = { ...(init.headers || {}) };
  if (signedInAs) headers['cf-access-jwt-assertion'] = await access.token(access.claimsFor(signedInAs));
  return worker.fetch(new Request(new URL(url, 'https://golf.nwc-analytics.com'), { ...init, headers }), env);
};
const me = async () => (await (await fetch('/api/me')).json()).userId;
const device = () => normalize({});
const find = (d, id) => d.sessions.find(s => s.id === id);

// Two sessions as the app imports them.
const E6_NAME = 'shot_data_export_2026-11-20T00_49_06.772054Z.csv';
const E6 = [
  'course,hole,shot,club type,head speed (mph),total distance (yds),carry distance (yds),apex height (ft),ball speed (mph),back spin,side spin,launch dir,launch angle',
  'Oslo Golf Club,1,1,Driver,80,200,180,40,120,2400,300,-1.5,12',
  'Oslo Golf Club,1,2,Gap Wedge,60,95,90,60,75,8000,0,1,28',
  'Oslo Golf Club,2,3,Driver,82,205,186,44,123,2300,-200,2,11',
].join('\n');
const RAPSODO = [
  '"Club Type","Club Brand","Club Model","Carry Distance","Total Distance","Ball Speed","Launch Angle","Launch Direction","Apex","Side Carry","Club Speed","Smash Factor","Descent Angle","Attack Angle","Club Path","Club Data Est Type","Spin Rate","Spin Axis","Shot #"',
  '"7i","Callaway","Paradym","130.5","140.2","100.1","16.0","1.2","70.0","-3.4","75.0","1.33","45.0","-3.0","1.0","","6200","2.0","1"',
  '"7i","Callaway","Paradym","128.0","137.9","99.0","15.5","-0.8","68.0","2.1","74.5","1.33","44.0","-2.5","0.5","","","1.0","2"',
].join('\n');
const importInto = (d, text, name) => addSessions(d, [parseSessionFile(text, name).session]);

const golferId = await me();
const pc = device(), phone = device(), tablet = device();
importInto(pc, E6, E6_NAME);
importInto(pc, RAPSODO, 'session-range-2026-11-15.csv');
const e6Id = pc.sessions.find(s => s.source === 'e6-connect').id;
const rapId = pc.sessions.find(s => s.source === 'rapsodo-mlm2pro').id;

// 1. First sync from the PC uploads both sessions.
let r = await syncNow(pc, golferId);
assert.deepEqual(r, { state: 'ok', pushed: 2, pulled: 0 });
assert.ok(pc.sessions.every(s => s.userId === golferId && s.uploadedAt === s.modifiedAt));
assert.equal((await syncNow(pc, golferId)).pushed, 0, 'nothing left to upload');

// 2. A new phone downloads them, and gets the same club numbers.
r = await syncNow(phone, golferId);
assert.deepEqual(r, { state: 'ok', pushed: 0, pulled: 2 });
assert.deepEqual(phone.sessions.map(s => s.id), pc.sessions.map(s => s.id), 'same sessions, same order');
const profile = d => buildProfiles(d.sessions).map(p => [p.code, p.median, p.goodShots, p.sideSd]);
assert.deepEqual(profile(phone), profile(pc));
assert.equal(find(phone, e6Id).label, 'Oslo Golf Club');
assert.equal(find(phone, e6Id).dateGuessed, true);
assert.equal(find(phone, e6Id).shots[0].backSpin, 2400, 'E6-only fields come through');
assert.equal(find(phone, rapId).shots[0].model, 'Paradym', 'Rapsodo-only fields come through');

// 3. An edit on the PC reaches the phone.
await tick();
const pcE6 = find(pc, e6Id);
pcE6.date = '2026-11-18'; delete pcE6.dateGuessed; touch(pcE6);
assert.equal((await syncNow(pc, golferId)).pushed, 1);
assert.equal((await syncNow(phone, golferId)).pulled, 1);
assert.equal(find(phone, e6Id).date, '2026-11-18');
assert.equal(find(phone, e6Id).dateGuessed, undefined);

// 4. The same file imported on a third device before its first sync doesn't undo that edit.
await tick();
importInto(tablet, E6, E6_NAME);
assert.equal(find(tablet, e6Id).date, '2026-11-19');
await syncNow(tablet, golferId);
assert.equal(find(tablet, e6Id).date, '2026-11-18', 'tablet takes the edited version');
assert.equal(tablet.sessions.length, 2);
await syncNow(pc, golferId);
assert.equal(find(pc, e6Id).date, '2026-11-18', 'PC still has its edit');

// 5. Leaving a session out on the phone, then deleting one there, reaches the PC.
await tick();
const phoneRap = find(phone, rapId);
phoneRap.excluded = true; touch(phoneRap);
await syncNow(phone, golferId);
await syncNow(pc, golferId);
assert.equal(find(pc, rapId).excluded, true);
await tick();
deleteSession(phone, rapId);
assert.equal(phone.deleted.length, 1);
assert.equal((await syncNow(phone, golferId)).pushed, 1);
assert.equal(phone.deleted.length, 0, 'delete uploaded');
assert.equal((await syncNow(pc, golferId)).pulled, 1);
assert.equal(find(pc, rapId), undefined, 'gone from the PC');

// 6. Last change wins: an edit made after a delete brings the session back everywhere.
await tick();
deleteSession(pc, e6Id); // PC deletes, but is offline
network = 'down';
await assert.rejects(syncNow(pc, golferId), e => e instanceof SyncError && e.state === 'offline');
network = 'up';
assert.equal(pc.deleted.length, 1, 'delete waits for the next sync');
await tick();
const tabletE6 = find(tablet, e6Id);
tabletE6.excluded = true; touch(tabletE6); // the tablet changes it later
await syncNow(tablet, golferId);
await syncNow(pc, golferId); // the PC's older delete is ignored; it gets the session back
assert.equal(pc.deleted.length, 0);
assert.equal(find(pc, e6Id)?.excluded, true);
assert.equal(find(pc, e6Id).shots.length, 3);

// 7. Importing a deleted session again brings it back, shots and all.
await tick();
importInto(phone, RAPSODO, 'session-range-2026-11-15.csv');
await syncNow(phone, golferId);
await syncNow(pc, golferId);
assert.equal(find(pc, rapId)?.shots.length, 2);

// 8. A backup restored on a fresh device uploads without creating duplicates or undoing edits.
const backup = JSON.parse(JSON.stringify({ app: 'nwc-golf', sessions: pc.sessions }));
const restored = device();
addSessions(restored, readBackup(JSON.stringify(backup)).sessions);
assert.ok(restored.sessions.every(s => !s.uploadedAt), 'backup sessions are uploaded again');
await syncNow(restored, golferId);
assert.equal(restored.sessions.length, 2);
assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE deleted = 0').get().n, 2);

// 8b. The bag and Rapsodo units follow the account; target yardage and landing zone don't.
await tick();
pc.settings.bag = ['d', '3w', '4h', '5i', '7i', 'aw']; pc.settings.zone = 12; touchSettings(pc);
await syncNow(pc, golferId);
assert.equal(pc.sync.settingsUploadedAt, pc.sync.settingsModifiedAt);
r = await syncNow(phone, golferId);
assert.equal(r.pulled, 1, 'settings came down');
assert.deepEqual(phone.settings.bag, pc.settings.bag);
assert.equal(phone.settings.zone, 8, 'landing zone stays per device');
await tick();
phone.settings.bag = [...phone.settings.bag, 'lw']; touchSettings(phone);
phone.settings.units = 'm'; // same change
await syncNow(phone, golferId);
await syncNow(pc, golferId);
assert.ok(pc.settings.bag.includes('lw'));
assert.equal(pc.settings.units, 'm');
// An older change made offline loses to the newer one already on the server.
const staleAt = new Date(Date.parse(pc.sync.settingsModifiedAt) - 60000).toISOString();
tablet.settings.bag = ['d']; tablet.sync.settingsModifiedAt = staleAt;
await syncNow(tablet, golferId);
assert.ok(tablet.settings.bag.includes('lw'), "the tablet's older bag is replaced by the newer one");
// A brand-new device takes the account's settings instead of overwriting them with its defaults.
const fresh = device();
await syncNow(fresh, golferId);
assert.deepEqual(fresh.settings.bag, pc.settings.bag);
phone.settings.units = 'yd'; touchSettings(phone); await syncNow(phone, golferId); await syncNow(pc, golferId);

// 8c. A device whose bag hadn't synced keeps a shot the account left out: the server's shots win.
await tick();
const PRACTICE = 'shot_data_export_2026-11-21T01_00_00.000000Z.csv';
const practiceCsv = [E6.split('\n')[0], 'Range,1,1,Driver,80,200,180,40,120,2400,300,-1.5,12', 'Range,1,2,4 Iron,75,160,150,30,105,4000,100,0,14'].join('\n');
const parsed = () => parseSessionFile(practiceCsv, PRACTICE).session;
const pcFile = parsed();
pcFile.shots = pcFile.shots.filter(x => x.clubCode !== '4i'); // the PC's bag left the 4 iron out
addSessions(pc, [pcFile]);
await syncNow(pc, golferId);
const laggard = device(); // imports before its first sync, so it has no bag yet and keeps the 4 iron
addSessions(laggard, [parsed()]);
assert.equal(laggard.sessions[0].shots.length, 2);
await syncNow(laggard, golferId);
assert.deepEqual(find(laggard, pcFile.id).shots.map(x => x.clubCode), ['d'], 'takes the account’s shots');
assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM shots WHERE session_id = ?').get(pcFile.id).n, 1);

// 9. Someone else signing in on this device doesn't get (or overwrite) these sessions.
signedInAs = 'friend@example.com';
const friendId = await me();
assert.deepEqual(await syncNow(phone, friendId), { state: 'other-account' });
clearDevice(phone);
assert.equal(phone.settings.bag, null, "the previous account's bag is cleared too");
r = await syncNow(phone, friendId);
assert.deepEqual(r, { state: 'ok', pushed: 0, pulled: 0 }, "the friend's account starts empty");
signedInAs = 'golfer@example.com';

// 10. An expired sign-in stops the sync with 'signed-out'.
signedInAs = null;
await assert.rejects(syncNow(pc, golferId), e => e instanceof SyncError && e.state === 'signed-out');
signedInAs = 'golfer@example.com';

// 11. Old data from before sync (no modifiedAt) is made sync-ready.
const old = normalize({ sessions: [{ id: 'x1', importedAt: '2026-10-01T10:00:00.000Z', shots: [] }] });
assert.equal(old.sessions[0].modifiedAt, '2026-10-01T10:00:00.000Z');
assert.deepEqual(old.sync, { userId: null, cursor: '', lastSyncAt: null, settingsModifiedAt: null, settingsUploadedAt: null });
assert.equal(old.settings.bag, null);

// 12. Courses: an E6 round brings its course; the course list and the round's course, score and
// holes reach the other devices. The same course added on two devices offline is one course.
{
  const { autoCourse, addCourse, courseHistory } = await import('../js/courses.js');
  const ROUND = 'shot_data_export_2026-11-22T02_00_00.000000Z.csv';
  const roundCsv = [E6.split('\n')[0], 'Avondale Golf Club,1,1,Driver,81,201,181,41,121,2400,300,-1.5,12', 'Avondale Golf Club,2,2,7 Iron,70,150,140,70,100,6000,0,1,18'].join('\n');
  const home = device(), away = device();
  await syncNow(home, golferId); await syncNow(away, golferId); // both up to date first
  const s = parseSessionFile(roundCsv, ROUND).session;
  autoCourse(home, s); // as importFiles does
  addSessions(home, [s]);
  assert.equal(s.courseId, 'avondale-golf-club');
  await syncNow(home, golferId);
  assert.equal(home.courses.find(c => c.id === s.courseId).pending, undefined, 'course uploaded');
  await syncNow(away, golferId);
  assert.ok(away.courses.some(c => c.id === 'avondale-golf-club'), 'course list came down');
  assert.equal(find(away, s.id).courseId, 'avondale-golf-club');

  await tick();
  const r2 = find(away, s.id);
  r2.score = 88; r2.holes = 18; touch(r2);
  await syncNow(away, golferId);
  await syncNow(home, golferId);
  assert.deepEqual(courseHistory(home.sessions, 'avondale-golf-club').avg18, { rounds: 1, score: 88 });

  // Offline, both devices add the same course (typed differently); it's one course afterwards.
  addCourse(home, 'Highlands Golf Club', 'Post Falls, ID');
  addCourse(away, 'highlands golf club ', 'post falls, id');
  await syncNow(home, golferId); await syncNow(away, golferId); await syncNow(home, golferId);
  const highlands = d => d.courses.filter(c => c.id === 'highlands-golf-club--post-falls-id');
  assert.equal(highlands(home).length, 1);
  assert.deepEqual(highlands(away), highlands(home), 'the first spelling, everywhere');
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM courses WHERE id LIKE 'highlands%'").get().n, 1);
  // Courses are shared: another golfer sees the list, but not the rounds.
  signedInAs = 'friend@example.com';
  const friendDevice = device();
  await syncNow(friendDevice, friendId);
  assert.ok(friendDevice.courses.some(c => c.id === 'avondale-golf-club'));
  assert.equal(friendDevice.sessions.length, 0);
  signedInAs = 'golfer@example.com';
}

console.log('Sync checks passed.');
