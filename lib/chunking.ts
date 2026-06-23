// Sliding-window chunking with anchor look-backs.
//
// 1. Tokenize words into grammatically-complete Sentences (split only on
//    terminal punctuation).
// 2. Assemble overlapping ~25s chunks: grow a chunk until it reaches the target
//    duration, then seed the NEXT chunk with this chunk's LAST sentence (overlap).
// 3. Anchor check: if a chunk would start on a conjunction/continuation word,
//    step back and prepend earlier sentences until it starts on a strong anchor.
//
// The DB schema stays flat: each chunk's [start, end] are absolute boundaries.

import type { Word } from "./groq";
import type { ChildRecord } from "./types";

const TARGET_CHUNK_MS = 25_000;

// Words that signal a continuing thought - a chunk should not START on one, or
// it reads as a fragment ripped from mid-narrative.
const WEAK_STARTERS = new Set([
  // coordinating conjunctions + connectives
  "and", "but", "so", "because", "or", "nor", "yet", "for", "however",
  "therefore", "thus", "then", "also", "although", "though", "while", "since",
  // continuation pronouns / demonstratives
  "it", "its", "they", "them", "their", "he", "him", "his", "she", "her",
  "this", "that", "these", "those", "there", "which", "who",
]);

// A grammatically-complete sentence with absolute ms boundaries.
export interface Sentence {
  text: string;
  startMs: number;
  endMs: number;
}

interface Chunk {
  text: string;
  startMs: number;
  endMs: number;
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

// First alphabetic word of a sentence, lowercased - for the anchor check.
function firstWord(text: string): string {
  const m = text.trim().match(/^[A-Za-z']+/);
  return m ? m[0].toLowerCase() : "";
}

// STEP 1 - Sentence tokenization. Accumulate words and close a sentence ONLY on
// terminal punctuation (. ? !). Commas/pauses/conjunctions are ignored.
export function buildSentences(words: Word[]): Sentence[] {
  const sentences: Sentence[] = [];
  let tokens: string[] = [];
  let start = 0;
  let end = 0;

  for (const w of words) {
    const token = (w.word ?? "").trim();
    if (!token) continue;

    if (!tokens.length) start = w.start;
    tokens.push(token);
    end = w.end;

    if (/[.?!]/.test(token)) {
      const text = joinWords(tokens);
      if (text) sentences.push({ text, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
      tokens = [];
    }
  }
  if (tokens.length) {
    const text = joinWords(tokens);
    if (text) sentences.push({ text, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
  }

  return sentences;
}

// STEPS 2 & 3 - assemble overlapping chunks with anchor look-backs.
export function assembleChunks(sentences: Sentence[]): Chunk[] {
  const chunks: Chunk[] = [];
  if (!sentences.length) return chunks;

  let seed = 0;
  while (seed < sentences.length) {
    let startIdx = seed;
    let endIdx = seed;

    // STEP 2 - grow until the chunk reaches the target duration (or we run out).
    while (
      endIdx + 1 < sentences.length &&
      sentences[endIdx].endMs - sentences[startIdx].startMs < TARGET_CHUNK_MS
    ) {
      endIdx++;
    }

    // STEP 3 - anchor check: back up while the chunk starts on a weak word, so it
    // begins on a strong noun/anchor and reads as a self-contained narrative.
    while (startIdx > 0 && WEAK_STARTERS.has(firstWord(sentences[startIdx].text))) {
      startIdx--;
    }

    chunks.push({
      text: sentences.slice(startIdx, endIdx + 1).map((s) => s.text).join(" "),
      startMs: sentences[startIdx].startMs,
      endMs: sentences[endIdx].endMs,
    });

    if (endIdx >= sentences.length - 1) break;

    // Overlap: the next chunk re-seeds with THIS chunk's last sentence. The
    // `seed + 1` guard guarantees forward progress if a lone sentence already
    // exceeds the target (can't meaningfully overlap a giant single sentence).
    seed = endIdx > seed ? endIdx : seed + 1;
  }

  return chunks;
}

// STEP 4 - flat upsert records, one per assembled chunk. IDs keep the
// `${fileId}-` prefix so delete-by-prefix still works.
export function buildChildRecords(
  chunks: Chunk[],
  filePath: string,
  fileId: string,
  audioType: string,
  title: string,
  sessionId: string
): ChildRecord[] {
  return chunks.map((c, i) => ({
    _id: `${fileId}-c${i}`,
    file_path: filePath,
    file_id: fileId,
    session_id: sessionId,
    title,
    child_text: c.text,
    start_time_ms: c.startMs,
    end_time_ms: c.endMs,
    audio_type: audioType,
  }));
}
