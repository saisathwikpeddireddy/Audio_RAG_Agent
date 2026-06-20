// Phase 2 (server): Pinecone search (scoped to the caller's session + the shared
// demo corpus) + answer LLM. Returns ranked sentence hits and a grounded answer.

import { NextResponse } from "next/server";
import { search } from "@/lib/pinecone";
import { generateReel } from "@/lib/editor";
import { config } from "@/lib/config";
import { classifyError } from "@/lib/errors";
import { sessionIdFromRequest, DEMO_SESSION } from "@/lib/sessionServer";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const sid = sessionIdFromRequest(request);
    const { query, topK, fileIds } = (await request.json()) as {
      query: string;
      topK?: number;
      fileIds?: string[];
    };
    if (!query?.trim()) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    // Only ever retrieve from this visitor's workspace + the shared demo corpus.
    const sessionIds = sid ? [sid, DEMO_SESSION] : [DEMO_SESSION];
    const hits = await search(query, topK ?? config.topK, fileIds, sessionIds);
    if (!hits.length) {
      return NextResponse.json({ hits: [], clips: [], note: "No matches. Upload & ingest audio first." });
    }

    const { answer, clips } = await generateReel(query, hits);
    return NextResponse.json({ hits, clips, answer, rawClips: clips.length });
  } catch (error) {
    // Classify provider failures (e.g. Groq/Gemini 429s) into a friendly,
    // machine-readable payload the UI can theme instead of a raw 500.
    const e = classifyError(error);
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
}
