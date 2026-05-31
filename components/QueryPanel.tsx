"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { stitchClips, audioBufferToWav } from "@/lib/stitch";
import HoldToDelete from "@/components/HoldToDelete";
import type { Hit, Clip, LibraryFile } from "@/lib/types";
import type { BlobMode } from "@/components/ReactiveBlob";

const BLOCK_COLORS = ["#ec4899", "#06b6d4", "#eab308"];

function prettyName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

// Turn an ugly indexed path ("…/The%20Attention_Equation%20v3.mp3") into a clean,
// human title ("The Attention Equation v3.mp3") for the raw-sources receipt.
function cleanSourceName(path?: string): string {
  if (!path) return "unknown source";
  let name = path.split("/").pop() || path;
  try {
    name = decodeURIComponent(name);
  } catch {
    // leave as-is if it isn't valid percent-encoding
  }
  return name.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function QueryPanel({
  library,
  onReingest,
  onMode,
  onAnalyser,
  onDelete,
}: {
  library: LibraryFile[];
  onReingest?: (file: LibraryFile) => void;
  onMode?: (m: BlobMode) => void;
  onAnalyser?: (a: AnalyserNode | null) => void;
  onDelete?: (fileId: string) => void;
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
  const [playing, setPlaying] = useState(false);
  const [curTime, setCurTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showRaw, setShowRaw] = useState(false);

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

  // Custom transport: drive the hidden <audio> directly so the native chrome
  // never appears (it broke the brutalist look).
  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      ensureAnalyser();
      ctxRef.current?.resume().catch(() => {});
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }

  // Click anywhere on the lego timeline to scrub — replaces the native bar.
  function seekFromTimeline(e: React.MouseEvent<HTMLDivElement>) {
    const el = audioRef.current;
    if (!el || !audioUrl || !el.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = frac * el.duration;
    setProgress(frac);
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
    setPlaying(false);
    setCurTime(0);
    setDuration(0);
    setShowRaw(false);
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
          <AnimatePresence initial={false}>
            {library.map((f) => {
              const ready = f.status === "ready";
              return (
                <motion.label
                  className={`source ${ready ? "" : "source-disabled"}`}
                  key={f.file_id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, scale: 0.6, x: 30 }}
                  transition={{ type: "spring", stiffness: 320, damping: 26 }}
                >
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
                    <>
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
                    </>
                  )}
                  {onDelete && (
                    <HoldToDelete onConfirm={() => onDelete(f.file_id)} disabled={busy} />
                  )}
                </motion.label>
              );
            })}
          </AnimatePresence>
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

          {/* Lego-block timeline with a scrubbing playhead. Click to seek. */}
          <div
            className={`timeline ${audioUrl ? "seekable" : ""}`}
            onClick={audioUrl ? seekFromTimeline : undefined}
          >
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

      {/* Custom brutalist transport replaces the native player. The <audio> is
          kept permanently mounted but visually hidden so the analyser
          (createMediaElementSource runs once per element) stays valid across
          repeated queries. */}
      {audioUrl && (
        <div className="transport">
          <motion.button
            className="primary transport-btn"
            onClick={togglePlay}
            whileHover={{ scale: 1.05, rotate: -1 }}
            whileTap={{ scale: 0.94 }}
          >
            {playing ? "❚❚ PAUSE" : "▶ PLAY"}
          </motion.button>
          <span className="transport-time">
            {fmtTime(curTime)} / {fmtTime(duration)}
          </span>
          <a className="dl transport-dl" href={audioUrl} download="highlight_reel.wav">
            ↓ WAV
          </a>
        </div>
      )}
      <audio
        ref={audioRef}
        src={audioUrl || undefined}
        style={{ display: "none" }}
        onPlay={() => {
          ensureAnalyser();
          ctxRef.current?.resume().catch(() => {});
          setPlaying(true);
          onMode?.("playing");
        }}
        onPause={() => {
          setPlaying(false);
          onMode?.("idle");
        }}
        onEnded={() => {
          setPlaying(false);
          onMode?.("idle");
          setProgress(0);
          setCurTime(0);
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setCurTime(el.currentTime);
          if (el.duration) setProgress(el.currentTime / el.duration);
        }}
      />

      {clips.length > 0 && hits.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <button
            type="button"
            className="raw-toggle"
            onClick={() => setShowRaw((v) => !v)}
            aria-expanded={showRaw}
          >
            <span className="raw-caret">{showRaw ? "▾" : "▸"}</span>
            Inspect raw sources ({hits.length})
          </button>

          <AnimatePresence initial={false}>
            {showRaw && (
              <motion.div
                key="raw"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ type: "spring", stiffness: 320, damping: 30 }}
                style={{ overflow: "hidden" }}
              >
                {hits.map((h, i) => {
                  const pct = Math.round((h._score ?? 0) * 100);
                  return (
                    <div className="hit" key={h._id ?? i}>
                      <div>{h.child_text}</div>
                      <div className="meta">
                        <span className="match-badge">{pct}% match</span>
                        <span className="hit-name">{cleanSourceName(h.file_path)}</span>
                        <span className="hit-time">
                          {fmtTime(h.start_time_ms / 1000)}–{fmtTime(h.end_time_ms / 1000)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
