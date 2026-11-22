// Run: node tests/worker.mjs
// Checks the API Worker's Cloudflare Access token check and routes, with a fake Access
// signing key and a fake D1 database. No network or Wrangler needed.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18
const { default: worker, verifyAccessJwt } = await import('../worker/index.js');

const TEAM = 'https://nwc-golf.cloudflareaccess.com';
const AUD = 'test-aud-tag';
const now = Math.floor(Date.now() / 1000);

// A fake Access signing key, served at the certs URL by a stubbed fetch.
const algo = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const real = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']);
const forger = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']); // not published by "Access"
const jwk = { ...(await crypto.subtle.exportKey('jwk', real.publicKey)), kid: 'k1', use: 'sig' };
let certFetches = 0;
globalThis.fetch = async url => {
  assert.equal(url, `${TEAM}/cdn-cgi/access/certs`);
  certFetches++;
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
};

const b64url = bytes => Buffer.from(bytes).toString('base64url');
async function token(claims, { key = real.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const head = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
const good = { aud: [AUD], iss: TEAM, email: 'Golfer@Example.com', exp: now + 3600, iat: now, nbf: now };
const verify = t => verifyAccessJwt(t, { teamDomain: TEAM, aud: AUD });

// Token check
assert.equal((await verify(await token(good))).email, 'Golfer@Example.com');
assert.equal(await verify(await token({ ...good, aud: ['another-app'] })), null, 'wrong audience');
assert.equal(await verify(await token({ ...good, iss: 'https://evil.cloudflareaccess.com' })), null, 'wrong issuer');
assert.equal(await verify(await token({ ...good, exp: now - 10 })), null, 'expired');
assert.equal(await verify(await token({ ...good, exp: undefined })), null, 'no expiry');
assert.equal(await verify(await token({ ...good, nbf: now + 600 })), null, 'not valid yet');
assert.equal(await verify(await token(good, { key: forger.privateKey })), null, 'signed by someone else');
assert.equal(await verify(await token(good, { kid: 'unknown' })), null, 'unknown key ID');
assert.equal(await verify(await token(good, { alg: 'none' })), null, 'alg none');
assert.equal(await verify('not.a.token'), null);
assert.equal(await verify(''), null);
const [h, , s] = (await token(good)).split('.');
assert.equal(await verify(`${h}.${b64url(JSON.stringify({ ...good, email: 'someone-else@example.com' }))}.${s}`), null, 'claims edited after signing');
assert.equal(certFetches, 1, 'Access keys are cached, and an unknown key ID does not refetch within a minute');

// A tiny stand-in for D1: just enough SQL for the users table.
function fakeDB() {
  const users = [];
  return {
    users,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.startsWith('SELECT id, email FROM users WHERE email = ?')) return users.find(u => u.email === args[0]) || null;
              throw new Error(`unexpected SQL: ${sql}`);
            },
            async run() {
              if (sql.startsWith('INSERT INTO users')) {
                const [id, email, created_at] = args;
                if (!users.some(u => u.email === email)) users.push({ id, email, created_at });
                return {};
              }
              throw new Error(`unexpected SQL: ${sql}`);
            },
          };
        },
      };
    },
  };
}

// Routes
const env = { DB: fakeDB(), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const call = (path, headers = {}, e = env) => worker.fetch(new Request(`https://golf.nwc-analytics.com${path}`, { headers }), e);
const signedIn = { 'cf-access-jwt-assertion': await token(good) };

let res = await call('/api/me');
assert.equal(res.status, 401, 'no token');
res = await call('/api/me', { 'cf-access-jwt-assertion': await token({ ...good, aud: ['x'] }) });
assert.equal(res.status, 401, 'bad token');

res = await call('/api/me', signedIn);
assert.equal(res.status, 200);
assert.equal(res.headers.get('cache-control'), 'no-store');
const me = await res.json();
assert.equal(me.email, 'golfer@example.com', 'email lowercased');
assert.match(me.userId, /^[0-9a-f-]{36}$/);
assert.equal((await (await call('/api/me', signedIn)).json()).userId, me.userId, 'same user on the next request');
assert.equal(env.DB.users.length, 1);

res = await call('/api/login', signedIn);
assert.equal(res.status, 302);
assert.equal(res.headers.get('location'), 'https://golf.nwc-analytics.com/?signed-in');

assert.equal((await call('/api/nope', signedIn)).status, 404);

// Fails closed when the Access settings are missing.
assert.equal((await call('/api/me', signedIn, { ...env, ACCESS_AUD: '' })).status, 401);

// The local-development stand-in only works on localhost.
const devEnv = { ...env, DEV_EMAIL: 'dev@example.com' };
assert.equal((await call('/api/me', {}, devEnv)).status, 401, 'DEV_EMAIL ignored on the real domain');
res = await worker.fetch(new Request('http://localhost:8787/api/me'), devEnv);
assert.equal((await res.json()).email, 'dev@example.com');

console.log('Worker checks passed.');
