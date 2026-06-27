// Lightweight, database-free analytics. Each tracked action is written as one
// small JSON blob under `analytics/events/{day}/`, with coarse geo (from Vercel's
// IP headers - never the raw IP), referrer, and an estimated cost. The admin
// dashboard reads + aggregates them. Writes are best-effort and never throw into
// the request path. Low-traffic by design (a portfolio demo), so one-blob-per-
// event keeps it race-free and simple.

import { put, list } from "@vercel/blob";
import { sessionIdFromRequest } from "./sessionServer";

export type EventType =
  | "visit"
  | "search"
  | "upload"
  | "ingest_done"
  | "play"
  | "download"
  | "delete"
  | "error";

export interface AnalyticsEvent {
  ts: number;
  type: EventType | string;
  sid: string;
  country?: string;
  region?: string;
  city?: string;
  referer?: string;
  ua?: string;
  costCents?: number;
  meta?: Record<string, string | number>;
}

export interface EventContext {
  sid: string;
  country?: string;
  region?: string;
  city?: string;
  referer?: string;
  ua?: string;
}

// Pull session + coarse geo from a request's headers (Vercel populates the
// x-vercel-ip-* headers in production; they're simply absent locally).
export function contextFromRequest(request: Request): EventContext {
  const h = request.headers;
  const dec = (v: string | null) => {
    if (!v) return undefined;
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  return {
    sid: sessionIdFromRequest(request) ?? "anon",
    country: h.get("x-vercel-ip-country") ?? undefined,
    region: h.get("x-vercel-ip-country-region") ?? undefined,
    city: dec(h.get("x-vercel-ip-city")),
    referer: h.get("referer") ?? undefined,
    ua: h.get("user-agent")?.slice(0, 180) ?? undefined,
  };
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

// Record one event. Best-effort: any failure is swallowed so analytics can never
// break a user action. Prefer calling via waitUntil() so it doesn't add latency.
export async function track(
  ctx: EventContext,
  type: EventType,
  opts?: { costCents?: number; referer?: string; meta?: Record<string, string | number> }
): Promise<void> {
  try {
    const ts = Date.now();
    const ev: AnalyticsEvent = {
      ts,
      type,
      sid: ctx.sid || "anon",
      country: ctx.country,
      region: ctx.region,
      city: ctx.city,
      referer: opts?.referer ?? ctx.referer,
      ua: ctx.ua,
      costCents: opts?.costCents,
      meta: opts?.meta,
    };
    const rand = (globalThis.crypto?.randomUUID?.() ?? `${ts}${Math.random()}`).slice(0, 8);
    await put(`analytics/events/${dayKey(ts)}/${ts}-${rand}.json`, JSON.stringify(ev), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      cacheControlMaxAge: 31_536_000,
    });
  } catch {
    // analytics must never break the request
  }
}

// Read recent events for the dashboard: newest first, bounded by day window + a
// hard cap so aggregation stays cheap as volume grows.
export async function readEvents(maxDays = 30, cap = 5000): Promise<AnalyticsEvent[]> {
  const cutoff = Date.now() - maxDays * 86_400_000;
  const found: Array<{ url: string; ts: number }> = [];
  let cursor: string | undefined;
  do {
    const r = await list({ prefix: "analytics/events/", cursor });
    for (const b of r.blobs) {
      const m = b.pathname.match(/\/(\d+)-[a-z0-9]+\.json$/i);
      const ts = m ? Number(m[1]) : 0;
      if (ts >= cutoff) found.push({ url: b.url, ts });
    }
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);

  found.sort((a, b) => b.ts - a.ts);
  const slice = found.slice(0, cap);

  const events: AnalyticsEvent[] = [];
  const BATCH = 24;
  for (let i = 0; i < slice.length; i += BATCH) {
    const chunk = slice.slice(i, i + BATCH);
    const res = await Promise.all(
      chunk.map((p) =>
        fetch(p.url, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      )
    );
    for (const e of res) if (e) events.push(e as AnalyticsEvent);
  }
  return events;
}
