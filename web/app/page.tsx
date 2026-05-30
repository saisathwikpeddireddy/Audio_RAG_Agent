"use client";

import { useState } from "react";
import Uploader from "@/components/Uploader";
import QueryPanel from "@/components/QueryPanel";

export default function Home() {
  const [tab, setTab] = useState<"upload" | "query">("upload");

  return (
    <main className="wrap">
      <h1 className="title">Audio RAG Auto-Editor</h1>
      <p className="subtitle">
        Upload your audio, ask a question, and get a seamless highlight reel stitched from the
        most relevant moments — powered by Groq Whisper, Pinecone, and Gemini.
      </p>

      <div className="tabs">
        <button className={`tab ${tab === "upload" ? "active" : ""}`} onClick={() => setTab("upload")}>
          Upload &amp; Index
        </button>
        <button className={`tab ${tab === "query" ? "active" : ""}`} onClick={() => setTab("query")}>
          Query
        </button>
      </div>

      {tab === "upload" ? <Uploader /> : <QueryPanel />}

      <p className="muted" style={{ marginTop: 24 }}>
        Tip: index your audio first, then switch to the Query tab. Audio is stitched locally in
        your browser, so nothing is re-uploaded to generate the reel.
      </p>
    </main>
  );
}
