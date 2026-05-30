// Issues client-upload tokens so MP3s upload directly to Vercel Blob from the
// browser (bypasses the 4.5MB serverless body limit for large audio files).

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/m4a"],
        addRandomSuffix: true,
        maximumSizeInBytes: 100 * 1024 * 1024, // 100 MB
      }),
      // Required by the type, but we run ingestion explicitly from the client
      // after upload completes, so nothing to do here.
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 }
    );
  }
}
