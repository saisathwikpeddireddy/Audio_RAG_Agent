"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { stitchClips, audioBufferToWav } from "@/lib/stitch";
import type { Hit, Clip, LibraryFile } from "@/lib/types";
import type { BlobMode } from "@/components/ReactiveBlob";

const BLOCK_COLORS = ["#ec4899", "#06b6d4", "#eab308"];

function prettyName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

export default function QueryPanel({
  library,
  onReingest,
  onMode,
  onAnalyser,
}: {
  library: LibraryFile[];
  onReingest?: (file: LibraryFile) => void;
  onMode?: (m: BlobMode) => void;
  onAnalyser?: (a: AnalyserNode | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [rawClips, setRawClips] = useState(0);
  const [answer, setAnswer] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaElementAudioSourceNode | null>(null);

  const readyCount = useMemo(() => library.filter((f) => f.status === "ready").length, [library]);

  // Tear down audio graph + reset the blob when leaving the tab.
  useEffect(() => {
    return () => {
      onMode?.("idle");
      onAnalyser?.(null);
      ctxRef.current?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setSelected((prev) => {
      const readyIds = library.filter((f) => f.status === "ready").map((f) => f.file_id);
      const kept = prev.filter((id) => readyIds.includes(id));
      const known = new Set(kept);
      const additions = readyIds.filter((id) => !known.has(id));
      return [...kept, ...additions];
    });
  }, [library]);

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

  // Lazily route the <audio> element through an analyser so the blob can react.
  function ensureAnalyser() {
    const el = audioRef.current;
    if (!el || srcRef.current) return;
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const src = ctx.createMediaElementSource(el);
      src.connect(analyser);
      analyser.connect(ctx.destination);
      ctxRef.current = ctx;
      srcRef.current = src;
      onAnalyser?.(analyser);
    } catch {
      // Analyser is best-effort; playback still works without it.
    }
  }

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
    setRawClips(0);
    setAnswer("");
    setProgress(0);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");
    onMode?.("searching");

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
      setRawClips(data.rawClips ?? (data.clips?.length || 0));
      setAnswer(data.answer ?? "");
      if (data.note) throw new Error(data.note);

      if (!data.clips?.length) {
        setStage("");
        onMode?.("idle");
        if (!data.answer) throw new Error("The editor found no usable clips for this query.");
        return;
      }

      setStage("Stitching audio in your browser…");
      const { buffer } = await stitchClips(data.clips, 50);
      const wav = audioBufferToWav(buffer);
      setAudioUrl(URL.createObjectURL(wav));
      setStage("");
      onMode?.("idle");
    } catch (e) {
      setError((e as Error).message);
      setStage("");
      onMode?.("idle");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`card ${busy ? "pulsing" : ""}`}>
      <strong>2 · Ask for a highlight reel</strong>

      {library.length === 0 ? (
        <div className="muted" style={{ marginTop: 12 }}>
          No audio indexed yet — drop some in the <b>Upload &amp; Index</b> tab first.
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

      <div className="row" style={{ marginTop: 16 }}>
        <input
          type="text"
          placeholder='ask anything… e.g. "what did they say about the roadmap?"'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
        <motion.button
          className="primary"
          onClick={() => run()}
          disabled={busy || !query.trim()}
          whileHover={{ scale: 1.05, rotate: -1 }}
          whileTap={{ scale: 0.94 }}
        >
          {busy ? "…" : "GO"}
        </motion.button>
      </div>

      {chips.length > 0 && (
        <div className="chips">
          {chips.map((q, i) => (
            <motion.button
              key={i}
              className="chip"
              onClick={() => run(q)}
              disabled={busy}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 320, damping: 18, delay: i * 0.04 }}
              whileHover={{ scale: 1.06, rotate: -1.5 }}
              whileTap={{ scale: 0.95 }}
            >
              {q}
            </motion.button>
          ))}
        </div>
      )}

      {stage && (
        <div className="muted" style={{ marginTop: 14 }}>
          <span className="spin" />
          {stage}
        </div>
      )}
      {error && <div className="err">{error}</div>}

      <AnimatePresence>
        {answer && (
          <motion.div
            className="answer"
            initial={{ opacity: 0, scale: 0.9, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 18 }}
          >
            <div className="answer-label">Answer</div>
            <p>{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {clips.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="muted">
              {clips.length} continuous segment(s)
            </div>
            {rawClips > clips.length && (
              <motion.div
                className="tag"
                style={{ background: "var(--yellow)" }}
                initial={{ scale: 0, rotate: -8 }}
                animate={{ scale: 1, rotate: -2 }}
                transition={{ type: "spring", stiffness: 400, damping: 12 }}
              >
                ✨ fused {rawClips} → {clips.length}
              </motion.div>
            )}
          </div>

          {/* Lego-block timeline with a scrubbing playhead. */}
          <div className="timeline">
            {clips.map((c, i) => (
              <motion.div
                key={`${c.file_path}-${c.start_time_ms}-${i}`}
                className="block"
                style={{
                  background: BLOCK_COLORS[i % BLOCK_COLORS.length],
                  flexGrow: Math.max(1, c.end_time_ms - c.start_time_ms),
                  flexBasis: 0,
                }}
                initial={{ scale: 0.4, y: -16, opacity: 0 }}
                animate={{ scale: 1, y: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 320, damping: 14, delay: i * 0.07 }}
                title={
                  (c.parts ?? 1) > 1
                    ? `Fused from ${c.parts} retrieved clips`
                    : `${c.start_time_ms}–${c.end_time_ms}ms`
                }
              >
                {(c.parts ?? 1) > 1 && <span className="fused-badge">🔗 {c.parts}</span>}
              </motion.div>
            ))}
            {audioUrl && (
              <div className="playhead" style={{ left: `${Math.min(1, progress) * 100}%` }} />
            )}
          </div>
        </div>
      )}

      {/* Kept permanently mounted so the analyser (createMediaElementSource can
          only run once per element) stays valid across repeated queries. */}
      <div style={{ marginTop: 14, display: audioUrl ? "block" : "none" }}>
        <audio
          ref={audioRef}
          controls
          src={audioUrl || undefined}
          onPlay={() => {
            ensureAnalyser();
            ctxRef.current?.resume().catch(() => {});
            onMode?.("playing");
          }}
          onPause={() => onMode?.("idle")}
          onEnded={() => {
            onMode?.("idle");
            setProgress(0);
          }}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            if (el.duration) setProgress(el.currentTime / el.duration);
          }}
        />
        <br />
        <a className="dl" href={audioUrl || "#"} download="highlight_reel.wav">
          ↓ Download highlight_reel.wav
        </a>
      </div>

      {clips.length > 0 && hits.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="muted">From these moments:</div>
          {hits.map((h, i) => (
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
