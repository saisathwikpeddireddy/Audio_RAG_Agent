"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import Dropzone from "@/components/Dropzone";
import CapsuleStack from "@/components/CapsuleStack";
import SearchPanel from "@/components/SearchPanel";
import Vault from "@/components/Vault";
import { sessionHeaders } from "@/lib/session";
import { track, trackFirstInteraction } from "@/lib/track";
import type { LibraryFile } from "@/lib/types";

const HIDE_DEMO_KEY = "hideDemo";

export default function Home() {
  const [library, setLibrary] = useState<LibraryFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [vaultOpen, setVaultOpen] = useState(false);
  // Visitors can hide the preloaded demo recordings and work only with their own.
  // Read after mount (localStorage isn't available during prerender).
  const [hideDemo, setHideDemo] = useState(false);
  // Ready files already auto-selected once (so a manual deselect sticks).
  const seenReady = useRef<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Pull the live library. `no-store` is critical: the client polls this for
  // status, and a browser-cached response is what forced users to hard-refresh
  // to see uploads flip from "indexing" → "ready".
  const refresh = useCallback(async () => {
    try {
      const d = await fetch("/api/files", { cache: "no-store", headers: sessionHeaders() }).then(
        (r) => r.json()
      );
      if (Array.isArray(d.library)) setLibrary(d.library);
    } catch {
      // ignore transient fetch errors; the next poll will retry
    }
  }, []);

  useEffect(() => {
    refresh();
    track("visit");
    return trackFirstInteraction();
  }, [refresh]);

  useEffect(() => {
    try {
      setHideDemo(localStorage.getItem(HIDE_DEMO_KEY) === "1");
    } catch {
      // storage blocked: keep the demo visible
    }
  }, []);

  const toggleDemo = useCallback((hide: boolean) => {
    // Showing the demo again should re-select its files, so forget we saw them.
    if (!hide) library.filter((f) => f.readOnly).forEach((f) => seenReady.current.delete(f.file_id));
    setHideDemo(hide);
    try {
      localStorage.setItem(HIDE_DEMO_KEY, hide ? "1" : "0");
    } catch {
      // not persisted; fine for this visit
    }
  }, [library]);

  const demoFiles = library.filter((f) => f.readOnly);
  // What this visitor works with: everything, or only their own files.
  const visible = hideDemo ? library.filter((f) => !f.readOnly) : library;

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
  }, [processing, refresh]);

  // Auto-select files as they become ready; drop ids that vanish (or get hidden).
  // When a visitor's own first file becomes ready, the demo recordings are
  // deselected so their searches hit their audio, not the speeches.
  useEffect(() => {
    const ready = visible.filter((f) => f.status === "ready");
    const readyIds = ready.map((f) => f.file_id);
    const fresh = ready.filter((f) => !seenReady.current.has(f.file_id));
    const hadOwn = [...seenReady.current].some((id) => ready.some((f) => f.file_id === id && !f.readOnly));
    const firstOwn = !hadOwn && fresh.some((f) => !f.readOnly);
    fresh.forEach((f) => seenReady.current.add(f.file_id));
    setSelected((prev) => {
      let kept = prev.filter((id) => readyIds.includes(id));
      if (firstOwn) {
        const demoIds = new Set(ready.filter((f) => f.readOnly).map((f) => f.file_id));
        kept = kept.filter((id) => !demoIds.has(id));
      }
      const known = new Set(kept);
      const additions = fresh
        .filter((f) => !(firstOwn && f.readOnly))
        .map((f) => f.file_id)
        .filter((id) => !known.has(id));
      return [...kept, ...additions];
    });
    // `visible` is derived from these two; depending on it directly would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, hideDemo]);

  const onIndexed = useCallback((entry: LibraryFile) => {
    setLibrary((prev) => [...prev.filter((f) => f.file_id !== entry.file_id), entry]);
  }, []);

  const toggleSelected = useCallback((fileId: string) => {
    setSelected((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    );
  }, []);

  const deleteFile = useCallback(async (fileId: string) => {
    // Optimistically drop it so the capsule/vault row animates out immediately.
    setLibrary((prev) => prev.filter((f) => f.file_id !== fileId));
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(fileId)}`, {
        method: "DELETE",
        headers: sessionHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.library)) {
        setLibrary(data.library);
      } else {
        // Deletion failed - re-sync so the file reappears rather than lying.
        refresh();
      }
    } catch {
      refresh();
    }
  }, []);

  const reingest = useCallback(
    async (file: LibraryFile) => {
      onIndexed({ ...file, status: "processing", error: undefined });
      try {
        const res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...sessionHeaders() },
          body: JSON.stringify({
            url: file.blob_url,
            filename: file.filename,
            audioType: file.audio_type,
          }),
        });
        const data = await res.json();
        if (data.entry) onIndexed(data.entry as LibraryFile);
      } catch {
        onIndexed({ ...file, status: "failed", error: "Couldn't start re-indexing." });
      }
    },
    [onIndexed]
  );

  const hasFiles = visible.length > 0;
  const showDemo = !hideDemo && demoFiles.length > 0;
  const demoReady = demoFiles.filter((f) => f.status === "ready").length;

  return (
    <>
      <main className="wrap">
        <div className="topbar">
          <motion.h1
            className="title"
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 18 }}
          >
            Audio RAG <span className="spark">Workspace</span>
          </motion.h1>

          <motion.button
            className="vault-btn"
            onClick={() => setVaultOpen(true)}
            whileHover={{ scale: 1.06, rotate: -2 }}
            whileTap={{ scale: 0.96 }}
            title="Manage your sources"
          >
            📁 Active Sources{hasFiles ? ` (${visible.length})` : ""}
          </motion.button>
        </div>

        <p className="subtitle">
          Ask questions about any recording and jump straight to the exact moments that answer them.
          No scrubbing through hours of audio.
        </p>

        {/* A plain-language "how it works" so every visitor gets the idea, whether
            or not they have sources yet. */}
        <div className="how">
          <div className="how-step">
            <span className="how-num">1</span>
            <div className="how-h">Add a recording</div>
            <div className="how-p">A podcast, lecture, interview, call, or meeting.</div>
          </div>
          <div className="how-step">
            <span className="how-num">2</span>
            <div className="how-h">Ask in plain English</div>
            <div className="how-p">Like &ldquo;what did they decide about pricing?&rdquo;</div>
          </div>
          <div className="how-step">
            <span className="how-num">3</span>
            <div className="how-h">Get the moments</div>
            <div className="how-p">Play or download the exact quotes, with transcripts.</div>
          </div>
        </div>

        {/* Clearly-labelled demo: preloaded public-domain recordings so the very
            first click shows value. Hideable, for visitors who only want their
            own audio. */}
        {showDemo && (
          <motion.div
            className="demo-banner"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 24 }}
          >
            <div className="demo-banner-head">
              <span className="demo-badge">DEMO</span>
              <strong>
                {demoReady < demoFiles.length
                  ? "Preparing 3 sample recordings…"
                  : "Try it now: 3 famous speeches are preloaded."}
              </strong>
            </div>
            <p className="demo-banner-p">
              Tap a suggested question below, or ask your own. Each answer links to the exact
              moments in the audio.
            </p>
            <ul className="demo-list">
              {demoFiles.map((f) => (
                <li key={f.file_id}>
                  <b>{f.title}</b>
                  {f.demo?.blurb ? <span className="muted"> · {f.demo.blurb}</span> : null}
                </li>
              ))}
            </ul>
            <div className="demo-banner-foot">
              <span className="muted">
                Public domain, from{" "}
                <a href="https://commons.wikimedia.org/" target="_blank" rel="noreferrer">
                  Wikimedia Commons
                </a>
                .
              </span>
              <button type="button" className="demo-hide" onClick={() => toggleDemo(true)}>
                Hide demo, use only my audio
              </button>
            </div>
          </motion.div>
        )}
        {hideDemo && demoFiles.length > 0 && (
          <button type="button" className="demo-show" onClick={() => toggleDemo(false)}>
            ▶ Show the demo recordings
          </button>
        )}

        {/* Empty state (no sources): only the giant dropzone. With sources: the
            dropzone collapses to a small "+ Add more audio" pill, and the source
            pills + search bar appear below it. */}
        <Dropzone compact={hasFiles} onIndexed={onIndexed} onUploaded={refresh} />

        {hasFiles && (
          <>
            <CapsuleStack
              library={visible}
              selected={selected}
              onToggle={toggleSelected}
              onReingest={reingest}
            />

            <SearchPanel library={visible} selected={selected} demo={showDemo} />
          </>
        )}

        <p className="muted" style={{ marginTop: 24 }}>
          Clips are sliced in your browser for playback and download. Nothing is re-uploaded.
        </p>
      </main>

      <Vault open={vaultOpen} onClose={() => setVaultOpen(false)} library={visible} onDelete={deleteFile} />
    </>
  );
}
