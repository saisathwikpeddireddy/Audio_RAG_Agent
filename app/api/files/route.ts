// Lists the caller's workspace - their own indexed files plus the shared,
// read-only demo corpus - from the Blob-stored manifests. The client polls this
// for live status, so it must never be statically cached. If the curated demo
// corpus is missing or incomplete, seeding is kicked off in the background.

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getLibrary } from "@/lib/library";
import { sessionIdFromRequest } from "@/lib/sessionServer";
import { ensureDemoCorpus, missingDemoSources } from "@/lib/demoSeed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60; // room for background demo seeding

export async function GET(request: Request) {
  try {
    const sid = sessionIdFromRequest(request);
    const library = await getLibrary(sid);
    if (missingDemoSources(library.filter((f) => f.readOnly)).length) {
      waitUntil(ensureDemoCorpus().catch(() => []));
    }
    return NextResponse.json({ library });
  } catch (error) {
    return NextResponse.json({ library: [], error: (error as Error).message });
  }
}
