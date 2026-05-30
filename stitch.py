"""Phase 3 - Audio Stitching.

Takes the clip instructions from the editor LLM, slices the referenced MP3s
with pydub, joins them with a short crossfade to avoid harsh clicks, and
exports the final highlight reel.

Requires ffmpeg on the system PATH (pydub shells out to it for MP3 I/O).
"""

from typing import List, Dict, Any

import config


def stitch(clips: List[Dict[str, Any]], output_path: str, crossfade_ms: int = None) -> str:
    """Slice + crossfade clips into a single MP3. Returns the output path."""
    from pydub import AudioSegment

    if crossfade_ms is None:
        crossfade_ms = config.CROSSFADE_MS
    if not clips:
        raise ValueError("No clips to stitch.")

    # Cache loaded files so we don't decode the same MP3 repeatedly.
    cache: Dict[str, "AudioSegment"] = {}
    combined = None

    for i, clip in enumerate(clips, 1):
        path = clip["file_path"]
        start = int(clip["start_time_ms"])
        end = int(clip["end_time_ms"])

        if path not in cache:
            cache[path] = AudioSegment.from_file(path)
        source = cache[path]

        # Clamp to the actual audio length for safety.
        end = min(end, len(source))
        if end <= start:
            print(f"  [skip clip {i}] empty/invalid range after clamping: {path} [{start}:{end}]")
            continue
        segment = source[start:end]

        if combined is None:
            combined = segment
        else:
            # Crossfade cannot exceed either segment's length.
            fade = min(crossfade_ms, len(combined), len(segment))
            combined = combined.append(segment, crossfade=fade)
        print(f"  [clip {i}] {path} [{start}-{end}ms] ({len(segment)}ms)")

    if combined is None:
        raise ValueError("All clips were skipped; nothing to export.")

    combined.export(output_path, format="mp3")
    print(f"\nExported {len(combined)}ms highlight reel -> {output_path}")
    return output_path
