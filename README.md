# 🎧 Audio RAG Workspace

Upload raw audio, search it by intent, and get back **a grounded written answer
plus a ranked feed of playable audio quotes** - each one a self-contained moment
you can play, read along to (karaoke-style), and download.

**▶️ Live demo: https://audio-rag-agent-h2xx.vercel.app**

![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Vercel](https://img.shields.io/badge/Deployed-Vercel-black?logo=vercel)
![Groq](https://img.shields.io/badge/Groq-Whisper-f55036)
![Pinecone](https://img.shields.io/badge/Pinecone-Vector%20DB-2bb3a3)
![Gemini](https://img.shields.io/badge/Google-Gemini-4285f4?logo=google)

> Runs entirely on free tiers. No GPU, no local models, no local vector DB - all
> heavy compute and storage live in managed services, and audio is sliced in the
> browser so nothing is ever re-uploaded.

---

## What it does

- **Upload & index** audio - transcribed by Groq Whisper with **word-level
  timestamps**, split into overlapping sentence chunks, and embedded into
  Pinecone (hosted embeddings, no OpenAI cost).
- **Search by intent** - semantic search retrieves the most relevant moments,
  and an LLM writes a concise **answer grounded only in the retrieved chunks**.
- **Atomic result cards** - every retrieved chunk becomes its own card (strict
  1:1), showing its timestamp range, a match score, and the exact transcript.
- **Tactile playback** - each card plays *only its own* segment of the source
  audio, with a **karaoke highlight** sweeping the words in sync and an animated
  **waveform** that dances only while that card is playing.
- **Pick your sources** - indexed files appear as toggle pills so you can scope a
  query to a subset (faster + cheaper); a **Vault** drawer manages/deletes files.
- **Per-visitor workspaces** - each visitor gets an isolated, sandboxed session
  (uploads + search are scoped to them), plus a shared read-only **demo corpus**
  so the app is searchable the moment you land - no upload required.
- **Grounded suggestions** - each file gets one-click example questions generated
  from its own transcript.
- **Keyboard-first** - `J`/`K` (or ↑/↓) to move between cards, `Space` to
  play/pause, `D` to download the focused card.
- **Browser-side audio** - playback and per-card WAV downloads are sliced with
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
| Answer LLM | **Gemini** `gemini-2.5-flash`, automatic **Groq** fallback |
| File storage | **Vercel Blob** |
| Audio playback + slicing | **Web Audio API** (browser) |
| Hosting | **Vercel** |

### Chunking strategy

**Sliding-window sentence chunking with anchor look-backs** (`lib/chunking.ts`):

1. **Sentence tokenization** - Whisper's word stream is grouped into
   grammatically-complete sentences, finalized *only* on terminal punctuation
   (`.`, `?`, `!`) - never on commas or pauses. Each sentence keeps word-precise
   `start`/`end` boundaries.
2. **Overlapping windows** - sentences are assembled into ~25s chunks; the next
   chunk re-seeds with the **last sentence of the previous chunk**, so context
   overlaps across boundaries.
3. **Anchor check** - if a chunk would start on a conjunction or continuation
   pronoun (*And, But, So, It, They, This…*), it steps back to prepend earlier
   sentences until it begins on a strong anchor word - so every chunk reads as a
   self-contained narrative with a proper start.

The DB schema is **flat**: one vector per chunk, with `start_time_ms` /
`end_time_ms` as that chunk's absolute boundaries. The frontend maps `hits`
strictly 1:1 to cards - no client-side grouping or de-duplication.

### Sessions & isolation

The public demo is multi-tenant without auth or a database:

- **Per-visitor session** - a `sid` cookie (24h) scopes everything. Every vector
  carries a `session_id`; Blob uploads and the JSON manifest live under
  `library/{sid}/`. Search is filtered to `session_id ∈ { yours, "demo" }`, so
  visitors never see or delete each other's files.
- **Shared demo corpus** - the special `demo` session holds three public-domain
  speeches (JFK's 1962 Moon speech, FDR's first Fireside Chat, Eisenhower's
  farewell address, from Wikimedia Commons) with hand-written suggested
  questions, merged read-only into everyone's view under a clear **DEMO** banner.
  It seeds itself: the first `/api/files` request after deploy copies the audio
  into Blob and indexes it in the background (`lib/demoCorpus.ts`,
  `lib/demoSeed.ts`), and retries anything that failed. Visitors can **hide the
  demo** to work only with their own audio.
- **Auto-expiry** - a daily Vercel Cron (`/api/cleanup`, guarded by
  `CRON_SECRET`) purges sessions whose newest file is >24h old - deleting their
  vectors, audio blobs, and manifest - so storage never creeps past the free
  tier. The `demo` session is never touched.

### Analytics & cost (admin)

A password-gated dashboard at **`/admin`** (set `ADMIN_PASSWORD`) tracks the app
without any third-party service or database:

- **Who / from where** - visits + unique visitors with coarse country/city from
  Vercel's IP headers (raw IPs are never stored) and top referrers.
- **What they do** - searches, uploads, files indexed, plays, downloads, errors.
- **Humans vs bots** - every event keeps its user agent. Known crawlers, link
  unfurlers, monitors and headless browsers are tagged as bots, and a visit only
  counts as human after a real interaction (click, tap, key press, scroll, or any
  search/play/upload). Page loads with no interaction are shown separately.
- **Self-test** - a button (or `GET /api/admin/selftest`) runs one real search
  and one play beacon through the live handlers and confirms both were recorded.
  Test traffic is filed separately and never counted.
- **What it costs** - per-action estimates (Groq transcription per second, Gemini
  per token, Blob storage per GB) rolled into a daily + by-type cost view.

Each action writes one small JSON event to Blob under `analytics/events/`; the
dashboard reads and aggregates them. See `lib/analytics.ts` and `lib/costs.ts`.

This sits alongside **Vercel Web Analytics** (`<Analytics />` in the root layout),
which handles the polished visitors / page views / bounce / device breakdown, and
**Vercel Speed Insights** (`<SpeedInsights />`), which reports real-world Core Web
Vitals - both in the Vercel console. They're complementary: Vercel for audience +
performance metrics, the custom dashboard for the per-action funnel and cost.

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
(`GEMINI_MODEL`, `EDITOR_PROVIDER=groq`, `TOP_K`, `PINECONE_*`, `CRON_SECRET`,
`SEED_SECRET`, …) are listed in `.env.example`.

**Deploy:** import the repo on Vercel and connect a **Blob** store under the
project's Storage tab - `BLOB_READ_WRITE_TOKEN` is injected automatically. The
cleanup cron in `vercel.json` runs automatically on Vercel.

**Demo corpus:** seeds itself on first load (see above). To add an extra clip by
hand, use the seeder:

```bash
curl -X POST https://<your-app>/api/seed-demo \
  -H "Authorization: Bearer $SEED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<blob-url>/talk.mp3","filename":"The Attention Equation.mp3"}'
```

### Project layout

- `app/page.tsx` - shared library state, status polling, empty-state logic.
- `app/layout.tsx` · `app/globals.css` - shell + neubrutalist styling.
- `app/api/`
  - `upload/route.ts` - Vercel Blob client-upload handshake.
  - `ingest/route.ts` - session-scoped kickoff (background `waitUntil`, 202).
  - `search/route.ts` - Pinecone query (scoped to session + demo) → answer LLM.
  - `files/route.ts` · `files/[id]/route.ts` - list (merged view) / delete (ownership-checked).
  - `seed-demo/route.ts` - manual seeder for extra demo clips.
  - `cleanup/route.ts` - daily cron that purges expired sessions.
  - `track/route.ts` - client analytics beacon (visit / engaged / play / download).
  - `admin/stats/route.ts` - password-gated analytics aggregation (bot-aware).
  - `admin/selftest/route.ts` - end-to-end search + tracking check.
- `app/admin/page.tsx` - the analytics dashboard.
- `components/`
  - `Dropzone.tsx` - drag-and-drop upload pipeline.
  - `CapsuleStack.tsx` - source toggle pills.
  - `SearchPanel.tsx` - search box, suggestion chips, result cards, karaoke + waveform.
  - `Vault.tsx` · `HoldToDelete.tsx` - file management drawer + safe delete.
- `lib/` - `chunking`, `groq`, `pinecone`, `editor`, `suggest`, `library`,
  `ingestPipeline`, `demoCorpus` + `demoSeed`, `bots`, `stitch`, `format`, `errors`, `session` (client) +
  `sessionServer`, `analytics` + `costs` + `track` (client), `config`, `types`.
- `types/pinecone.ts` - the single source of truth for the vector metadata schema.
