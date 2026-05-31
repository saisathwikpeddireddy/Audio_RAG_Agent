// JIT karaoke transcription: accept the browser-stitched reel WAV and return
// word-level timestamps from Groq Whisper. The reel only exists client-side
// (it's assembled in the browser via Web Audio and never persisted), so the
// bytes are uploaded directly here rather than referenced by URL.

import { NextResponse } from "next/server";
import { transcribeFileWords } from "@/lib/groq";
import { classifyError } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    // The frontend posts the WAV as the raw request body (Content-Type: audio/wav).
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) {
      return NextResponse.json({ error: "BAD_REQUEST", message: "Empty audio body." }, { status: 400 });
    }

    const blob = new Blob([buf], { type: "audio/wav" });
    const words = await transcribeFileWords(blob, "reel.wav");
    return NextResponse.json({ words });
  } catch (error) {
    const e = classifyError(error);
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
}
