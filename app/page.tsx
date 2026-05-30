"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Uploader from "@/components/Uploader";
import QueryPanel from "@/components/QueryPanel";
import type { LibraryFile } from "@/lib/types";

export default function Home() {
  const [tab, setTab] = useState<"upload" | "query">("upload");
  const [library, setLibrary] = useState<LibraryFile[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    try {
      const d = await fetch("/api/files").then((r) => r.json());
      if (Array.isArray(d.library)) setLibrary(d.library);
    } catch {
      // ignore transient fetch errors; the next poll will retry
    }
  }

  // Load previously-indexed files once on mount.
  useEffect(() => {
    refresh();
  }, []);

  // Poll while any file is still processing, so status flips to ready/failed
  // without a manual refresh.
  const processing = library.some((f) => f.status === "processing");
  useEffect(() => {
    if (processing && !pollRef.current) {
      pollRef.current = setInterval(refresh, 2500);
    } else if (!processing && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [processing]);

  // Upsert by file_id so both tabs reflect a file the moment it's enqueued.
  const onIndexed = useCallback((entry: LibraryFile) => {
    setLibrary((prev) => [...prev.filter((f) => f.file_id !== entry.file_id), entry]);
  }, []);

  // Re-run ingestion for a failed (or stuck) file — idempotent on the vectors.
  const reingest = useCallback(
    async (file: LibraryFile) => {
      onIndexed({ ...file, status: "processing", error: undefined });
      try {
        const res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: file.blob_url,
            filename: file.filename,
            audioType: file.audio_type,
          }),
        });
        const data = await res.json();
        if (data.entry) onIndexed(data.entry as LibraryFile);
      } catch {
        onIndexed({ ...file, status: "failed", error: "Could not start re-indexing." });
      }
    },
    [onIndexed]
  );

  return (
    <main className="wrap">
      <h1 className="title">Audio RAG Auto-Editor</h1>
      <p className="subtitle">
        Upload your audio, ask a question, and get a written answer plus a seamless highlight reel
        stitched from the most relevant moments — powered by Groq Whisper, Pinecone, and Gemini.
      </p>

      <div className="tabs">
        <button className={`tab ${tab === "upload" ? "active" : ""}`} onClick={() => setTab("upload")}>
          Upload &amp; Index
        </button>
        <button className={`tab ${tab === "query" ? "active" : ""}`} onClick={() => setTab("query")}>
          Query{library.length ? ` (${library.length})` : ""}
        </button>
      </div>

      {tab === "upload" ? (
        <Uploader library={library} onIndexed={onIndexed} />
      ) : (
        <QueryPanel library={library} onReingest={reingest} />
      )}

      <p className="muted" style={{ marginTop: 24 }}>
        Tip: index your audio first, then switch to the Query tab. Pick which sources to search,
        then ask. Audio is stitched locally in your browser, so nothing is re-uploaded to generate
        the reel.
      </p>
    </main>
  );
}
