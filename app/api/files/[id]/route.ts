// DELETE a single indexed file end-to-end: purge its vectors from Pinecone,
// remove the underlying audio from Blob storage, and drop it from the caller's
// manifest. Only the owning session may delete a file — the shared demo corpus
// is read-only.

import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { deleteFileVectors } from "@/lib/pinecone";
import { getLibrary, getSessionManifest, removeLibraryEntry } from "@/lib/library";
import { sessionIdFromRequest } from "@/lib/sessionServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const fileId = decodeURIComponent(params.id);
  if (!fileId) {
    return NextResponse.json({ error: "file id is required" }, { status: 400 });
  }

  const sid = sessionIdFromRequest(request);
  if (!sid) {
    return NextResponse.json({ error: "Missing or invalid session." }, { status: 400 });
  }

  try {
    // Ownership check: the file must live in THIS session's manifest.
    const entry = (await getSessionManifest(sid)).find((f) => f.file_id === fileId);
    if (!entry) {
      return NextResponse.json(
        { error: "Not found in your workspace (demo files are read-only)." },
        { status: 403 }
      );
    }

    // Step A — vector purge (before dropping the record, so a failure is retryable).
    const deletedVectors = await deleteFileVectors(fileId);

    // Step B — storage purge (best-effort; a missing blob shouldn't block).
    if (entry.blob_url) {
      try {
        await del(entry.blob_url);
      } catch (e) {
        console.error(`[delete] blob del failed for ${fileId}: ${(e as Error).message}`);
      }
    }

    // Step C — manifest cleanup (scoped to this session) + return the merged view.
    await removeLibraryEntry(sid, fileId);
    const library = await getLibrary(sid);

    return NextResponse.json({ ok: true, deletedVectors, library });
  } catch (error) {
    console.error(`[delete] failed for ${fileId}: ${(error as Error).message}`);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
