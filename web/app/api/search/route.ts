// Phase 2 (server): Pinecone search + editor LLM -> clip instructions.

import { NextResponse } from "next/server";
import { search } from "@/lib/pinecone";
import { editClips } from "@/lib/editor";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { query, topK } = (await request.json()) as { query: string; topK?: number };
    if (!query?.trim()) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const hits = await search(query, topK ?? config.topK);
    if (!hits.length) {
      return NextResponse.json({ hits: [], clips: [], note: "No matches. Upload & ingest audio first." });
    }

    const clips = await editClips(query, hits);
    return NextResponse.json({ hits, clips });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
