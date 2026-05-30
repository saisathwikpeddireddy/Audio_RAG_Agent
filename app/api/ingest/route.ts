// Phase 1 (server): transcribe a blob URL with Groq, chunk parent/child,
// upsert children to Pinecone.

import { NextResponse } from "next/server";
import { transcribeUrl } from "@/lib/groq";
import { buildParents, buildChildRecords } from "@/lib/chunking";
import { upsertChildren } from "@/lib/pinecone";
import { suggestQuestions } from "@/lib/suggest";
import { saveLibraryEntry } from "@/lib/library";
import type { LibraryFile } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60; // first call may also provision the Pinecone index

function fileIdFrom(url: string, filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  const safe = stem.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32);
  // Short hash of the blob URL keeps ids stable & unique per upload.
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
  return `${safe}_${(h >>> 0).toString(36)}`;
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

    const segments = await transcribeUrl(url);
    if (!segments.length) {
      return NextResponse.json({ filename, segments: 0, parents: 0, children: 0, note: "no speech detected" });
    }

    const parents = buildParents(segments);
    const fileId = fileIdFrom(url, filename);
    const type = audioType ?? "conversational";
    const records = buildChildRecords(parents, url, fileId, type);

    if (records.length) await upsertChildren(records);

    // Grounded example questions for this file (best-effort, never blocks ingest).
    const transcript = parents.map((p) => p.text).join("\n");
    const suggestions = await suggestQuestions(transcript);

    const entry: LibraryFile = {
      file_id: fileId,
      filename,
      blob_url: url,
      audio_type: type,
      children: records.length,
      indexed_at: new Date().toISOString(),
      suggestions,
    };

    // Persist to the library manifest; if Blob write fails, still return the
    // entry so the client can use it for this session.
    let library: LibraryFile[];
    try {
      library = await saveLibraryEntry(entry);
    } catch {
      library = [entry];
    }

    return NextResponse.json({
      filename,
      file_id: fileId,
      segments: segments.length,
      parents: parents.length,
      children: records.length,
      entry,
      library,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
