"use client";

// Client-side analytics beacon for actions that only happen in the browser
// (page visit, play, download). Fire-and-forget; never blocks the UI.

import { sessionHeaders } from "./session";

export function track(type: "visit" | "play" | "download", meta?: Record<string, string | number>) {
  try {
    const body = JSON.stringify({
      type,
      referer: typeof document !== "undefined" ? document.referrer : undefined,
      meta,
    });
    fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // ignore
  }
}
