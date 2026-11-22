// Small helpers shared by the API Worker's modules.

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Thrown for a bad request; the router turns it into a JSON error with this status. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Read a JSON request body, refusing anything over maxBytes. */
export async function readJSON(request, maxBytes) {
  if (Number(request.headers.get('content-length')) > maxBytes) throw new HttpError(413, 'Request is too large.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request is too large.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}
