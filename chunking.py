"""Dynamic-window Parent-Child chunking.

Strategy (from the spec): preserve linear human speech and avoid micro-cuts.

- Group Whisper *segments* into "Parent" blocks. A parent breaks when there is
  a natural pause (gap > PAUSE_THRESHOLD) or it would exceed PARENT_MAX_SECONDS.
- Split each Parent into "Child" sentences. Only the child sentences are
  embedded, but every child carries its *parent's* wide time window so that
  retrieval splices a complete thought rather than a fragment.
"""

import re
from typing import List, Dict, Any

import config


def _split_sentences(text: str) -> List[str]:
    """Lightweight sentence splitter (no NLP model downloads)."""
    text = text.strip()
    if not text:
        return []
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [p.strip() for p in parts if p.strip()]


def build_parents(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Group transcript segments into parent windows.

    Each segment is expected to have ``start`` and ``end`` (seconds) and ``text``.
    Returns parents with ``start``/``end`` (seconds) and concatenated ``text``.
    """
    parents: List[Dict[str, Any]] = []
    current: Dict[str, Any] = {}

    for seg in segments:
        start = float(seg["start"])
        end = float(seg["end"])
        text = (seg.get("text") or "").strip()
        if not text:
            continue

        if not current:
            current = {"start": start, "end": end, "text": text}
            continue

        gap = start - current["end"]
        duration = end - current["start"]
        if gap > config.PAUSE_THRESHOLD_SECONDS or duration > config.PARENT_MAX_SECONDS:
            parents.append(current)
            current = {"start": start, "end": end, "text": text}
        else:
            current["end"] = end
            current["text"] = f"{current['text']} {text}".strip()

    if current:
        parents.append(current)
    return parents


def build_child_records(
    parents: List[Dict[str, Any]],
    file_path: str,
    file_id: str,
    audio_type: str,
) -> List[Dict[str, Any]]:
    """Flatten parents into per-child Pinecone records following the spec schema."""
    records: List[Dict[str, Any]] = []
    for p_idx, parent in enumerate(parents):
        start_ms = int(round(parent["start"] * 1000))
        end_ms = int(round(parent["end"] * 1000))
        sentences = _split_sentences(parent["text"])
        for c_idx, sentence in enumerate(sentences):
            records.append(
                {
                    "_id": f"{file_id}-p{p_idx}-c{c_idx}",
                    "file_path": file_path,
                    "file_id": file_id,
                    "child_text": sentence,
                    "parent_text": parent["text"],
                    "start_time_ms": start_ms,
                    "end_time_ms": end_ms,
                    "audio_type": audio_type,
                }
            )
    return records
