"use client";

// Client-side session identity. A `sid` cookie scopes this visitor's workspace
// (uploads + search) so concurrent visitors never see or clobber each other's
// files. It lives for 24h, so a refresh keeps your workspace for the session but
// nothing persists long-term (a daily cron purges expired sessions server-side).

const SID_RE = /^[a-z0-9-]{8,64}$/i;
const MAX_AGE = 60 * 60 * 24; // 24h

function readCookie(): string {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

// Return the current session id, generating + persisting one on first use.
export function getSessionId(): string {
  let sid = readCookie();
  if (!SID_RE.test(sid) || sid === "demo") {
    sid =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    document.cookie = `sid=${sid}; path=/; max-age=${MAX_AGE}; samesite=lax`;
  }
  return sid;
}

// Header to attach to every API call so the server scopes the request.
export function sessionHeaders(): Record<string, string> {
  return { "x-session-id": getSessionId() };
}
