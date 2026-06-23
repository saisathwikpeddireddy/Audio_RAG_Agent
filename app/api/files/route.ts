// Lists the caller's workspace - their own indexed files plus the shared,
// read-only demo corpus - from the Blob-stored manifests. The client polls this
// for live status, so it must never be statically cached.

import { NextResponse } from "next/server";
import { getLibrary } from "@/lib/library";
import { sessionIdFromRequest } from "@/lib/sessionServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const sid = sessionIdFromRequest(request);
    const library = await getLibrary(sid);
    return NextResponse.json({ library });
  } catch (error) {
    return NextResponse.json({ library: [], error: (error as Error).message });
  }
}
