// Run: node tests/worker.mjs   (Node 22.13+ for the built-in SQLite)
// Checks the API Worker: the Cloudflare Access token check, and the routes against a real
// SQLite database built from migrations/. No network or Wrangler needed.
import assert from 'node:assert/strict';
import { testDB, fakeAccess, TEAM, AUD } from './helpers.mjs';

const { default: worker, verifyAccessJwt } = await import('../worker/index.js');
const access = await fakeAccess();
const forger = await fakeAccess(); // a key "Access" never published
const now = Math.floor(Date.now() / 1000);

let certFetches = 0;
globalThis.fetch = async url => {
  assert.equal(url, `${TEAM}/cdn-cgi/access/certs`);
  certFetches++;
  return new Response(JSON.stringify(access.certs), { headers: { 'content-type': 'application/json' } });
};

// ---- Token check ----
const good = access.claimsFor('Golfer@Example.com');
const verify = t => verifyAccessJwt(t, { teamDomain: TEAM, aud: AUD });
const token = (claims, opts) => access.token(claims, opts);

assert.equal((await verify(await token(good))).email, 'Golfer@Example.com');
assert.equal(await verify(await token({ ...good, aud: ['another-app'] })), null, 'wrong audience');
assert.equal(await verify(await token({ ...good, iss: 'https://evil.cloudflareaccess.com' })), null, 'wrong issuer');
assert.equal(await verify(await token({ ...good, exp: now - 10 })), null, 'expired');
assert.equal(await verify(await token({ ...good, exp: undefined })), null, 'no expiry');
assert.equal(await verify(await token({ ...good, nbf: now + 600 })), null, 'not valid yet');
assert.equal(await verify(await forger.token(good)), null, 'signed by someone else');
assert.equal(await verify(await token(good, { kid: 'unknown' })), null, 'unknown key ID');
assert.equal(await verify(await token(good, { alg: 'none' })), null, 'alg none');
assert.equal(await verify('not.a.token'), null);
assert.equal(await verify(''), null);
const [h, , s] = (await token(good)).split('.');
assert.equal(await verify(`${h}.${access.b64url(JSON.stringify({ ...good, email: 'someone-else@example.com' }))}.${s}`), null, 'claims edited after signing');
assert.equal(certFetches, 1, 'Access keys are cached, and an unknown key ID does not refetch within a minute');

// ---- Routes ----
const env = { DB: testDB(), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const as = async email => ({ 'cf-access-jwt-assertion': await token(access.claimsFor(email)) });
const golfer = await as('Golfer@Example.com');
const other = await as('other@example.com');
const call = (path, { headers = {}, method = 'GET', body, e = env } = {}) => worker.fetch(new Request(`https://golf.nwc-analytics.com${path}`, {
  method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), e);

let res = await call('/api/me');
assert.equal(res.status, 401, 'no token');
res = await call('/api/me', { headers: { 'cf-access-jwt-assertion': await token({ ...good, aud: ['x'] }) } });
assert.equal(res.status, 401, 'bad token');

res = await call('/api/me', { headers: golfer });
assert.equal(res.status, 200);
assert.equal(res.headers.get('cache-control'), 'no-store');
const me = await res.json();
assert.equal(me.email, 'golfer@example.com', 'email lowercased');
assert.match(me.userId, /^[0-9a-f-]{36}$/);
assert.equal((await (await call('/api/me', { headers: golfer })).json()).userId, me.userId, 'same user on the next request');

res = await call('/api/login', { headers: golfer });
assert.equal(res.status, 302);
assert.equal(res.headers.get('location'), 'https://golf.nwc-analytics.com/?signed-in');
assert.equal((await call('/api/nope', { headers: golfer })).status, 404);

// Fails closed when the Access settings are missing.
assert.equal((await call('/api/me', { headers: golfer, e: { ...env, ACCESS_AUD: '' } })).status, 401);

// The local-development stand-in only works on localhost.
const devEnv = { ...env, DEV_EMAIL: 'dev@example.com' };
assert.equal((await call('/api/me', { e: devEnv })).status, 401, 'DEV_EMAIL ignored on the real domain');
res = await worker.fetch(new Request('http://localhost:8787/api/me'), devEnv);
assert.equal((await res.json()).email, 'dev@example.com');

// ---- Sessions ----
const T = n => new Date(Date.UTC(2026, 10, 22, 12, 0, n)).toISOString(); // T(1) < T(2) < ...
const session = (over = {}) => ({
  source: 'e6-connect', kind: 'sim', fileName: 'shot_data_export.csv', date: '2026-11-19', label: 'Oslo Golf Club', units: 'yd',
  dateGuessed: true, excluded: false, importedAt: T(1), modifiedAt: T(1),
  shots: [
    { clubCode: 'd', carry: 180, total: 200, ballSpeed: 120, clubSpeed: 80, smash: 1.5, side: null, apex: 40, launchAngle: 12, launchDir: -1.5, spin: 2419, hole: 1, shotNo: 1, clubName: 'Driver', backSpin: 2400, sideSpin: 300 },
    { clubCode: 'aw', carry: 90, ballSpeed: 75, hole: 1, shotNo: 2, clubName: 'Gap Wedge' },
  ],
  ...over,
});
const put = (id, body, headers = golfer) => call(`/api/sessions/${id}`, { method: 'PUT', body, headers });
const del = (id, modifiedAt, headers = golfer) => call(`/api/sessions/${id}`, { method: 'DELETE', body: { modifiedAt }, headers });
const list = async (since = '', headers = golfer) => (await call(`/api/sessions?since=${encodeURIComponent(since)}`, { headers })).json();

assert.equal((await put('abc123', session())).status, 200);
assert.deepEqual(await (await put('abc123', session())).json(), { applied: true }, 'same version again is fine');
let page = await list();
assert.equal(page.sessions.length, 1);
assert.equal(page.more, false);
const got = page.sessions[0];
assert.equal(got.label, 'Oslo Golf Club');
assert.equal(got.dateGuessed, true);
assert.equal(got.shots.length, 2);
const { side, ...sentWithoutEmpty } = session().shots[0]; // side is null: empty fields come back left out
assert.deepEqual(got.shots[0], sentWithoutEmpty, 'shots come back as they were sent');
assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM shots').get().n, 2);

// Nothing new since the cursor.
assert.equal((await list(page.cursor)).sessions.length, 0);

// A newer edit wins; an older one is ignored and the server's version comes back.
assert.deepEqual(await (await put('abc123', session({ date: '2026-11-18', dateGuessed: false, modifiedAt: T(5) }))).json(), { applied: true });
res = await (await put('abc123', session({ date: '2026-11-01', modifiedAt: T(3) }))).json();
assert.equal(res.applied, false);
assert.equal(res.session.date, '2026-11-18');
assert.equal(res.session.shots, undefined, 'shots not sent back');
page = await list(page.cursor);
assert.equal(page.sessions.length, 1, 'the edit shows up after the cursor');
assert.equal(page.sessions[0].date, '2026-11-18');
assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM shots').get().n, 2, 'shots are not duplicated by edits');

// A fresh import of a session the server has doesn't overwrite it, even with a newer time.
res = await (await put('abc123', session({ fresh: true, importedAt: T(9), modifiedAt: T(9) }))).json();
assert.equal(res.applied, false);
assert.equal(res.session.date, '2026-11-18', 'the edit made elsewhere survives');

// Delete: older deletes are ignored; a newer one marks it deleted and removes the shots.
await del('abc123', T(4));
assert.equal((await list()).sessions[0].deleted, undefined, 'older delete ignored');
await del('abc123', T(6));
page = await list(page.cursor);
assert.deepEqual(page.sessions[0], { id: 'abc123', deleted: true, modifiedAt: T(6) });
assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM shots').get().n, 0, 'shots removed');
// An older upload doesn't bring it back, and the device is told it's deleted.
res = await (await put('abc123', session({ modifiedAt: T(5) }))).json();
assert.deepEqual(res, { applied: false, session: { id: 'abc123', deleted: true, modifiedAt: T(6) } });
// Importing it again later does (fresh or not), with its shots.
assert.deepEqual(await (await put('abc123', session({ fresh: true, importedAt: T(7), modifiedAt: T(7) }))).json(), { applied: true });
assert.equal((await list()).sessions[0].shots.length, 2);

// Each user sees only their own sessions; the same session ID can exist for both.
assert.equal((await list('', other)).sessions.length, 0);
await put('abc123', session({ label: 'Theirs' }), other);
assert.equal((await list('', other)).sessions[0].label, 'Theirs');
assert.equal((await list()).sessions[0].label, 'Oslo Golf Club');
await del('abc123', T(50), other);
assert.equal((await list()).sessions[0].deleted, undefined, "deleting yours doesn't touch mine");

// Paging: 30 sessions come back in pages of 25.
for (let i = 0; i < 30; i++) await put(`p${i}`, session({ fresh: true }));
let all = [], cursor = '', pages = 0;
for (let more = true; more; pages++) { const p = await list(cursor); all.push(...p.sessions); cursor = p.cursor; more = p.more; }
assert.equal(pages, 2);
assert.equal(new Set(all.map(x => x.id)).size, 31);

// Bad input is refused with a reason, and nothing is stored.
const bad = async (body, id = 'bad1') => { const r = await put(id, body); assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80)); return (await r.json()).error; };
assert.match(await bad(session({ source: 'garmin' })), /source/);
assert.match(await bad(session({ kind: 'moon' })), /kind/);
assert.match(await bad(session({ date: '19/11/2026' })), /date/);
assert.match(await bad(session({ modifiedAt: 'yesterday' })), /modifiedAt/);
assert.match(await bad(session({ shots: [] })), /shots/);
assert.match(await bad(session({ shots: [{ carry: 100 }] })), /club/);
assert.match(await bad(session({ shots: [{ clubCode: 'd', carry: 'far' }] })), /carry/);
assert.match(await bad(session({ shots: [{ clubCode: 'd', carry: 100, model: { nested: 1 } }] })), /model/);
assert.match(await bad(session({ score: 72.5 })), /score/);
assert.equal((await (await put('bad1', '"just text"')).json()).error, 'Send the session as a JSON object.');
assert.equal((await call('/api/sessions/has%20space', { method: 'PUT', body: session(), headers: golfer })).status, 400, 'odd IDs refused');
assert.equal((await call('/api/sessions/x', { method: 'POST', body: session(), headers: golfer })).status, 405);
assert.equal((await call('/api/sessions?since=garbage', { headers: golfer })).status, 400);
assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM sessions WHERE id = 'bad1'").get().n, 0);
// __proto__ in a shot is stored as plain data, not as an object prototype.
assert.equal((await put('proto1', session({ shots: [JSON.parse('{"clubCode":"d","carry":100,"__proto__":"x"}')] }))).status, 200);
const protoShot = (await list(cursor)).sessions.find(x => x.id === 'proto1').shots[0];
assert.equal(Object.getPrototypeOf(protoShot), Object.prototype);
assert.equal(Object.hasOwn(protoShot, '__proto__'), true);
// Too many shots, an empty body, too large.
assert.equal((await put('big', session({ shots: Array.from({ length: 2001 }, () => ({ clubCode: 'd', carry: 1 })) }))).status, 400);
assert.equal((await call('/api/sessions/big', { method: 'PUT', headers: golfer })).status, 400, 'empty body');
const tooBig = await worker.fetch(new Request('https://golf.nwc-analytics.com/api/sessions/big', {
  method: 'PUT', headers: { ...golfer, 'content-type': 'application/json' }, body: 'x'.repeat(1_000_001),
}), env);
assert.equal(tooBig.status, 413);

console.log('Worker checks passed.');
