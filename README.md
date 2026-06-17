# 🎧 Audio RAG Workspace

Upload raw audio, search it by intent, and get back **a grounded written answer
plus a ranked feed of playable audio quotes** — each one a self-contained moment
you can play, read along to (karaoke-style), and download.

**▶️ Live demo: https://audio-rag-agent-h2xx.vercel.app**

![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Vercel](https://img.shields.io/badge/Deployed-Vercel-black?logo=vercel)
![Groq](https://img.shields.io/badge/Groq-Whisper-f55036)
![Pinecone](https://img.shields.io/badge/Pinecone-Vector%20DB-2bb3a3)
![Gemini](https://img.shields.io/badge/Google-Gemini-4285f4?logo=google)

> Runs entirely on free tiers. No GPU, no local models, no local vector DB — all
> heavy compute and storage live in managed services, and audio is sliced in the
> browser so nothing is ever re-uploaded.

---

## What it does

- **Upload & index** audio — transcribed by Groq Whisper with **word-level
  timestamps**, split into overlapping sentence chunks, and embedded into
  Pinecone (hosted embeddings, no OpenAI cost).
- **Search by intent** — semantic search retrieves the most relevant moments,
  and an LLM writes a concise **answer grounded only in the retrieved chunks**.
- **Atomic result cards** — every retrieved chunk becomes its own card (strict
  1:1), showing its timestamp range, a match score, and the exact transcript.
- **Tactile playback** — each card plays *only its own* segment of the source
  audio, with a **karaoke highlight** sweeping the words in sync and an animated
  **waveform** that dances only while that card is playing.
- **Pick your sources** — indexed files appear as toggle pills so you can scope a
  query to a subset (faster + cheaper); a **Vault** drawer manages/deletes files.
- **Grounded suggestions** — each file gets one-click example questions generated
  from its own transcript.
- **Keyboard-first** — `J`/`K` (or ↑/↓) to move between cards, `Space` to
  play/pause, `D` to download the focused card.
- **Browser-side audio** — playback and per-card WAV downloads are sliced with
  the Web Audio API client-side; the source audio is never re-uploaded.

## Architecture

```
                        ┌──────────────── Vercel (Next.js) ────────────────┐
 audio ──client upload─►│ Blob storage                                       │
                        │   │                                                │
                        │   └─► /api/ingest ─► Groq Whisper (word timestamps)│
                        │                       ─► sliding-window chunking    │
                        │                       ─► Pinecone upsert            │
 query ────────────────►│ /api/search ─► Pinecone top-K ─► answer LLM ────────┤─► { answer, hits }
                        └────────────────────────────────────────────────────┘
                                                                       │
 hits ─1:1─► result cards ─► Web Audio API (seek + slice per chunk) ─► play / download.wav
```

| Stage | Service |
|-------|---------|
| Transcription (word timestamps) | **Groq** `whisper-large-v3-turbo` |
| Embeddings | **Pinecone** integrated `llama-text-embed-v2` (free Starter) |
| Vector DB | **Pinecone** serverless |
| Answer LLM | **Gemini** `gemini-2.5-flash`, automatic **Groq Llama** fallback |
| File storage | **Vercel Blob** |
| Audio playback + slicing | **Web Audio API** (browser) |
| Hosting | **Vercel** |

### Chunking strategy

**Sliding-window sentence chunking with anchor look-backs** (`lib/chunking.ts`):

1. **Sentence tokenization** — Whisper's word stream is grouped into
   grammatically-complete sentences, finalized *only* on terminal punctuation
   (`.`, `?`, `!`) — never on commas or pauses. Each sentence keeps word-precise
   `start`/`end` boundaries.
2. **Overlapping windows** — sentences are assembled into ~25s chunks; the next
   chunk re-seeds with the **last sentence of the previous chunk**, so context
   overlaps across boundaries.
3. **Anchor check** — if a chunk would start on a conjunction or continuation
   pronoun (*And, But, So, It, They, This…*), it steps back to prepend earlier
   sentences until it begins on a strong anchor word — so every chunk reads as a
   self-contained narrative with a proper start.

The DB schema is **flat**: one vector per chunk, with `start_time_ms` /
`end_time_ms` as that chunk's absolute boundaries. The frontend maps `hits`
strictly 1:1 to cards — no client-side grouping or de-duplication.

---

## Run it

A Next.js app at the repo root, deployed on Vercel.

```bash
npm install
cp .env.example .env.local   # fill in your keys
npm run dev                  # http://localhost:3000
```

**Required env vars:** `GROQ_API_KEY`, `PINECONE_API_KEY`, `GEMINI_API_KEY`, and
`BLOB_READ_WRITE_TOKEN` (from a Vercel Blob store). Optional overrides
(`GEMINI_MODEL`, `EDITOR_PROVIDER=groq`, `TOP_K`, `PINECONE_*`, …) are listed in
`.env.example`.

**Deploy:** import the repo on Vercel and connect a **Blob** store under the
project's Storage tab — `BLOB_READ_WRITE_TOKEN` is injected automatically.

### Project layout

- `app/page.tsx` — shared library state, status polling, empty-state logic.
- `app/layout.tsx` · `app/globals.css` — shell + neubrutalist styling.
- `app/api/`
  - `upload/route.ts` — Vercel Blob client-upload handshake.
  - `ingest/route.ts` — transcribe → chunk → embed (background `waitUntil`, 202).
  - `search/route.ts` — Pinecone query → answer LLM → `{ answer, hits }`.
  - `files/route.ts` · `files/[id]/route.ts` — list / delete (vectors + blob + manifest).
- `components/`
  - `Dropzone.tsx` — drag-and-drop upload pipeline.
  - `CapsuleStack.tsx` — source toggle pills.
  - `SearchPanel.tsx` — search box, suggestion chips, result cards, karaoke + waveform.
  - `Vault.tsx` · `HoldToDelete.tsx` — file management drawer + safe delete.
- `lib/` — `chunking`, `groq`, `pinecone`, `editor`, `suggest`, `library`,
  `stitch`, `format`, `errors`, `config`, `types`.
- `types/pinecone.ts` — the single source of truth for the vector metadata schema.
