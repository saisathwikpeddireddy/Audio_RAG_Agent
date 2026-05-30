"use client";

import { useEffect, useState } from "react";
import Uploader from "@/components/Uploader";
import QueryPanel from "@/components/QueryPanel";
import type { LibraryFile } from "@/lib/types";

export default function Home() {
  const [tab, setTab] = useState<"upload" | "query">("upload");
  const [library, setLibrary] = useState<LibraryFile[]>([]);

  // Load previously-indexed files once on mount.
  useEffect(() => {
    fetch("/api/files")
      .then((r) => r.json())
      .then((d) => setLibrary(Array.isArray(d.library) ? d.library : []))
      .catch(() => {});
  }, []);

  // Called by the Uploader after each successful ingest — upsert by file_id so
  // both tabs stay in sync without a round-trip to Blob.
  function onIndexed(entry: LibraryFile) {
    setLibrary((prev) => [...prev.filter((f) => f.file_id !== entry.file_id), entry]);
  }

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
        <Uploader onIndexed={onIndexed} />
      ) : (
        <QueryPanel library={library} />
      )}

      <p className="muted" style={{ marginTop: 24 }}>
        Tip: index your audio first, then switch to the Query tab. Pick which sources to search,
        then ask. Audio is stitched locally in your browser, so nothing is re-uploaded to generate
        the reel.
      </p>
    </main>
  );
}
