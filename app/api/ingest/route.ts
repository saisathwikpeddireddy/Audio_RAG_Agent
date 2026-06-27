// Phase 1 (server): kick off session-scoped ingestion of a blob URL. The heavy
// transcribe → chunk → embed work runs in the background (waitUntil); this
// returns 202 immediately with the "processing" manifest entry, which the client
// polls until it flips to ready/failed. See lib/ingestPipeline.ts.

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { kickoffIngestion } from "@/lib/ingestPipeline";
import { sessionIdFromRequest } from "@/lib/sessionServer";
import { contextFromRequest, track } from "@/lib/analytics";
import { classifyError } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const ctx = contextFromRequest(request);
  try {
    const sid = sessionIdFromRequest(request);
    if (!sid) {
      return NextResponse.json({ error: "Missing or invalid session." }, { status: 400 });
    }

    const { url, filename, audioType, bytes } = (await request.json()) as {
      url: string;
      filename: string;
      audioType?: string;
      bytes?: number;
    };
    if (!url || !filename) {
      return NextResponse.json({ error: "url and filename are required" }, { status: 400 });
    }

    const entry = await kickoffIngestion(sid, { url, filename, audioType });
    waitUntil(
      track(ctx, "upload", {
        meta: { file: filename, bytes: typeof bytes === "number" ? bytes : 0 },
      })
    );
    return NextResponse.json({ entry, status: "processing" }, { status: 202 });
  } catch (error) {
    const e = classifyError(error);
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
}
