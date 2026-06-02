// Single source of truth for the metadata stored on every Pinecone child vector.
// Both the writer (/api/ingest → upsert) and the reader (/api/search → query)
// reference these types, so the schema can never silently drift between the two
// (a classic cause of "Pinecone returns empty arrays" bugs).
//
// Field names mirror the integrated-embeddings record exactly. `child_text` is the
// field the hosted embedding model vectorizes (see fieldMap in lib/pinecone.ts).

// Small-to-Big retrieval: we embed the precise CHILD sentence, but each vector
// also carries its PARENT paragraph's id/text/span — so search matches tightly
// on the sentence yet returns the full paragraph for context + playback.
export interface AudioChunkMetadata extends Record<string, string | number> {
  file_path: string; // Vercel Blob URL — the browser fetches this to play audio
  file_id: string; // stable per-upload id; used for $in filtering by source
  title: string; // human-readable source title, computed once at ingest

  // Child = the embedded sentence (the precise vector).
  child_text: string; // embedded text
  child_start_ms: number; // start of the FIRST word in the sentence
  child_end_ms: number; // end of the LAST word in the sentence

  // Parent = the paragraph the sentence belongs to (the "big" context).
  parent_id: string; // groups sibling sentences into one paragraph card
  parent_text: string; // full paragraph for context + the editor LLM
  parent_start_ms: number; // start of the paragraph's first word
  parent_end_ms: number; // end of the paragraph's last word

  audio_type: string;
}

// A full upsert record = the embedded-text id plus the metadata above.
export type AudioChunkRecord = AudioChunkMetadata & { _id: string };
