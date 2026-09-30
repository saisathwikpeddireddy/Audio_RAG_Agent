// Self-healing seeder for the curated demo corpus (lib/demoCorpus.ts). Called in
// the background from /api/files: if any demo recording is missing from the
// shared "demo" manifest (or failed / got stuck a while ago), it copies the audio
// into Blob (fast, CORS-friendly playback, no hotlinking) and indexes it with the
// hand-written suggested questions. No secret or manual step needed after deploy.

import { put, list } from "@vercel/blob";
import { DEMO_SOURCES, wikimediaCandidates, type DemoSource } from "./demoCorpus";
import { getSessionManifest, saveLibraryEntry } from "./library";
import { runIngestion } from "./ingestPipeline";
import { DEMO_SESSION } from "./sessionServer";
import type { LibraryFile } from "./types";

const RETRY_AFTER_MS = 20 * 60 * 1000; // re-attempt a failed/stuck file after 20 min
const LEASE_PATH = "demo-seed/lease.json";
const LEASE_MS = 90_000; // one seeding run at a time across function instances
const BUDGET_MS = 55_000; // stay under the 60s function limit
const MAX_BYTES = 24_000_000; // Groq's transcription cap is 25 MB

// Wikimedia asks automated clients for a descriptive User-Agent.
const USER_AGENT =
  "AudioRAGWorkspace-DemoSeeder/1.0 (https://github.com/saisathwikpeddireddy/Audio_RAG_Agent)";

// Which demo files need (re)indexing right now, given the demo manifest.
export function missingDemoSources(manifest: LibraryFile[]): DemoSource[] {
  const byId = new Map(manifest.map((f) => [f.file_id, f]));
  const now = Date.now();
  return DEMO_SOURCES.filter((s) => {
    const f = byId.get(s.id);
    if (!f) return true;
    if (f.status === "ready") return false;
    return now - (Date.parse(f.indexed_at) || 0) > RETRY_AFTER_MS;
  });
}

// Best-effort cross-instance lease so a burst of first visitors doesn't kick off
// several parallel seeding runs (each would transcribe the same audio).
async function acquireLease(): Promise<boolean> {
  try {
    const { blobs } = await list({ prefix: LEASE_PATH, limit: 1 });
    if (blobs.length) {
      const res = await fetch(blobs[0].url, { cache: "no-store" });
      const lease = (await res.json().catch(() => ({}))) as { until?: number };
      if ((lease.until ?? 0) > Date.now()) return false;
    }
    await put(LEASE_PATH, JSON.stringify({ until: Date.now() + LEASE_MS }), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      cacheControlMaxAge: 0,
    });
    return true;
  } catch {
    return false;
  }
}

// Download the recording from the first working candidate URL and store it in
// Blob under a stable path. Returns the Blob URL.
async function copyToBlob(source: DemoSource): Promise<string> {
  const problems: string[] = [];
  for (const url of wikimediaCandidates(source.commonsFile)) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !/audio|ogg|mpeg|octet-stream/i.test(type)) {
        problems.push(`${res.status} ${type || "?"} ${url}`);
        continue;
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (data.byteLength > MAX_BYTES) {
        problems.push(`${(data.byteLength / 1e6).toFixed(1)} MB (too large) ${url}`);
        continue;
      }
      const ext = /mpeg|mp3/i.test(type) ? "mp3" : "ogg";
      const blob = await put(`demo/${source.id}.${ext}`, data, {
        access: "public",
        contentType: /mpeg|mp3/i.test(type) ? "audio/mpeg" : "audio/ogg",
        addRandomSuffix: false,
        cacheControlMaxAge: 31_536_000,
      });
      return blob.url;
    } catch (e) {
      problems.push(`${(e as Error).message} ${url}`);
    }
  }
  throw new Error(`Couldn't download demo audio: ${problems.join(" | ").slice(0, 400)}`);
}

async function seedOne(source: DemoSource, order: number, startedAt: number) {
  const entry: LibraryFile = {
    file_id: source.id,
    filename: source.filename,
    title: source.title,
    blob_url: source.sourcePage,
    audio_type: "speech",
    session_id: DEMO_SESSION,
    children: 0,
    indexed_at: new Date().toISOString(),
    suggestions: source.questions,
    status: "processing",
    demo: { order, blurb: source.blurb, credit: source.credit, sourcePage: source.sourcePage },
  };
  await saveLibraryEntry(DEMO_SESSION, entry);

  try {
    entry.blob_url = await copyToBlob(source);
  } catch (e) {
    const message = (e as Error).message;
    console.error(`[demo-seed] ${source.id}: ${message}`);
    await saveLibraryEntry(DEMO_SESSION, { ...entry, status: "failed", error: message });
    return;
  }

  const remaining = Math.max(10_000, BUDGET_MS - (Date.now() - startedAt));
  await runIngestion(DEMO_SESSION, entry, {
    suggestions: source.questions,
    timeoutMs: remaining,
  });
}

// Seed whatever is missing. Returns the ids it started (empty if nothing to do
// or another instance holds the lease). Safe to call on every request.
export async function ensureDemoCorpus(): Promise<string[]> {
  const todo = missingDemoSources(await getSessionManifest(DEMO_SESSION));
  if (!todo.length || !(await acquireLease())) return [];
  const startedAt = Date.now();
  console.log(`[demo-seed] seeding ${todo.map((s) => s.id).join(", ")}`);
  await Promise.all(
    todo.map((s) =>
      seedOne(s, DEMO_SOURCES.indexOf(s), startedAt).catch((e) => {
        console.error(`[demo-seed] ${s.id}: ${(e as Error).message}`);
      })
    )
  );
  return todo.map((s) => s.id);
}
