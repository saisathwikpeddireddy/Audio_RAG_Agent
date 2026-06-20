// One-time admin endpoint to seed the shared, read-only "demo" corpus that every
// visitor sees on first load. Point it at a public audio URL (ideally one you've
// uploaded to your Blob store) and it ingests into the "demo" session.
//
// Guarded by SEED_SECRET. Example:
//   curl -X POST https://<app>/api/seed-demo \
//     -H "Authorization: Bearer $SEED_SECRET" -H "Content-Type: application/json" \
//     -d '{"url":"https://.../talk.mp3","filename":"The Attention Equation.mp3"}'

import { NextResponse } from "next/server";
import { kickoffIngestion } from "@/lib/ingestPipeline";
import { DEMO_SESSION } from "@/lib/sessionServer";
import { classifyError } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const secret = process.env.SEED_SECRET;
    if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { url, filename, audioType } = (await request.json()) as {
      url: string;
      filename: string;
      audioType?: string;
    };
    if (!url || !filename) {
      return NextResponse.json({ error: "url and filename are required" }, { status: 400 });
    }

    const entry = await kickoffIngestion(DEMO_SESSION, { url, filename, audioType });
    return NextResponse.json({ entry, status: "processing" }, { status: 202 });
  } catch (error) {
    const e = classifyError(error);
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
}
