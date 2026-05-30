// Shared types across the API routes and the browser.

export interface Segment {
  start: number; // seconds
  end: number; // seconds
  text: string;
}

export interface Parent {
  start: number; // seconds
  end: number; // seconds
  text: string;
}

// A Pinecone record following the spec's metadata schema. `file_path` holds the
// Vercel Blob URL so the browser can fetch the audio to stitch it.
export interface ChildRecord {
  _id: string;
  file_path: string;
  file_id: string;
  child_text: string;
  parent_text: string;
  start_time_ms: number;
  end_time_ms: number;
  audio_type: string;
}

export interface Hit {
  _id: string;
  _score: number;
  file_path: string;
  parent_text: string;
  child_text: string;
  start_time_ms: number;
  end_time_ms: number;
  audio_type?: string;
}

// What the editor LLM returns / what the browser stitches.
export interface Clip {
  file_path: string;
  start_time_ms: number;
  end_time_ms: number;
}

// The editor's combined output: a grounded text answer plus the clips that
// back it up.
export interface ReelResult {
  answer: string;
  clips: Clip[];
}
