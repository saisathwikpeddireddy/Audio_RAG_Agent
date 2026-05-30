// Phase 2 (server): Pinecone search + editor LLM -> clip instructions.

import { NextResponse } from "next/server";
import { search } from "@/lib/pinecone";
import { generateReel } from "@/lib/editor";
import { fuseClips } from "@/lib/fuse";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { query, topK, fileIds } = (await request.json()) as {
      query: string;
      topK?: number;
      fileIds?: string[];
    };
    if (!query?.trim()) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const hits = await search(query, topK ?? config.topK, fileIds);
    if (!hits.length) {
      return NextResponse.json({ hits: [], clips: [], note: "No matches. Upload & ingest audio first." });
    }

    const { answer, clips } = await generateReel(query, hits);
    // Heal duplicate/adjacent windows into continuous playback segments.
    const fused = fuseClips(clips, config.fuseGapMs);
    return NextResponse.json({ hits, clips: fused, answer });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
