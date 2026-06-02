// Word-level Parent-Child chunking.
//
// Group transcribed WORDS into sentences (each with precise first-word/last-word
// boundaries), then group sentences into wide "parent" context windows. Only the
// child sentences are embedded, but each child carries BOTH its own tight audio
// boundary (start of its first word → end of its last word) and its parent's
// wider text window for the editor LLM. This replaces the old behavior where
// every child inherited its parent's coarse ~30s window — the root cause of
// duplicate cards and imprecise playback.

import { config } from "./config";
import type { Word } from "./groq";
import type { Parent, ChildRecord } from "./types";

// A sentence with word-precise boundaries (seconds).
interface Sentence {
  start: number;
  end: number;
  text: string;
}

// A child chunk + the index of the parent window it belongs to.
interface ChildSpan {
  start: number;
  end: number;
  text: string;
  parentIndex: number;
}

// True when a token ends on a sentence-terminal (allowing trailing quotes/brackets).
function endsSentence(text: string): boolean {
  return /[.!?]["'”’)\]]*$/.test(text.trim());
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

// Group words into sentences. A sentence closes on terminal punctuation, or is
// flushed early when a long pause (> pauseThreshold) separates words — so a
// run-on without punctuation still yields bounded, word-aligned chunks.
function buildSentences(words: Word[]): Sentence[] {
  const sentences: Sentence[] = [];
  let tokens: string[] = [];
  let start = 0;
  let end = 0;

  const flush = () => {
    if (!tokens.length) return;
    const text = joinWords(tokens);
    if (text) sentences.push({ start, end, text });
    tokens = [];
  };

  for (const w of words) {
    const token = (w.word ?? "").trim();
    if (!token) continue;

    if (!tokens.length) {
      start = w.start;
    } else if (w.start - end > config.pauseThresholdSeconds) {
      // Long silence before this word — close the prior sentence first.
      flush();
      start = w.start;
    }

    tokens.push(token);
    end = w.end;

    if (endsSentence(token)) flush();
  }
  flush();
  return sentences;
}

// Build wide parent windows from sentences AND record which parent each child
// sentence belongs to, so children keep their own tight boundaries while still
// carrying the parent's context text. Parent windows grow to a soft target and
// commit only at a natural pause / sentence terminal, with a hard max guard.
export function chunkWords(words: Word[]): { parents: Parent[]; children: ChildSpan[] } {
  const sentences = buildSentences(words);
  const parents: Parent[] = [];
  const children: ChildSpan[] = [];

  let current: Parent | null = null;
  let currentIndex = 0; // the index `current` will occupy once pushed

  for (const s of sentences) {
    if (!current) {
      current = { start: s.start, end: s.end, text: s.text };
      currentIndex = parents.length;
    } else {
      const gap = s.start - current.end;
      const duration = current.end - current.start;
      const reachedTarget = duration >= config.parentTargetSeconds;
      const naturalBoundary = gap > config.pauseThresholdSeconds || endsSentence(current.text);
      const hardCap = duration >= config.parentMaxSeconds;

      if ((reachedTarget && naturalBoundary) || hardCap) {
        parents.push(current);
        current = { start: s.start, end: s.end, text: s.text };
        currentIndex = parents.length;
      } else {
        current.end = s.end;
        current.text = `${current.text} ${s.text}`.trim();
      }
    }
    children.push({ start: s.start, end: s.end, text: s.text, parentIndex: currentIndex });
  }
  if (current) parents.push(current);

  return { parents, children };
}

// Turn child spans into Small-to-Big upsert records. Each child carries its OWN
// word-precise sentence boundary AND its parent paragraph's id/text/span, so the
// reader can match the sentence but roll up to (and play) the whole paragraph.
// IDs keep the `${fileId}-` prefix so delete-by-prefix still works.
export function buildChildRecords(
  parents: Parent[],
  children: ChildSpan[],
  filePath: string,
  fileId: string,
  audioType: string,
  title: string
): ChildRecord[] {
  return children.map((c, i) => {
    const parent = parents[c.parentIndex];
    return {
      _id: `${fileId}-c${i}`,
      file_path: filePath,
      file_id: fileId,
      title,
      child_text: c.text,
      child_start_ms: Math.round(c.start * 1000),
      child_end_ms: Math.round(c.end * 1000),
      parent_id: `${fileId}-p${c.parentIndex}`,
      parent_text: parent?.text ?? c.text,
      parent_start_ms: Math.round((parent?.start ?? c.start) * 1000),
      parent_end_ms: Math.round((parent?.end ?? c.end) * 1000),
      audio_type: audioType,
    };
  });
}
