"use client";

import { useMemo, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import type { LibraryFile } from "@/lib/types";

// Local-only states before the file is handed off to background indexing.
type LocalStatus = "uploading" | "queued" | "error";

interface Item {
  name: string;
  fileId?: string; // set once /api/ingest accepts the job
  local: LocalStatus;
  detail?: string;
}

export default function Uploader({
  library,
  onIndexed,
}: {
  library: LibraryFile[];
  onIndexed?: (entry: LibraryFile) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [audioType, setAudioType] = useState("conversational");
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const libById = useMemo(() => {
    const m = new Map<string, LibraryFile>();
    for (const f of library) m.set(f.file_id, f);
    return m;
  }, [library]);

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

        // Hand off to background indexing; the endpoint returns 202 immediately.
        const res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: blob.url, filename: file.name, audioType }),
        });
        const data = await res.json();
        if (!res.ok && res.status !== 202) throw new Error(data.error || "Ingest failed to start");

        const entry = data.entry as LibraryFile | undefined;
        if (entry) {
          patch(file.name, { fileId: entry.file_id, local: "queued" });
          onIndexed?.(entry); // shows up as "processing"; page polling tracks it
        }
      } catch (e) {
        patch(file.name, { local: "error", detail: (e as Error).message });
      }
    }
    setBusy(false);
  }

  // Resolve what to show for an item: live library status wins once indexing
  // has been handed off; otherwise the local upload state.
  function view(it: Item): { badge: string; cls: string; detail?: string } {
    const lib = it.fileId ? libById.get(it.fileId) : undefined;
    if (lib) {
      if (lib.status === "ready")
        return { badge: "indexed", cls: "done", detail: `${lib.children} sentences indexed` };
      if (lib.status === "failed") return { badge: "failed", cls: "error", detail: lib.error };
      return { badge: "indexing", cls: "working", detail: "transcribing & embedding…" };
    }
    if (it.local === "uploading") return { badge: "uploading", cls: "working" };
    if (it.local === "queued") return { badge: "queued", cls: "working" };
    return { badge: "error", cls: "error", detail: it.detail };
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 14, justifyContent: "space-between" }}>
        <strong>1 · Upload &amp; index audio</strong>
        <div className="row" style={{ gap: 8 }}>
          <span className="muted">Type:</span>
          <select value={audioType} onChange={(e) => setAudioType(e.target.value)}>
            <option value="conversational">conversational</option>
            <option value="structured">structured</option>
          </select>
        </div>
      </div>

      <div
        className={`drop ${hover ? "hover" : ""}`}
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
      >
        {busy ? (
          <span>
            <span className="spin" />
            Uploading…
          </span>
        ) : (
          <>
            <div style={{ fontSize: 15, color: "var(--text)" }}>Drop MP3 files here, or click to browse</div>
            <div className="muted" style={{ marginTop: 6 }}>
              Transcribed by Groq Whisper, indexed in Pinecone — indexing runs in the background.
            </div>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3"
        multiple
        hidden
        onChange={(e) => e.target.files && processFiles(e.target.files)}
      />

      {items.map((it) => {
        const v = view(it);
        return (
          <div className="file" key={it.name}>
            <div>
              <div>{it.name}</div>
              {v.detail && <div className="muted">{v.detail}</div>}
            </div>
            <span className={`badge ${v.cls}`}>{v.badge}</span>
          </div>
        );
      })}
    </div>
  );
}
