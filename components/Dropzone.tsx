"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { upload } from "@vercel/blob/client";
import type { LibraryFile } from "@/lib/types";

type LocalStatus = "uploading" | "queued" | "error";

interface Item {
  name: string;
  fileId?: string;
  local: LocalStatus;
  detail?: string;
}

// The drop target + upload pipeline. Once a file starts indexing it shows up in
// the capsule stack below, so here we only surface files still in flight
// (uploading) or that failed to start — never a duplicate of the capsules.
export default function Dropzone({
  compact,
  onIndexed,
  onUploaded,
}: {
  compact: boolean;
  onIndexed?: (entry: LibraryFile) => void;
  // Called after each ingest resolves so the parent can immediately re-fetch the
  // live file list (which then begins polling for the indexing → ready flip).
  onUploaded?: () => void | Promise<void>;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function patch(name: string, p: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.name === name ? { ...it, ...p } : it)));
  }

  async function processFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith("audio") || f.name.endsWith(".mp3"));
    if (!list.length) return;
    setBusy(true);
    setItems((prev) => [...prev, ...list.map((f) => ({ name: f.name, local: "uploading" as LocalStatus }))]);

    for (const file of list) {
      try {
        patch(file.name, { local: "uploading" });
        const blob = await upload(file.name, file, {
          access: "public",
          handleUploadUrl: "/api/upload",
        });

        const res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: blob.url, filename: file.name, audioType: "conversational" }),
        });
        const data = await res.json();
        if (!res.ok && res.status !== 202) throw new Error(data.error || "Couldn't start indexing");

        const entry = data.entry as LibraryFile | undefined;
        if (entry) {
          // Optimistically hand it to the capsule stack, then force a live re-fetch
          // so the parent picks up the manifest entry and starts status polling.
          patch(file.name, { fileId: entry.file_id, local: "queued" });
          onIndexed?.(entry);
          await onUploaded?.();
          setItems((prev) => prev.filter((it) => it.name !== file.name));
        }
      } catch (e) {
        patch(file.name, { local: "error", detail: (e as Error).message });
      }
    }
    setBusy(false);
  }

  const inFlight = items.filter((it) => it.local === "uploading" || it.local === "error");

  return (
    <div className="dropzone-wrap">
      <motion.div
        className={`drop ${hover ? "hover" : ""} ${compact ? "drop-compact" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHover(false);
          processFiles(e.dataTransfer.files);
        }}
        animate={hover ? { scale: 1.02, rotate: -0.5 } : { scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 15 }}
      >
        {busy ? (
          <span>
            <span className="spin" />
            Adding to your memory bank…
          </span>
        ) : (
          <>
            <div className={`drop-big ${compact ? "drop-big-sm" : ""}`}>
              {hover ? "Drop it here! 🎉" : compact ? "+ Add more audio" : "Drop audio files here"}
            </div>
            {!compact && (
              <div className="muted" style={{ marginTop: 6 }}>
                …to add them to your memory bank. Click to browse, or just drag &amp; drop.
              </div>
            )}
          </>
        )}
      </motion.div>

      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3"
        multiple
        hidden
        onChange={(e) => e.target.files && processFiles(e.target.files)}
      />

      <AnimatePresence>
        {inFlight.map((it) => (
          <motion.div
            className={`cassette ${it.local === "uploading" ? "proc" : ""}`}
            key={it.name}
            layout
            initial={{ opacity: 0, scale: 0.85, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ type: "spring", stiffness: 300, damping: 15 }}
          >
            <div className="cassette-left">
              <div className="reels">
                <span className={`reel ${it.local === "uploading" ? "spinning" : ""}`} />
                <span className={`reel ${it.local === "uploading" ? "spinning" : ""}`} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="cassette-name">{it.name}</div>
                {it.detail && <div className="cassette-detail">{it.detail}</div>}
              </div>
            </div>
            <span className={`badge ${it.local === "error" ? "error" : "working"}`}>
              {it.local === "error" ? "failed" : "uploading"}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
