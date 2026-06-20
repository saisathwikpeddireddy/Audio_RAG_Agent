// Daily cleanup cron (see vercel.json). Purges expired visitor sessions so
// uploaded audio + vectors never accumulate past the free tier. A session is
// expired when its newest file is older than TTL (or its manifest is empty). The
// shared "demo" corpus is never touched.
//
// Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` when CRON_SECRET is set.

import { NextResponse } from "next/server";
import { list, del } from "@vercel/blob";
import { deleteFileVectors } from "@/lib/pinecone";
import { listSessionIds, getSessionManifest, deleteManifest } from "@/lib/library";
import { DEMO_SESSION } from "@/lib/sessionServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function purgeSession(sid: string): Promise<void> {
  const files = await getSessionManifest(sid);
  // Vectors + the original audio blob for each file.
  for (const f of files) {
    try {
      await deleteFileVectors(f.file_id);
    } catch {
      /* best-effort */
    }
    if (f.blob_url) {
      try {
        await del(f.blob_url);
      } catch {
        /* best-effort */
      }
    }
  }
  // Any stray blobs uploaded under this session's prefix, then the manifest.
  try {
    const { blobs } = await list({ prefix: `${sid}/` });
    for (const b of blobs) await del(b.url);
  } catch {
    /* best-effort */
  }
  await deleteManifest(sid);
}

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sids = await listSessionIds();
  let purged = 0;
  for (const sid of sids) {
    if (sid === DEMO_SESSION) continue;
    const files = await getSessionManifest(sid);
    const newest = files.reduce((max, f) => Math.max(max, Date.parse(f.indexed_at) || 0), 0);
    const expired = files.length === 0 || Date.now() - newest > TTL_MS;
    if (!expired) continue;
    await purgeSession(sid);
    purged++;
  }
  return NextResponse.json({ scanned: sids.length, purged });
}

export const GET = handle;
export const POST = handle;
