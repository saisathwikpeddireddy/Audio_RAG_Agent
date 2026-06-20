// Session-scoped ingestion: transcribe a blob URL with Groq (word timestamps),
// build overlapping sentence chunks, upsert to Pinecone, and persist status to
// the session's manifest. Heavy work runs in the background (waitUntil) so the
// request can return 202 immediately. Shared by /api/ingest (visitor uploads)
// and /api/seed-demo (the shared demo corpus).

import { waitUntil } from "@vercel/functions";
import { transcribeUrlWords } from "./groq";
import { buildSentences, assembleChunks, buildChildRecords } from "./chunking";
import { upsertChildren } from "./pinecone";
import { suggestQuestions } from "./suggest";
import { saveLibraryEntry } from "./library";
import { formatSourceName } from "./format";
import type { LibraryFile } from "./types";

const SOFT_TIMEOUT_MS = 55_000;

// Deterministic, session-scoped id so re-ingesting overwrites rather than
// duplicates, and two sessions never collide on the same file.
function fileIdFrom(sid: string, url: string, filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  const safe = stem.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32);
  let h = 0;
  const seed = `${sid}|${url}`;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const sidTag = sid.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return `${sidTag}-${safe}_${(h >>> 0).toString(36)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function indexFile(sid: string, url: string, fileId: string, type: string, title: string) {
  const words = await transcribeUrlWords(url);
  if (!words.length) throw new Error("No speech detected in this audio.");

  const sentences = buildSentences(words);
  const chunks = assembleChunks(sentences);
  const records = buildChildRecords(chunks, url, fileId, type, title, sid);
  if (records.length) await upsertChildren(records);

  const transcript = sentences.map((s) => s.text).join(" ");
  const suggestions = await suggestQuestions(transcript);
  return { children: records.length, suggestions };
}

async function runIngestion(sid: string, base: LibraryFile) {
  try {
    const { children, suggestions } = await withTimeout(
      indexFile(sid, base.blob_url, base.file_id, base.audio_type, base.title ?? base.filename),
      SOFT_TIMEOUT_MS,
      "Indexing took too long — try a shorter clip, or split the file."
    );
    await saveLibraryEntry(sid, { ...base, status: "ready", children, suggestions, error: undefined });
    console.log(`[ingest:${sid}] ready: ${base.filename} (${children} chunks)`);
  } catch (error) {
    const message = (error as Error).message || "Ingestion failed";
    console.error(`[ingest:${sid}] failed: ${base.filename} — ${message}`);
    try {
      await saveLibraryEntry(sid, { ...base, status: "failed", error: message });
    } catch (e) {
      console.error(`[ingest:${sid}] could not persist failed status: ${(e as Error).message}`);
    }
  }
}

// Build the manifest entry, persist it as "processing", kick off background
// indexing, and return the entry so the route can 202 immediately.
export async function kickoffIngestion(
  sid: string,
  args: { url: string; filename: string; audioType?: string }
): Promise<LibraryFile> {
  const entry: LibraryFile = {
    file_id: fileIdFrom(sid, args.url, args.filename),
    filename: args.filename,
    title: formatSourceName(args.filename),
    blob_url: args.url,
    audio_type: args.audioType ?? "conversational",
    session_id: sid,
    children: 0,
    indexed_at: new Date().toISOString(),
    suggestions: [],
    status: "processing",
  };

  try {
    await saveLibraryEntry(sid, entry); // visible immediately to pollers
  } catch {
    // Manifest write failed — still index; status just won't persist up front.
  }

  waitUntil(runIngestion(sid, entry));
  return entry;
}
