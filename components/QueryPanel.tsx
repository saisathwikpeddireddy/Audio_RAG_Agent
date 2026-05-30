"use client";

import { useState } from "react";
import { stitchClips, audioBufferToWav } from "@/lib/stitch";
import type { Hit, Clip } from "@/lib/types";

export default function QueryPanel() {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [audioUrl, setAudioUrl] = useState("");

  async function run() {
    if (!query.trim() || busy) return;
    setBusy(true);
    setError("");
    setHits([]);
    setClips([]);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");

    try {
      setStage("Searching Pinecone & asking the editor…");
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");

      setHits(data.hits ?? []);
      setClips(data.clips ?? []);
      if (data.note) throw new Error(data.note);
      if (!data.clips?.length) throw new Error("The editor found no usable clips for this query.");

      setStage("Stitching audio in your browser…");
      const { buffer } = await stitchClips(data.clips, 50);
      const wav = audioBufferToWav(buffer);
      setAudioUrl(URL.createObjectURL(wav));
      setStage("");
    } catch (e) {
      setError((e as Error).message);
      setStage("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <strong>2 · Ask for a highlight reel</strong>
      <div className="row" style={{ marginTop: 14 }}>
        <input
          type="text"
          placeholder='e.g. "what did they say about the roadmap?"'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
        <button className="primary" onClick={run} disabled={busy || !query.trim()}>
          {busy ? "Working…" : "Generate"}
        </button>
      </div>

      {stage && (
        <div className="muted" style={{ marginTop: 12 }}>
          <span className="spin" />
          {stage}
        </div>
      )}
      {error && <div className="err">{error}</div>}

      {audioUrl && (
        <div style={{ marginTop: 16 }}>
          <audio controls src={audioUrl} />
          <br />
          <a className="dl" href={audioUrl} download="highlight_reel.wav">
            ↓ Download highlight_reel.wav
          </a>
        </div>
      )}

      {clips.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="muted">Editor selected {clips.length} clip(s):</div>
          {hits.length > 0 &&
            hits.map((h, i) => (
              <div className="hit" key={h._id ?? i}>
                <div>{h.child_text}</div>
                <div className="meta">
                  score {h._score?.toFixed(3)} · {h.start_time_ms}–{h.end_time_ms}ms ·{" "}
                  {h.file_path?.split("/").pop()}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
