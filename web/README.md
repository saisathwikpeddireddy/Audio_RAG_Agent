# Audio RAG Auto-Editor — Web App

A Next.js (App Router) front-end for the Audio RAG pipeline, deployable to Vercel.
Upload MP3s → they're transcribed (Groq), chunked parent/child, and indexed
(Pinecone). Ask a question → Pinecone search + Gemini editor pick the clips →
your **browser** stitches them with a 50ms crossfade into a playable/downloadable
highlight reel.

## Why the browser stitches the audio
Vercel serverless functions can't run `ffmpeg`/`pydub` and are short-lived. So
the heavy lifting is split:
- **Server (API routes):** transcription, chunking, embedding/search, editor LLM.
- **Browser (Web Audio API):** fetch the source MP3s from Vercel Blob, slice by
  millisecond, crossfade, and render the final reel — no ffmpeg needed.

## Architecture
```
Browser ──upload──► Vercel Blob ──URL──► /api/ingest ──► Groq Whisper ─┐
                                                                       ├─► Pinecone (integrated embeddings)
query ─► /api/search ─► Pinecone search ─► Gemini "scalpel" ─► clips ──┘
clips ─► browser fetches Blob URLs ─► Web Audio slice + crossfade ─► highlight_reel.wav
```

## Deploy to Vercel
1. **Import** the repo in Vercel and set the **Root Directory** to `web`.
2. **Storage:** in the project, create a **Blob** store (Storage tab). This adds
   `BLOB_READ_WRITE_TOKEN` automatically.
3. **Environment Variables:** add `GROQ_API_KEY`, `PINECONE_API_KEY`,
   `GEMINI_API_KEY` (and any optional overrides from `.env.example`).
4. **Deploy.** First ingest call auto-creates the Pinecone index.

## Local development
```bash
cd web
npm install
cp .env.example .env.local   # fill in keys
# For Blob + the onUploadCompleted callback to work locally, use:
npx vercel dev               # (or `npm run dev` if you don't need upload callbacks)
```

## Notes
- Uploaded audio is stored as **public** Vercel Blob URLs (so Groq and the
  browser can fetch them). Don't upload anything you wouldn't want publicly
  reachable by URL.
- Groq's free tier caps transcription file size (~25MB) — keep clips modest.
- Output is 16-bit WAV (universally playable). Swap in an MP3 encoder later if
  you want smaller downloads.
- Set `EDITOR_PROVIDER=groq` to use Groq Llama instead of Gemini for the editor.
