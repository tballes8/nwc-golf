// Sign-in status for cloud sync. Cloudflare Access sits in front of /api/*; see worker/index.js.

export const SIGN_IN_URL = '/api/login';

/**
 * Ask the API who is signed in.
 * Returns one of:
 *   { state: 'signed-in', email, userId }
 *   { state: 'signed-out' }   no Access login, or it expired
 *   { state: 'offline' }      no connection
 *   { state: 'unavailable' }  no API here (e.g. the plain local web server)
 *   { state: 'error' }        the API answered with an error
 */
export async function checkAccount() {
  if (!navigator.onLine) return { state: 'offline' };
  let res;
  try {
    // Without a login, Access answers with a redirect to its sign-in page; 'manual'
    // stops fetch from following it, so it shows up as an opaque redirect.
    res = await fetch('/api/me', { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
  } catch {
    return { state: 'offline' };
  }
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) return { state: 'signed-out' };
  if (res.status === 404) return { state: 'unavailable' };
  if (!res.ok) return { state: 'error' };
  try {
    const me = await res.json();
    return { state: 'signed-in', email: me.email, userId: me.userId };
  } catch {
    return { state: 'error' };
  }
}

/** Sign out of Cloudflare Access without leaving the app (the Home Screen app has no back button). */
export async function signOut() {
  try {
    await fetch('/cdn-cgi/access/logout', { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
  } catch { /* offline: the login stays until it expires */ }
}
