"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { stitchClips, audioBufferToWav } from "@/lib/stitch";
import Equalizer, { type EqState } from "@/components/Equalizer";
import type { Hit, Clip, LibraryFile } from "@/lib/types";

const BLOCK_COLORS = ["#ec4899", "#06b6d4", "#eab308"];

// Turn an ugly indexed path ("…/The%20Attention_Equation%20v3.mp3") into a clean,
// human title ("The Attention Equation v3") for the sources receipt + timeline.
function cleanSourceName(path?: string): string {
  if (!path) return "unknown source";
  let name = path.split("/").pop() || path;
  try {
    name = decodeURIComponent(name);
  } catch {
    // leave as-is if it isn't valid percent-encoding
  }
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function SearchPanel({
  library,
  selected,
}: {
  library: LibraryFile[];
  selected: string[];
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
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [curTime, setCurTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showRaw, setShowRaw] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaElementAudioSourceNode | null>(null);

  const readyCount = useMemo(() => library.filter((f) => f.status === "ready").length, [library]);
  const eqState: EqState = busy ? "searching" : playing ? "playing" : "idle";

  // Tear down the audio graph when this panel unmounts.
  useEffect(() => {
    return () => {
      ctxRef.current?.close().catch(() => {});
    };
  }, []);

  // Grounded one-click prompts from whichever sources are currently active.
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

  // Lazily route the <audio> element through an analyser so the EQ can react.
  function ensureAnalyser() {
    const el = audioRef.current;
    if (!el || srcRef.current) return;
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      const node = ctx.createAnalyser();
      node.fftSize = 256;
      const src = ctx.createMediaElementSource(el);
      src.connect(node);
      node.connect(ctx.destination);
      ctxRef.current = ctx;
      srcRef.current = src;
      setAnalyser(node);
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
      setError("Add some audio above first, then ask away.");
      return;
    }
    if (selected.length === 0) {
      setError("Select at least one audio file above to start searching.");
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

    try {
      setStage("Digging through your audio…");
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
        if (!data.answer) throw new Error("Couldn't find a clear moment for that — try rephrasing?");
        return;
      }

      setStage("Cutting your highlight reel…");
      const { buffer } = await stitchClips(data.clips, 400);
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
    <div className={`card ${busy ? "pulsing" : ""}`}>
      <div className="row">
        <input
          type="text"
          placeholder="What are you looking for? e.g. “What did we decide about pricing?”"
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
            <div className="muted">{clips.length} continuous segment(s)</div>
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

          {/* Lego-block timeline: each block is labelled with its source +
              timestamp, and the playhead tracks the audio. Click to seek. */}
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
                title={`${cleanSourceName(c.file_path)} | ${fmtTime(c.start_time_ms / 1000)} - ${fmtTime(
                  c.end_time_ms / 1000
                )}${(c.parts ?? 1) > 1 ? ` · fused ${c.parts}` : ""}`}
              >
                <span className="block-label">
                  {(c.parts ?? 1) > 1 && <span className="block-fused">🔗{c.parts}</span>}
                  {cleanSourceName(c.file_path)} | {fmtTime(c.start_time_ms / 1000)} -{" "}
                  {fmtTime(c.end_time_ms / 1000)}
                </span>
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
          <Equalizer analyser={analyser} state={eqState} />
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
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
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
            Inspect sources ({hits.length})
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
