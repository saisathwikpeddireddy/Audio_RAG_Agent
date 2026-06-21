"use client";

import { AnimatePresence, motion } from "framer-motion";
import HoldToDelete from "@/components/HoldToDelete";
import { formatSourceName } from "@/lib/format";
import type { LibraryFile } from "@/lib/types";

// A side-drawer "vault" for managing the memory bank: list every file and let
// the user purge one with a deliberate hold-to-delete. Keeps destructive
// actions off the main canvas.
export default function Vault({
  open,
  onClose,
  library,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  library: LibraryFile[];
  onDelete: (fileId: string) => void;
}) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="vault-scrim"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.aside
            className="vault"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
          >
            <div className="vault-head">
              <strong>📁 Active Sources</strong>
              <button className="vault-close" onClick={onClose} aria-label="Close vault">
                ✕
              </button>
            </div>
            <p className="muted" style={{ marginBottom: 14 }}>
              Everything in your memory bank. Hold <b>Delete</b> to wipe a file from search, storage
              &amp; transcripts for good.
            </p>

            {library.length === 0 ? (
              <div className="muted">Nothing here yet — add some audio to get started.</div>
            ) : (
              <AnimatePresence initial={false}>
                {library.map((f) => (
                  <motion.div
                    className="vault-row"
                    key={f.file_id}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, x: 24, transition: { duration: 0.15, ease: "easeIn" } }}
                    transition={{ type: "spring", stiffness: 320, damping: 26 }}
                  >
                    <div className="vault-info">
                      <div className="vault-name" title={f.filename}>
                        {formatSourceName(f.title || f.filename)}
                      </div>
                      <div className="muted vault-meta">
                        {f.status === "ready" &&
                          `${f.children} ${f.children === 1 ? "segment" : "segments"} · ${f.audio_type}`}
                        {f.status === "processing" && "Listening & Indexing…"}
                        {f.status === "failed" && (f.error || "failed")}
                      </div>
                    </div>
                    {f.readOnly ? (
                      <span className="tag">demo</span>
                    ) : (
                      <HoldToDelete onConfirm={() => onDelete(f.file_id)} />
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
