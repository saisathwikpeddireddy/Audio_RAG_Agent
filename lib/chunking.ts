// Strict grammatical sentence chunking.
//
// Group word-level Whisper output into vectors of ONE grammatically-complete
// sentence each. We finalize a chunk only when a word carries terminal
// punctuation (. ? !) — never on commas, pauses, or conjunctions. A long
// sentence stays long. Each chunk's [start, end] is word-precise: the start of
// its first word and the end of its terminal word. Flat schema, no parents.

import type { Word } from "./groq";
import type { ChildRecord } from "./types";

// A sentence with word-precise boundaries (seconds).
export interface Sentence {
  start: number;
  end: number;
  text: string;
}

// Join word tokens into readable text, tightening spaces before punctuation
// (Whisper word tokens don't carry their own surrounding spaces).
function joinWords(tokens: string[]): string {
  return tokens
    .join(" ")
    .replace(/\s+([.,!?;:”’)\]])/g, "$1")
    .replace(/([("'“‘])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Strict grammatical buffer: accumulate words, and ONLY close a sentence when the
// current word contains terminal punctuation. Commas, pauses, and conjunctions
// are ignored. Any trailing words (no final terminal) flush as a last sentence.
export function buildSentences(words: Word[]): Sentence[] {
  const sentences: Sentence[] = [];
  let tokens: string[] = [];
  let start = 0;
  let end = 0;

  for (const w of words) {
    const token = (w.word ?? "").trim();
    if (!token) continue;

    if (!tokens.length) start = w.start; // first word in the buffer
    tokens.push(token);
    end = w.end; // terminal-word end (updated each word)

    if (/[.?!]/.test(token)) {
      const text = joinWords(tokens);
      if (text) sentences.push({ start, end, text });
      tokens = [];
    }
  }

  // Flush any dangling words that never hit terminal punctuation.
  if (tokens.length) {
    const text = joinWords(tokens);
    if (text) sentences.push({ start, end, text });
  }

  return sentences;
}

// Turn sentences into flat upsert records — one vector per complete sentence,
// each carrying its own word-precise [start, end]. IDs keep the `${fileId}-`
// prefix so delete-by-prefix still works.
export function buildChildRecords(
  sentences: Sentence[],
  filePath: string,
  fileId: string,
  audioType: string,
  title: string
): ChildRecord[] {
  return sentences.map((s, i) => ({
    _id: `${fileId}-c${i}`,
    file_path: filePath,
    file_id: fileId,
    title,
    child_text: s.text,
    start_time_ms: Math.round(s.start * 1000),
    end_time_ms: Math.round(s.end * 1000),
    audio_type: audioType,
  }));
}
