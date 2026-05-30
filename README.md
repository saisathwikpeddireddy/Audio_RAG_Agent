# 🎧 Audio RAG Auto-Editor

Upload audio, ask a question in plain English, and get back **a written answer
plus a seamless highlight reel** stitched from the most relevant moments across
your files.

**▶️ Live demo: https://audio-rag-agent-h2xx.vercel.app**

![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Vercel](https://img.shields.io/badge/Deployed-Vercel-black?logo=vercel)
![Groq](https://img.shields.io/badge/Groq-Whisper-f55036)
![Pinecone](https://img.shields.io/badge/Pinecone-Vector%20DB-2bb3a3)
![Gemini](https://img.shields.io/badge/Google-Gemini-4285f4?logo=google)

> Runs entirely on free tiers. No GPU, no local models, no local vector DB — all
> heavy compute and storage live in managed services.

---

## What it does

- **Upload & index** MP3s — transcribed by Groq Whisper, chunked, and embedded
  into Pinecone (hosted embeddings, no OpenAI cost).
- **Ask a question** — semantic search retrieves the most relevant moments, and
  an editor LLM writes a grounded **text answer** *and* picks the exact clip
  boundaries for a **highlight reel**.
- **Pick your sources** — every indexed file is listed with a checkbox so you
  can scope a query to a subset of files (faster + cheaper).
- **Grounded example questions** — each file gets one-click suggested questions
  generated from its own transcript.
- **Browser-side stitching** — the reel is spliced together with the Web Audio
  API in your browser, so audio is never re-uploaded to build it.

## Architecture (web app)

```
                       ┌─────────────── Vercel (Next.js) ───────────────┐
 MP3 ──client upload──►│ Blob storage                                    │
                       │   │                                             │
                       │   └─►/api/ingest ─► Groq Whisper ─► parent/child │
                       │                       chunking ─► Pinecone upsert│
 question ────────────►│ /api/search ─► Pinecone top-K ─► editor LLM ─────┤─► { answer, clips }
                       └─────────────────────────────────────────────────┘
                                                                  │
                          clips ─► Web Audio API splice + crossfade ─► highlight_reel.wav
```

| Stage | Service |
|-------|---------|
| Transcription (segment timestamps) | **Groq** `whisper-large-v3-turbo` |
| Embeddings | **Pinecone** integrated `llama-text-embed-v2` (free Starter) |
| Vector DB | **Pinecone** serverless |
| Editor + answer | **Gemini** `gemini-2.5-flash`, automatic **Groq Llama** fallback |
| File storage | **Vercel Blob** |
| Audio stitching (web) | **Web Audio API** (browser) |
| Audio stitching (CLI) | **pydub** + ffmpeg (local) |
| Hosting | **Vercel** |

### Chunking strategy
**Dynamic-window Parent-Child RAG.** Whisper segments are grouped into *parent*
windows that grow toward a ~30s target and commit only at a **natural pause**
(timestamp gap > 0.5s) or a **sentence terminal** — with a 45s hard cap — so a
parent is dynamically sized but never sliced mid-word or mid-thought. Each
parent is split into *child* sentences; only the children are embedded for
precise semantic matching, but every child stores its **parent's** wide time
window, so retrieval splices a complete thought instead of a clipped fragment.

### Adjacent-clip fusion
After the editor picks clip boundaries, the retriever **fuses** clips on the
same file whose windows overlap or sit within ~0.75s of each other into one
continuous segment. This drops duplicate parent windows and heals tiny gaps, so
the highlight reel plays as an uninterrupted stream rather than crossfading a
seam mid-thought.

---

## Run the web app

The app is a Next.js project at the repo root, deployed on Vercel.

```bash
npm install
cp .env.example .env.local   # fill in your keys
npm run dev                  # http://localhost:3000
```

**Required env vars:** `GROQ_API_KEY`, `PINECONE_API_KEY`, `GEMINI_API_KEY`, and
`BLOB_READ_WRITE_TOKEN` (from a Vercel Blob store). Optional overrides
(`GEMINI_MODEL`, `EDITOR_PROVIDER=groq`, `TOP_K`, …) are listed in
`.env.example`.

**Deploy:** import the repo on Vercel and connect a **Blob** store under the
project's Storage tab — `BLOB_READ_WRITE_TOKEN` is injected automatically.

### Key files (web)
- `app/page.tsx` — tabs + shared library state.
- `components/Uploader.tsx` — client upload to Blob → `/api/ingest`.
- `components/QueryPanel.tsx` — source selection, example chips, answer + reel.
- `app/api/{upload,ingest,search,files}/route.ts` — serverless endpoints.
- `lib/` — `chunking`, `pinecone`, `groq`, `editor`, `suggest`, `library`,
  `stitch`, `config`, `types`.

---

## Run the Python CLI (original pipeline)

The repo also includes the standalone CLI the web app was ported from.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill in your keys
brew install ffmpeg           # pydub needs ffmpeg (or: apt-get install ffmpeg)

# 1. Drop .mp3 files into data/input/
python ingest.py              # transcribe + embed + upsert
python main.py "what did they say about the roadmap?"   # -> highlight_reel.mp3
```

### Swappable providers (`.env`)
- **Embeddings** — default `EMBED_PROVIDER=pinecone` (free, hosted). Set
  `EMBED_PROVIDER=openai` for `text-embedding-3-small` (paid `OPENAI_API_KEY`).
- **Editor LLM** — default `EDITOR_PROVIDER=gemini`; set `EDITOR_PROVIDER=groq`
  to reuse your Groq key with a Llama model.

### Key files (CLI)
- `config.py` · `clients.py` · `chunking.py` · `ingest.py` · `retrieve.py` ·
  `stitch.py` · `main.py`
