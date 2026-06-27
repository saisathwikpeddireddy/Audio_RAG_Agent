// Client beacon sink for browser-only events (visit / play / download). Writes
// the event in the background and returns 204 immediately.

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { contextFromRequest, track, type EventType } from "@/lib/analytics";

export const runtime = "nodejs";

const ALLOWED = new Set<EventType>(["visit", "play", "download"]);

function sanitizeMeta(m: unknown): Record<string, string | number> | undefined {
  if (!m || typeof m !== "object") return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v.slice(0, 120);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    if (Object.keys(out).length >= 10) break;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      type?: string;
      referer?: string;
      meta?: unknown;
    };
    const type = String(body.type ?? "") as EventType;
    if (!ALLOWED.has(type)) return new NextResponse(null, { status: 400 });

    const ctx = contextFromRequest(request);
    waitUntil(
      track(ctx, type, {
        referer: typeof body.referer === "string" ? body.referer.slice(0, 300) : undefined,
        meta: sanitizeMeta(body.meta),
      })
    );
    return new NextResponse(null, { status: 204 });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
