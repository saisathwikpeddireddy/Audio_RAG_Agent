// Single source of truth for the metadata stored on every Pinecone child vector.
// Both the writer (/api/ingest → upsert) and the reader (/api/search → query)
// reference these types, so the schema can never silently drift between the two
// (a classic cause of "Pinecone returns empty arrays" bugs).
//
// Field names mirror the integrated-embeddings record exactly. `child_text` is the
// field the hosted embedding model vectorizes (see fieldMap in lib/pinecone.ts).

// Flat schema: one vector per grammatically-complete sentence. The chunk is the
// single source of truth — no parent paragraph rollup. Both the writer
// (/api/ingest → upsert) and the reader (/api/search → query) reference these
// types so the schema can never silently drift.
export interface AudioChunkMetadata extends Record<string, string | number> {
  file_path: string; // Vercel Blob URL — the browser fetches this to play audio
  file_id: string; // stable per-upload id; used for $in filtering by source
  title: string; // human-readable source title, computed once at ingest
  child_text: string; // the embedded sentence (one complete thought)
  start_time_ms: number; // start of the FIRST word in the sentence
  end_time_ms: number; // end of the TERMINAL word in the sentence
  audio_type: string;
}

// A full upsert record = the embedded-text id plus the metadata above.
export type AudioChunkRecord = AudioChunkMetadata & { _id: string };
