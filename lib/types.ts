// Shared types across the API routes and the browser.

import type { AudioChunkRecord } from "@/types/pinecone";

// The Pinecone child-vector schema is centralized in @/types/pinecone so the
// writer (upsert) and reader (search) can never drift. Re-exported as ChildRecord
// for existing call sites.
export type ChildRecord = AudioChunkRecord;
export type { AudioChunkMetadata, AudioChunkRecord } from "@/types/pinecone";

export interface Hit {
  _id: string;
  _score: number;
  file_path: string;
  title?: string; // human-readable source title, stored at ingest
  child_text: string; // the matched sentence
  start_time_ms: number;
  end_time_ms: number;
  audio_type?: string;
}

// What the editor LLM returns / what the browser stitches. `parts` records how
// many retrieved clips were fused into this segment (1 = no fusion).
export interface Clip {
  file_path: string;
  start_time_ms: number;
  end_time_ms: number;
  parts?: number;
}

// The editor's combined output: a grounded text answer plus the clips that
// back it up.
export interface ReelResult {
  answer: string;
  clips: Clip[];
}

// One indexed audio file, tracked in the Blob-stored library manifest so the
// UI can list sources, scope queries to a subset, and show grounded example
// questions. Ingestion runs in the background, so each file carries a status.
export type FileStatus = "processing" | "ready" | "failed";

export interface LibraryFile {
  file_id: string;
  filename: string;
  title?: string; // human-readable display title, computed once at ingest
  blob_url: string;
  audio_type: string;
  children: number;
  indexed_at: string; // ISO timestamp
  suggestions: string[];
  status: FileStatus;
  error?: string;
}
