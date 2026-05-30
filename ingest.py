"""Phase 1 - Ingestion.

Reads .mp3 files from a directory, transcribes them with Groq Whisper
(verbose JSON for segment-level timestamps), applies Parent-Child chunking,
and upserts the child sentences to Pinecone.

Usage:
    python ingest.py                       # ingest data/input/*.mp3
    python ingest.py --dir path/to/audio   # custom directory
    python ingest.py --audio-type structured
"""

import argparse
import glob
import hashlib
import os
from typing import List, Dict, Any

import config
import chunking
from clients import ensure_index, upsert_children, with_retries


def _file_id(path: str) -> str:
    """Stable short id derived from the file name + size."""
    base = os.path.basename(path)
    size = os.path.getsize(path)
    digest = hashlib.sha1(f"{base}:{size}".encode()).hexdigest()[:10]
    stem = os.path.splitext(base)[0]
    safe = "".join(ch if ch.isalnum() else "_" for ch in stem)[:32]
    return f"{safe}_{digest}"


def transcribe(path: str) -> List[Dict[str, Any]]:
    """Return Whisper segments [{start, end, text}, ...] for an mp3."""
    from groq import Groq

    config.require("GROQ_API_KEY")
    client = Groq(api_key=config.GROQ_API_KEY)

    with open(path, "rb") as f:
        audio_bytes = f.read()

    result = with_retries(
        client.audio.transcriptions.create,
        file=(os.path.basename(path), audio_bytes),
        model=config.GROQ_WHISPER_MODEL,
        response_format="verbose_json",
        timestamp_granularities=["segment", "word"],
    )

    # The SDK returns an object; normalise segments to plain dicts.
    segments = getattr(result, "segments", None)
    if segments is None and isinstance(result, dict):
        segments = result.get("segments")
    if not segments:
        # Fall back to a single segment spanning the whole text/duration.
        text = getattr(result, "text", "") or ""
        duration = getattr(result, "duration", 0.0) or 0.0
        return [{"start": 0.0, "end": float(duration), "text": text}] if text else []

    norm = []
    for s in segments:
        get = s.get if isinstance(s, dict) else lambda k, d=None: getattr(s, k, d)
        norm.append(
            {"start": float(get("start", 0.0)), "end": float(get("end", 0.0)), "text": get("text", "") or ""}
        )
    return norm


def ingest_file(index, path: str, audio_type: str) -> int:
    file_id = _file_id(path)
    abs_path = os.path.abspath(path)
    print(f"\n-> {path}")
    print("   transcribing (Groq Whisper)...")
    segments = transcribe(path)
    if not segments:
        print("   no speech detected, skipping.")
        return 0

    parents = chunking.build_parents(segments)
    records = chunking.build_child_records(parents, abs_path, file_id, audio_type)
    print(f"   {len(segments)} segments -> {len(parents)} parents -> {len(records)} child sentences")
    if records:
        upsert_children(index, records)
    return len(records)


def main():
    parser = argparse.ArgumentParser(description="Ingest MP3s into the Audio RAG index.")
    parser.add_argument("--dir", default=config.INPUT_DIR, help="Directory of .mp3 files")
    parser.add_argument(
        "--audio-type",
        default="conversational",
        choices=["conversational", "structured"],
        help="Tag stored on every vector from this run.",
    )
    args = parser.parse_args()

    mp3s = sorted(glob.glob(os.path.join(args.dir, "*.mp3")))
    if not mp3s:
        raise SystemExit(f"No .mp3 files found in '{args.dir}'.")

    print(f"Found {len(mp3s)} mp3 file(s) in '{args.dir}'.")
    index = ensure_index()

    total = 0
    for path in mp3s:
        total += ingest_file(index, path, args.audio_type)

    print(f"\nDone. Upserted {total} child vectors across {len(mp3s)} file(s).")


if __name__ == "__main__":
    main()
