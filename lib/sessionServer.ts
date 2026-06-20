// Server-side session helpers. Each visitor gets an isolated workspace keyed by
// a `sid` they send on every request (header, with a cookie fallback). The
// special "demo" session is the shared, read-only sample corpus everyone sees.

export const DEMO_SESSION = "demo";

// A client sid must look like our generated ids and must NOT be "demo" (so a
// visitor can never write into the shared demo corpus).
const SID_RE = /^[a-z0-9-]{8,64}$/i;

export function isValidSid(s: string | null | undefined): s is string {
  return !!s && SID_RE.test(s) && s !== DEMO_SESSION;
}

// Resolve the caller's session id from the `x-session-id` header, falling back
// to a `sid` cookie. Returns null if absent/invalid.
export function sessionIdFromRequest(request: Request): string | null {
  const header = request.headers.get("x-session-id");
  if (isValidSid(header)) return header;

  const cookie = request.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  const fromCookie = m ? decodeURIComponent(m[1]) : null;
  return isValidSid(fromCookie) ? fromCookie : null;
}
