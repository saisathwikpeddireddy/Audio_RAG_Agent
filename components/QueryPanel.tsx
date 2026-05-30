"use client";

import { useEffect, useMemo, useState } from "react";
import { stitchClips, audioBufferToWav } from "@/lib/stitch";
import type { Hit, Clip, LibraryFile } from "@/lib/types";

function prettyName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

export default function QueryPanel({
  library,
  onReingest,
}: {
  library: LibraryFile[];
  onReingest?: (file: LibraryFile) => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [answer, setAnswer] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const readyCount = useMemo(() => library.filter((f) => f.status === "ready").length, [library]);

  // Only "ready" files are selectable; newly-ready files join the selection,
  // processing/failed files drop out.
  useEffect(() => {
    setSelected((prev) => {
      const readyIds = library.filter((f) => f.status === "ready").map((f) => f.file_id);
      const kept = prev.filter((id) => readyIds.includes(id));
      const known = new Set(kept);
      const additions = readyIds.filter((id) => !known.has(id));
      return [...kept, ...additions];
    });
  }, [library]);

  // Example questions = grounded suggestions from the selected (ready) sources.
  const chips = useMemo(() => {
    const sel = new Set(selected);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of library) {
      if (f.status !== "ready" || !sel.has(f.file_id)) continue;
      for (const q of f.suggestions ?? []) {
        const key = q.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(q);
        }
      }
    }
    return out.slice(0, 6);
  }, [library, selected]);

  function toggle(fileId: string) {
    setSelected((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    );
  }
  const selectAll = () => setSelected(library.filter((f) => f.status === "ready").map((f) => f.file_id));
  const selectNone = () => setSelected([]);

  async function run(override?: string) {
    const q = (override ?? query).trim();
    if (!q || busy) return;
    if (readyCount === 0) {
      setError("No sources are ready to search yet — index audio in the Upload tab first.");
      return;
    }
    if (selected.length === 0) {
      setError("Select at least one source to search.");
      return;
    }

    setBusy(true);
    setError("");
    setHits([]);
    setClips([]);
    setAnswer("");
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");

    try {
      setStage("Searching Pinecone & asking the editor…");
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, fileIds: selected }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");

      setHits(data.hits ?? []);
      setClips(data.clips ?? []);
      setAnswer(data.answer ?? "");
      if (data.note) throw new Error(data.note);

      if (!data.clips?.length) {
        setStage("");
        if (!data.answer) throw new Error("The editor found no usable clips for this query.");
        return;
      }

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

      {library.length === 0 ? (
        <div className="muted" style={{ marginTop: 12 }}>
          No audio indexed yet — upload some in the <b>Upload &amp; Index</b> tab first.
        </div>
      ) : (
        <div className="sources">
          <div className="sources-head">
            <span className="muted">
              Sources ({selected.length}/{readyCount} ready)
            </span>
            <div className="row" style={{ gap: 12 }}>
              <button className="link" onClick={selectAll} disabled={busy || readyCount === 0}>
                Select all
              </button>
              <button className="link" onClick={selectNone} disabled={busy}>
                Clear
              </button>
            </div>
          </div>
          {library.map((f) => {
            const ready = f.status === "ready";
            return (
              <label className={`source ${ready ? "" : "source-disabled"}`} key={f.file_id}>
                <input
                  type="checkbox"
                  checked={ready && selected.includes(f.file_id)}
                  onChange={() => ready && toggle(f.file_id)}
                  disabled={busy || !ready}
                />
                <span className="source-name" title={f.filename}>
                  {prettyName(f.filename)}
                </span>
                {f.status === "ready" && (
                  <span className="muted source-meta">
                    {f.children} chunks · {f.audio_type}
                  </span>
                )}
                {f.status === "processing" && <span className="tag tag-proc">⏳ indexing</span>}
                {f.status === "failed" && (
                  <span className="row" style={{ gap: 8 }}>
                    <span className="tag tag-fail" title={f.error}>
                      ⚠ failed
                    </span>
                    {onReingest && (
                      <button
                        className="link"
                        onClick={(e) => {
                          e.preventDefault();
                          onReingest(f);
                        }}
                        disabled={busy}
                      >
                        Retry
                      </button>
                    )}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <input
          type="text"
          placeholder='e.g. "what did they say about the roadmap?"'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
        <button className="primary" onClick={() => run()} disabled={busy || !query.trim()}>
          {busy ? "Working…" : "Generate"}
        </button>
      </div>

      {chips.length > 0 && (
        <div className="chips">
          {chips.map((q, i) => (
            <button key={i} className="chip" onClick={() => run(q)} disabled={busy}>
              {q}
            </button>
          ))}
        </div>
      )}

      {stage && (
        <div className="muted" style={{ marginTop: 12 }}>
          <span className="spin" />
          {stage}
        </div>
      )}
      {error && <div className="err">{error}</div>}

      {answer && (
        <div className="answer">
          <div className="answer-label">Answer</div>
          <p>{answer}</p>
        </div>
      )}

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
