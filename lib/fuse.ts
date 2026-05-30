// Adjacent-clip fusion: the retriever finds the *ideas*; this heals the audio.
// Clips on the same file whose windows overlap or sit within `gapMs` of each
// other are merged into one continuous playback window. This removes duplicate
// parent windows (two children of the same parent) and stitches contiguous
// material into an uninterrupted stream instead of crossfading a seam mid-thought.

import type { Clip } from "./types";

export function fuseClips(clips: Clip[], gapMs = 750): Clip[] {
  if (clips.length <= 1) return clips;

  // Group by source file, preserving first-seen file order.
  const byFile = new Map<string, Clip[]>();
  for (const c of clips) {
    const arr = byFile.get(c.file_path);
    if (arr) arr.push(c);
    else byFile.set(c.file_path, [c]);
  }

  const out: Clip[] = [];
  for (const list of byFile.values()) {
    list.sort((a, b) => a.start_time_ms - b.start_time_ms);
    let cur: Clip = { ...list[0] };
    for (let i = 1; i < list.length; i++) {
      const next = list[i];
      // Overlapping or within the gap → extend the current window.
      if (next.start_time_ms <= cur.end_time_ms + gapMs) {
        cur.end_time_ms = Math.max(cur.end_time_ms, next.end_time_ms);
      } else {
        out.push(cur);
        cur = { ...next };
      }
    }
    out.push(cur);
  }
  return out;
}
