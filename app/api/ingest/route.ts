// Phase 1 (server): transcribe a blob URL with Groq, chunk parent/child, upsert
// children to Pinecone. To survive serverless timeouts on long files, the heavy
// work runs in the background (waitUntil) and the request returns 202 right
// away. Status (processing -> ready/failed) is persisted to the library
// manifest, which the client polls. Re-ingesting a file is idempotent: child
// IDs are deterministic, so a retry overwrites rather than duplicates.

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { transcribeUrl } from "@/lib/groq";
import { buildParents, buildChildRecords } from "@/lib/chunking";
import { upsertChildren } from "@/lib/pinecone";
import { suggestQuestions } from "@/lib/suggest";
import { saveLibraryEntry } from "@/lib/library";
import { classifyError } from "@/lib/errors";
import type { LibraryFile } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60; // hard ceiling; the soft timeout below fires first

// Leave headroom under maxDuration so we can persist a "failed" status before
// the platform kills the function on an over-long file.
const SOFT_TIMEOUT_MS = 55_000;

function fileIdFrom(url: string, filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  const safe = stem.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32);
  // Short hash of the blob URL keeps ids stable & unique per upload.
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
  return `${safe}_${(h >>> 0).toString(36)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// The actual transcription + indexing work. Returns the children count and the
// grounded example questions, or throws on failure / timeout.
async function indexFile(url: string, fileId: string, type: string) {
  const segments = await transcribeUrl(url);
  if (!segments.length) throw new Error("No speech detected in this audio.");

  const parents = buildParents(segments);
  const records = buildChildRecords(parents, url, fileId, type);
  if (records.length) await upsertChildren(records);

  const transcript = parents.map((p) => p.text).join("\n");
  const suggestions = await suggestQuestions(transcript);
  return { children: records.length, suggestions };
}

async function runIngestion(base: LibraryFile) {
  try {
    const { children, suggestions } = await withTimeout(
      indexFile(base.blob_url, base.file_id, base.audio_type),
      SOFT_TIMEOUT_MS,
      "Indexing took too long — try a shorter clip, or split the file."
    );
    await saveLibraryEntry({ ...base, status: "ready", children, suggestions, error: undefined });
    console.log(`[ingest] ready: ${base.filename} (${children} children)`);
  } catch (error) {
    const message = (error as Error).message || "Ingestion failed";
    console.error(`[ingest] failed: ${base.filename} — ${message}`);
    try {
      await saveLibraryEntry({ ...base, status: "failed", error: message });
    } catch (e) {
      console.error(`[ingest] could not persist failed status: ${(e as Error).message}`);
    }
  }
}

export async function POST(request: Request) {
  try {
    const { url, filename, audioType } = (await request.json()) as {
      url: string;
      filename: string;
      audioType?: string;
    };

    if (!url || !filename) {
      return NextResponse.json({ error: "url and filename are required" }, { status: 400 });
    }

    const entry: LibraryFile = {
      file_id: fileIdFrom(url, filename),
      filename,
      blob_url: url,
      audio_type: audioType ?? "conversational",
      children: 0,
      indexed_at: new Date().toISOString(),
      suggestions: [],
      status: "processing",
    };

    // Mark it processing up front so the client (and reloads) see it immediately.
    try {
      await saveLibraryEntry(entry);
    } catch {
      // Manifest write failed — still kick off indexing; status just won't persist.
    }

    // Heavy lifting continues after the response is sent.
    waitUntil(runIngestion(entry));

    return NextResponse.json({ entry, status: "processing" }, { status: 202 });
  } catch (error) {
    const e = classifyError(error);
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
}
