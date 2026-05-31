// Single source of truth for the metadata stored on every Pinecone child vector.
// Both the writer (/api/ingest → upsert) and the reader (/api/search → query)
// reference these types, so the schema can never silently drift between the two
// (a classic cause of "Pinecone returns empty arrays" bugs).
//
// Field names mirror the integrated-embeddings record exactly. `child_text` is the
// field the hosted embedding model vectorizes (see fieldMap in lib/pinecone.ts).

export interface AudioChunkMetadata extends Record<string, string | number> {
  file_path: string; // Vercel Blob URL — the browser fetches this to stitch audio
  file_id: string; // stable per-upload id; used for $in filtering by source
  child_text: string; // embedded text
  parent_text: string; // wider context window for the editor LLM
  start_time_ms: number;
  end_time_ms: number;
  audio_type: string;
}

// A full upsert record = the embedded-text id plus the metadata above.
export type AudioChunkRecord = AudioChunkMetadata & { _id: string };
