"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import type { LibraryFile } from "@/lib/types";

type Status = "pending" | "uploading" | "ingesting" | "done" | "error";

interface Item {
  name: string;
  status: Status;
  detail?: string;
}

export default function Uploader({ onIndexed }: { onIndexed?: (entry: LibraryFile) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [audioType, setAudioType] = useState("conversational");
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function setItem(name: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.name === name ? { ...it, ...patch } : it)));
  }

  async function processFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith("audio") || f.name.endsWith(".mp3"));
    if (!list.length) return;
    setBusy(true);
    setItems((prev) => [...prev, ...list.map((f) => ({ name: f.name, status: "pending" as Status }))]);

    for (const file of list) {
      try {
        setItem(file.name, { status: "uploading" });
        const blob = await upload(file.name, file, {
          access: "public",
          handleUploadUrl: "/api/upload",
        });

        setItem(file.name, { status: "ingesting" });
        const res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: blob.url, filename: file.name, audioType }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Ingest failed");

        setItem(file.name, {
          status: "done",
          detail: `${data.parents} parents · ${data.children} sentences indexed`,
        });
        if (data.entry && onIndexed) onIndexed(data.entry as LibraryFile);
      } catch (e) {
        setItem(file.name, { status: "error", detail: (e as Error).message });
      }
    }
    setBusy(false);
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
            Processing…
          </span>
        ) : (
          <>
            <div style={{ fontSize: 15, color: "var(--text)" }}>Drop MP3 files here, or click to browse</div>
            <div className="muted" style={{ marginTop: 6 }}>
              Transcribed by Groq Whisper, indexed in Pinecone
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

      {items.map((it) => (
        <div className="file" key={it.name}>
          <div>
            <div>{it.name}</div>
            {it.detail && <div className="muted">{it.detail}</div>}
          </div>
          <span
            className={`badge ${
              it.status === "done" ? "done" : it.status === "error" ? "error" : it.status === "pending" ? "pending" : "working"
            }`}
          >
            {it.status}
          </span>
        </div>
      ))}
    </div>
  );
}
