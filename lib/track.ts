"use client";

// Client-side analytics beacon for actions that only happen in the browser
// (page visit, first real interaction, play, download). Fire-and-forget; never
// blocks the UI.

import { sessionHeaders } from "./session";

export type ClientEvent = "visit" | "engaged" | "play" | "download";

export function track(type: ClientEvent, meta?: Record<string, string | number>) {
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

// Fire "engaged" once, on the first genuine interaction with the page: a click,
// tap, key press, or a real scroll. Bots and link unfurlers that merely load the
// page (and run its JS) never do this, so the dashboard counts a visitor as human
// only once it arrives. Returns a cleanup function.
export function trackFirstInteraction(): () => void {
  const loadedAt = Date.now();
  const types = ["pointerdown", "keydown", "touchstart", "scroll"] as const;
  const onEvent = (e: Event) => {
    if (!e.isTrusted) return; // synthetic events don't count
    if (e.type === "scroll" && window.scrollY < 40) return; // ignore layout nudges
    cleanup();
    track("engaged", { via: e.type, afterMs: Date.now() - loadedAt });
  };
  const cleanup = () => types.forEach((t) => window.removeEventListener(t, onEvent, true));
  types.forEach((t) => window.addEventListener(t, onEvent, { capture: true, passive: true }));
  return cleanup;
}
