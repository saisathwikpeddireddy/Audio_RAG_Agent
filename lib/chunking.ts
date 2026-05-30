// Dynamic-window Parent-Child chunking (port of chunking.py).
//
// Group Whisper segments into "parent" windows (break at a natural pause or
// after ~30s), then split each parent into "child" sentences. Only children are
// embedded, but every child carries its parent's wide time window so retrieval
// splices a complete thought rather than a fragment.

import { config } from "./config";
import type { Segment, Parent, ChildRecord } from "./types";

function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Split after sentence-ending punctuation followed by whitespace.
  return trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// True when `text` ends on a sentence-terminal token (allowing trailing quotes
// or brackets), i.e. a safe place to cut without slicing a thought in half.
function endsSentence(text: string): boolean {
  return /[.!?]["'”’)\]]*\s*$/.test(text);
}

// Silence-/token-bound parent windows. We accumulate sentences and only commit
// a boundary once the window has reached the soft target AND we hit a natural
// pause (gap > threshold) or a sentence terminal — so a parent is dynamically
// sized (~target..max seconds) but never cut mid-word or mid-thought. A hard
// max guards against runaway windows when neither signal appears.
export function buildParents(segments: Segment[]): Parent[] {
  const parents: Parent[] = [];
  let current: Parent | null = null;

  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;

    if (!current) {
      current = { start: seg.start, end: seg.end, text };
      continue;
    }

    const gap = seg.start - current.end;
    const duration = current.end - current.start;
    const reachedTarget = duration >= config.parentTargetSeconds;
    const naturalBoundary = gap > config.pauseThresholdSeconds || endsSentence(current.text);
    const hardCap = duration >= config.parentMaxSeconds;

    if ((reachedTarget && naturalBoundary) || hardCap) {
      parents.push(current);
      current = { start: seg.start, end: seg.end, text };
    } else {
      current.end = seg.end;
      current.text = `${current.text} ${text}`.trim();
    }
  }

  if (current) parents.push(current);
  return parents;
}

export function buildChildRecords(
  parents: Parent[],
  filePath: string,
  fileId: string,
  audioType: string
): ChildRecord[] {
  const records: ChildRecord[] = [];
  parents.forEach((parent, pIdx) => {
    const startMs = Math.round(parent.start * 1000);
    const endMs = Math.round(parent.end * 1000);
    splitSentences(parent.text).forEach((sentence, cIdx) => {
      records.push({
        _id: `${fileId}-p${pIdx}-c${cIdx}`,
        file_path: filePath,
        file_id: fileId,
        child_text: sentence,
        parent_text: parent.text,
        start_time_ms: startMs,
        end_time_ms: endMs,
        audio_type: audioType,
      });
    });
  });
  return records;
}
