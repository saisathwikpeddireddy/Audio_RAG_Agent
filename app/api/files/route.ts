// Lists every indexed audio file from the Blob-stored library manifest, so the
// Query tab can show available sources on load.

import { NextResponse } from "next/server";
import { getLibrary } from "@/lib/library";

export const runtime = "nodejs";

export async function GET() {
  try {
    const library = await getLibrary();
    return NextResponse.json({ library });
  } catch (error) {
    return NextResponse.json({ library: [], error: (error as Error).message });
  }
}
