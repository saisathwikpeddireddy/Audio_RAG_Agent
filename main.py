"""Audio RAG Auto-Editor - query entry point.

Ties Phase 2 (retrieval + editor LLM) and Phase 3 (stitching) together:

    python main.py "what did they say about the product roadmap?"
    python main.py "best jokes" --top-k 8 --output jokes.mp3

Run ingest.py first to populate the Pinecone index.
"""

import argparse
import json

import config
from clients import ensure_index, search
from retrieve import edit
from stitch import stitch


def run(query: str, top_k: int, output_path: str) -> str:
    index = ensure_index()

    print(f'Searching for: "{query}" (top_k={top_k})')
    hits = search(index, query, top_k)
    if not hits:
        raise SystemExit("No matches found. Did you run ingest.py?")
    for i, h in enumerate(hits, 1):
        score = h.get("_score")
        preview = (h.get("child_text") or "")[:80]
        print(f"  {i}. score={score:.3f} | {preview}")

    print("\nAsking the editor LLM to cut the highlight reel...")
    clips = edit(query, hits)
    if not clips:
        raise SystemExit("Editor returned no usable clips.")
    print("Editor selected clips:")
    print(json.dumps(clips, indent=2))

    print("\nStitching audio...")
    return stitch(clips, output_path)


def main():
    parser = argparse.ArgumentParser(description="Generate an audio highlight reel from a text query.")
    parser.add_argument("query", help="What you want the highlight reel to be about.")
    parser.add_argument("--top-k", type=int, default=config.TOP_K, help="Number of Pinecone hits.")
    parser.add_argument("--output", default=config.OUTPUT_PATH, help="Output MP3 path.")
    args = parser.parse_args()

    run(args.query, args.top_k, args.output)


if __name__ == "__main__":
    main()
