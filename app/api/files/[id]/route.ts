// DELETE a single indexed file end-to-end: purge its vectors from Pinecone,
// remove the underlying audio from Blob storage, and drop it from the manifest.

import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { deleteFileVectors } from "@/lib/pinecone";
import { getLibrary, removeLibraryEntry } from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const fileId = decodeURIComponent(params.id);
  if (!fileId) {
    return NextResponse.json({ error: "file id is required" }, { status: 400 });
  }

  try {
    const entry = (await getLibrary()).find((f) => f.file_id === fileId);

    // Step A — vector purge (must succeed before we drop the record, so a
    // failure is retryable rather than silently orphaning vectors).
    const deletedVectors = await deleteFileVectors(fileId);

    // Step B — storage purge (best-effort; a missing blob shouldn't block).
    if (entry?.blob_url) {
      try {
        await del(entry.blob_url);
      } catch (e) {
        console.error(`[delete] blob del failed for ${fileId}: ${(e as Error).message}`);
      }
    }

    // Step C — manifest cleanup.
    const library = await removeLibraryEntry(fileId);

    return NextResponse.json({ ok: true, deletedVectors, library });
  } catch (error) {
    console.error(`[delete] failed for ${fileId}: ${(error as Error).message}`);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
