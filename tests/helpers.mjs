// Test helpers: a D1 stand-in on Node's built-in SQLite (Node 22.13+), loaded with the real
// migrations, and a fake Cloudflare Access that signs tokens the Worker accepts.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

/** A database with the same calls the Worker uses from D1: prepare/bind/first/all/run and batch. */
export function testDB() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));

  const plain = row => (row ? { ...row } : null);
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async () => plain(db.prepare(sql).get(...args)),
    all: async () => ({ results: db.prepare(sql).all(...args).map(plain) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    runNow: () => db.prepare(sql).run(...args),
  });
  return {
    sqlite: db,
    prepare: sql => statement(sql),
    async batch(statements) { // all or nothing, like D1
      db.exec('BEGIN');
      try {
        const out = statements.map(s => s.runNow());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

export const TEAM = 'https://nwc-golf.cloudflareaccess.com';
export const AUD = 'test-aud-tag';

/** A fake Access signing key. Serve `certs` at the certs URL; `token(claims)` signs a JWT. */
export async function fakeAccess() {
  const algo = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const pair = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', use: 'sig' };
  const b64url = bytes => Buffer.from(bytes).toString('base64url');
  async function token(claims, { key = pair.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
    const head = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  }
  const now = Math.floor(Date.now() / 1000);
  const claimsFor = email => ({ aud: [AUD], iss: TEAM, email, exp: now + 3600, iat: now, nbf: now });
  return { certs: { keys: [jwk] }, token, claimsFor, b64url };
}
