"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import Dropzone from "@/components/Dropzone";
import CapsuleStack from "@/components/CapsuleStack";
import SearchPanel from "@/components/SearchPanel";
import Vault from "@/components/Vault";
import { sessionHeaders } from "@/lib/session";
import type { LibraryFile } from "@/lib/types";

export default function Home() {
  const [library, setLibrary] = useState<LibraryFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [vaultOpen, setVaultOpen] = useState(false);
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
  }, [refresh]);

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

  // Auto-select files as they become ready; drop ids that vanish from the library.
  useEffect(() => {
    setSelected((prev) => {
      const readyIds = library.filter((f) => f.status === "ready").map((f) => f.file_id);
      const kept = prev.filter((id) => readyIds.includes(id));
      const known = new Set(kept);
      const additions = readyIds.filter((id) => !known.has(id));
      return [...kept, ...additions];
    });
  }, [library]);

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
        // Deletion failed — re-sync so the file reappears rather than lying.
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

  const hasFiles = library.length > 0;

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
            📁 Active Sources{hasFiles ? ` (${library.length})` : ""}
          </motion.button>
        </div>

        <p className="subtitle">
          Upload raw audio, search by intent, and extract the exact quotes that matter.
        </p>

        {/* Empty state (no sources): only the giant dropzone. With sources: the
            dropzone collapses to a small "+ Add more audio" pill, and the source
            pills + search bar appear below it. */}
        <Dropzone compact={hasFiles} onIndexed={onIndexed} onUploaded={refresh} />

        {hasFiles && (
          <>
            <CapsuleStack
              library={library}
              selected={selected}
              onToggle={toggleSelected}
              onReingest={reingest}
            />

            <SearchPanel library={library} selected={selected} />
          </>
        )}

        <p className="muted" style={{ marginTop: 24 }}>
          Clips are sliced in your browser for playback and download — nothing is re-uploaded.
        </p>
      </main>

      <Vault open={vaultOpen} onClose={() => setVaultOpen(false)} library={library} onDelete={deleteFile} />
    </>
  );
}
