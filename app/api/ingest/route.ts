// Phase 1 (server): transcribe a blob URL with Groq, chunk parent/child,
// upsert children to Pinecone.

import { NextResponse } from "next/server";
import { transcribeUrl } from "@/lib/groq";
import { buildParents, buildChildRecords } from "@/lib/chunking";
import { upsertChildren } from "@/lib/pinecone";

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
    const records = buildChildRecords(parents, url, fileId, audioType ?? "conversational");

    if (records.length) await upsertChildren(records);

    return NextResponse.json({
      filename,
      file_id: fileId,
      segments: segments.length,
      parents: parents.length,
      children: records.length,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
