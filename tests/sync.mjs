// Run: node tests/sync.mjs   (Node 22.13+)
// End-to-end sync: several "devices" (each its own app data) sync through the real Worker and
// a real SQLite database built from migrations/, the way the app does it.
import assert from 'node:assert/strict';
import { testDB, fakeAccess, TEAM, AUD } from './helpers.mjs';
import { parseSessionFile } from '../js/parse.js';
import { normalize, addSessions, touch, deleteSession, readBackup } from '../js/store.js';
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

// 9. Someone else signing in on this device doesn't get (or overwrite) these sessions.
signedInAs = 'friend@example.com';
const friendId = await me();
assert.deepEqual(await syncNow(phone, friendId), { state: 'other-account' });
clearDevice(phone);
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
assert.deepEqual(old.sync, { userId: null, cursor: '', lastSyncAt: null });

console.log('Sync checks passed.');
