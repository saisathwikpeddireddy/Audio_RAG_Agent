"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import Uploader from "@/components/Uploader";
import QueryPanel from "@/components/QueryPanel";
import type { LibraryFile } from "@/lib/types";
import type { BlobMode } from "@/components/ReactiveBlob";

// Three.js is client-only and heavy — load it lazily, never on the server.
const ReactiveBlob = dynamic(() => import("@/components/ReactiveBlob"), { ssr: false });

export default function Home() {
  const [tab, setTab] = useState<"upload" | "query">("upload");
  const [library, setLibrary] = useState<LibraryFile[]>([]);
  const [blobMode, setBlobMode] = useState<BlobMode>("idle");
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    try {
      const d = await fetch("/api/files").then((r) => r.json());
      if (Array.isArray(d.library)) setLibrary(d.library);
    } catch {
      // ignore transient fetch errors; the next poll will retry
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Poll while any file is still processing, so status flips without a refresh.
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

  const onIndexed = useCallback((entry: LibraryFile) => {
    setLibrary((prev) => [...prev.filter((f) => f.file_id !== entry.file_id), entry]);
  }, []);

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
    <>
      <ReactiveBlob mode={blobMode} analyser={analyser} />

      <main className="wrap">
        <motion.h1
          className="title"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 18 }}
        >
          Audio RAG <span className="spark">Auto-Editor</span>
        </motion.h1>
        <p className="subtitle">
          Drop audio, ask a question, and get a written answer plus a seamless highlight reel
          stitched from the most relevant moments — powered by Groq Whisper, Pinecone &amp; Gemini.
        </p>

        <div className="tabs">
          {(["upload", "query"] as const).map((t) => (
            <motion.button
              key={t}
              className={`tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
              whileHover={{ scale: 1.05, rotate: -1 }}
              whileTap={{ scale: 0.96 }}
            >
              {t === "upload" ? "Upload & Index" : `Query${library.length ? ` (${library.length})` : ""}`}
            </motion.button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ type: "spring", stiffness: 300, damping: 24 }}
          >
            {tab === "upload" ? (
              <Uploader library={library} onIndexed={onIndexed} />
            ) : (
              <QueryPanel
                library={library}
                onReingest={reingest}
                onMode={setBlobMode}
                onAnalyser={setAnalyser}
              />
            )}
          </motion.div>
        </AnimatePresence>

        <p className="muted" style={{ marginTop: 24 }}>
          Tip: index your audio first, then switch to the Query tab. Pick which sources to search,
          then ask. Audio is stitched locally in your browser, so nothing is re-uploaded to make
          the reel.
        </p>
      </main>
    </>
  );
}
