// End-to-end self-test for search + analytics. Runs a real search through the
// /api/search handler and a "play" beacon through the /api/track handler (the
// exact code visitors hit), then reads the analytics store back to confirm both
// events landed. Events are recorded under a "selftest-" session so the
// dashboard files them as test traffic, never as visitors.
//
// GET /api/admin/selftest?q=...  (x-admin-key: ADMIN_PASSWORD). Preview
// deployments sit behind Vercel Authentication, so there it runs without a key.

import { NextResponse } from "next/server";
import { list } from "@vercel/blob";
import { POST as searchPOST } from "@/app/api/search/route";
import { POST as trackPOST } from "@/app/api/track/route";
import { getSessionManifest } from "@/lib/library";
import { DEMO_SESSION } from "@/lib/sessionServer";
import { DEMO_SOURCES } from "@/lib/demoCorpus";
import { config } from "@/lib/config";
import type { AnalyticsEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const READBACK_MS = 12_000;

function authorized(request: Request): boolean {
  if (process.env.VERCEL_ENV === "preview" || process.env.NODE_ENV === "development") return true;
  const password = process.env.ADMIN_PASSWORD;
  return !!password && request.headers.get("x-admin-key") === password;
}

// Poll today's analytics events for this session until every expected type shows up.
async function readBack(sid: string, since: number, expect: string[]) {
  const deadline = Date.now() + READBACK_MS;
  const seen = new Map<string, AnalyticsEvent>();
  const fetched = new Set<string>();
  while (Date.now() < deadline) {
    const day = new Date().toISOString().slice(0, 10);
    const { blobs } = await list({ prefix: `analytics/events/${day}/`, limit: 1000 });
    const fresh = blobs.filter((b) => {
      const ts = Number(b.pathname.match(/\/(\d+)-[a-z0-9]+\.json$/i)?.[1] ?? 0);
      return ts >= since - 1000 && !fetched.has(b.url);
    });
    for (const b of fresh) {
      fetched.add(b.url);
      const e = (await fetch(b.url, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)) as AnalyticsEvent | null;
      if (e?.sid === sid) seen.set(e.type, e);
    }
    if (expect.every((t) => seen.has(t))) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return Object.fromEntries(expect.map((t) => [t, seen.has(t)]));
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() || DEMO_SOURCES[0].questions[0];
  const sid = `selftest-${Math.random().toString(36).slice(2, 10)}`;
  const started = Date.now();
  const headers = {
    "content-type": "application/json",
    "x-session-id": sid,
    "user-agent": "Mozilla/5.0 (compatible; AudioRAG-selftest/1.0)",
  };
  const origin = url.origin;

  // 1. A real search (retrieval + grounded answer), recorded as a "search" event.
  const t0 = Date.now();
  const searchRes = await searchPOST(
    new Request(`${origin}/api/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    })
  );
  const searchBody = (await searchRes.json().catch(() => ({}))) as {
    answer?: string;
    hits?: Array<{
      title?: string;
      file_path: string;
      start_time_ms: number;
      end_time_ms: number;
      _score: number;
      child_text: string;
    }>;
    error?: string;
    message?: string;
    note?: string;
  };
  const searchMs = Date.now() - t0;

  // 2. The browser beacon a "Play" click sends.
  const trackRes = await trackPOST(
    new Request(`${origin}/api/track`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "play", meta: { selftest: 1 } }),
    })
  );

  // 3. Did both land in the analytics store?
  let recorded: Record<string, boolean> = {};
  let storeError: string | undefined;
  try {
    recorded = await readBack(sid, started, ["search", "play"]);
  } catch (e) {
    storeError = (e as Error).message;
  }

  const demo = (await getSessionManifest(DEMO_SESSION)).map((f) => ({
    id: f.file_id,
    status: f.status,
    chunks: f.children,
    audio: f.blob_url,
    error: f.error,
  }));

  const hits = (searchBody.hits ?? []).map((h) => ({
    title: h.title,
    at: `${Math.floor(h.start_time_ms / 60000)}:${String(Math.floor((h.start_time_ms / 1000) % 60)).padStart(2, "0")}`,
    seconds: Math.round((h.end_time_ms - h.start_time_ms) / 1000),
    score: Math.round((h._score ?? 0) * 100),
    text: h.child_text?.slice(0, 220),
  }));

  const ok =
    searchRes.ok && hits.length > 0 && trackRes.status === 204 && recorded.search && recorded.play;

  return NextResponse.json({
    ok,
    sid,
    query,
    search: {
      status: searchRes.status,
      ms: searchMs,
      answer: searchBody.answer,
      error: searchBody.error ? `${searchBody.error}: ${searchBody.message ?? ""}` : undefined,
      note: searchBody.note,
      hits,
    },
    playBeacon: { status: trackRes.status },
    recorded,
    storeError,
    demo,
    env: {
      groq: !!config.groqApiKey,
      gemini: !!config.geminiApiKey,
      pinecone: !!config.pineconeApiKey,
      blob: !!process.env.BLOB_READ_WRITE_TOKEN,
      adminPassword: !!process.env.ADMIN_PASSWORD,
      vercelEnv: process.env.VERCEL_ENV ?? "local",
    },
  });
}
