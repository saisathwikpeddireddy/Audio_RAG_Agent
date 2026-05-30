# Audio RAG Auto-Editor

Ingest a folder of MP3s and generate a seamless audio **highlight reel** from a
plain-text query. All heavy compute and storage live in the cloud — the local
machine only routes API calls and splices audio, so it runs comfortably on an
8GB / low-disk laptop (no PyTorch, no local models, no local vector DB).

## How it works

```
MP3s ──► Groq Whisper ──► Parent/Child chunks ──► Pinecone (hosted embeddings)
                                                        │
text query ──► Pinecone search (top-K) ──► Gemini "scalpel" picks clip boundaries
                                                        │
                                          pydub slices + 50ms crossfade ──► highlight_reel.mp3
```

| Stage | Service |
|-------|---------|
| Transcription (word/segment timestamps) | **Groq** `whisper-large-v3-turbo` |
| Embeddings | **Pinecone** integrated `llama-text-embed-v2` (free Starter) |
| Vector DB | **Pinecone** serverless |
| Editor logic | **Gemini** `gemini-2.0-flash` |
| Audio engine | **pydub** (local, needs ffmpeg) |

### Chunking strategy
**Dynamic-window Parent-Child RAG.** Whisper segments are grouped into *parent*
windows (broken at natural pauses or every ~30s). Each parent is split into
*child* sentences. Only the children are embedded for precise semantic matching,
but every child stores its **parent's** wide time window, so retrieval splices a
complete thought instead of a clipped fragment.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then fill in your keys
```

You also need **ffmpeg** for pydub:
```bash
brew install ffmpeg         # macOS
# sudo apt-get install ffmpeg   # Debian/Ubuntu
```

### Required keys (`.env`)
- `GROQ_API_KEY`
- `PINECONE_API_KEY`
- `GEMINI_API_KEY`

## Usage

```bash
# 1. Drop .mp3 files into data/input/
# 2. Ingest (transcribe + embed + upsert)
python ingest.py
python ingest.py --dir path/to/audio --audio-type structured

# 3. Query -> produces highlight_reel.mp3
python main.py "what did they say about the roadmap?"
python main.py "funniest moments" --top-k 8 --output funny.mp3
```

## Swappable providers

Everything is driven by `.env`:

- **Embeddings** — default `EMBED_PROVIDER=pinecone` (free, hosted). Set
  `EMBED_PROVIDER=openai` to use `text-embedding-3-small` instead (requires a
  paid OpenAI account; `OPENAI_API_KEY`).
- **Editor LLM** — default `EDITOR_PROVIDER=gemini`. Set `EDITOR_PROVIDER=groq`
  to reuse your Groq key with a Llama model instead of Gemini.

## Files
- `config.py` — env-driven settings.
- `clients.py` — Pinecone + embedding wrappers, retry/backoff helper.
- `chunking.py` — parent/child windowing.
- `ingest.py` — Phase 1: transcribe → chunk → upsert.
- `retrieve.py` — Phase 2: search → editor LLM → clip JSON.
- `stitch.py` — Phase 3: pydub slice + crossfade → MP3.
- `main.py` — query orchestrator (Phase 2 + 3).
