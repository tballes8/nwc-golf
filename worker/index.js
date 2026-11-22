// NWC Golf API: a Cloudflare Worker that runs only for /api/* (see run_worker_first in
// wrangler.jsonc). Every other path is served straight from the static files.
//
// Sign-in is Cloudflare Access (team nwc-golf, application "NWC Golf API"). Access sits in
// front of /api/* and passes a signed token in the Cf-Access-Jwt-Assertion header. The
// Worker verifies that token itself (signature, audience, issuer, expiry), so a
// misconfigured Access rule can't expose anyone's data. Without a valid token, every
// request gets 401.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const email = await signedInEmail(request, env, url);
      if (!email) return json({ error: 'Not signed in.' }, 401);
      const user = await findOrCreateUser(env.DB, email);

      if (url.pathname === '/api/login' && request.method === 'GET') {
        // Reached after the Access sign-in page; send the golfer back to the app.
        return Response.redirect(new URL('/?signed-in', url).toString(), 302);
      }
      if (url.pathname === '/api/me' && request.method === 'GET') {
        return json({ email: user.email, userId: user.id });
      }
      return json({ error: 'Not found.' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'Server error.' }, 500);
    }
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** The signed-in email (lowercased), or null. */
async function signedInEmail(request, env, url) {
  // Local development only: `wrangler dev` with DEV_EMAIL in .dev.vars, which is never
  // committed or deployed. Ignored for anything but localhost.
  if (env.DEV_EMAIL && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return env.DEV_EMAIL.toLowerCase();
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    console.error('ACCESS_TEAM_DOMAIN or ACCESS_AUD is not set in wrangler.jsonc; refusing all sign-ins.');
    return null;
  }
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  const claims = await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
  return claims && typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
}

async function findOrCreateUser(db, email) {
  const find = () => db.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first();
  const found = await find();
  if (found) return found;
  await db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING')
    .bind(crypto.randomUUID(), email, new Date().toISOString())
    .run();
  return find(); // also covers two first requests racing each other
}

// ---- Cloudflare Access token check ------------------------------------------

/**
 * Verify an Access JWT. Returns its claims, or null if anything is off.
 * teamDomain: "https://nwc-golf.cloudflareaccess.com" (also the expected issuer).
 * aud: the Access application's Audience (AUD) tag.
 */
export async function verifyAccessJwt(token, { teamDomain, aud, now = Date.now() / 1000 }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(b64urlText(parts[0]));
    claims = JSON.parse(b64urlText(parts[1]));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const key = await accessKey(teamDomain, header.kid);
  if (!key) return null;
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), signed))) return null;

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return null;
  if (claims.iss !== teamDomain) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null; // allow a minute of clock skew
  return claims;
}

// Access's public signing keys, cached per Worker instance.
const KEY_TTL_MS = 60 * 60 * 1000;
const keyCache = new Map(); // teamDomain -> { at, keys: Map(kid -> CryptoKey) }

async function accessKey(teamDomain, kid) {
  let entry = keyCache.get(teamDomain);
  const age = entry ? Date.now() - entry.at : Infinity;
  // Refetch when stale, or when a token names a key we don't have (Access rotates keys),
  // but not more than once a minute so bad tokens can't hammer the certs endpoint.
  if (age > KEY_TTL_MS || (!entry.keys.has(kid) && age > 60 * 1000)) {
    entry = await loadKeys(teamDomain);
    keyCache.set(teamDomain, entry);
  }
  return entry.keys.get(kid) || null;
}

async function loadKeys(teamDomain) {
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const { keys = [] } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    const { kty, n, e } = jwk;
    map.set(jwk.kid, await crypto.subtle.importKey(
      'jwk', { kty, n, e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    ));
  }
  return { at: Date.now(), keys: map };
}

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function b64urlText(s) {
  return new TextDecoder().decode(b64urlBytes(s));
}
