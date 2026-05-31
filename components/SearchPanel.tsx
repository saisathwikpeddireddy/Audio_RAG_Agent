"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { stitchClips, audioBufferToWav } from "@/lib/stitch";
import type { Hit, Clip, LibraryFile } from "@/lib/types";

// Must match the capsule accents in CapsuleStack, keyed by the file's position
// in the library — so a block's color is a legend back to its source capsule.
const ACCENTS = ["#ec4899", "#06b6d4", "#eab308"];
const FALLBACK_COLOR = "#9ca3af";

// Hard silence (ms) injected between clips. Must match the value passed to
// stitchClips so the teleprompter's clip windows line up with the rendered audio.
const GAP_MS = 400;

// Below this rendered width (px) a timeline block hides its timestamp and shows
// only the file legend key, so text never overflows a narrow block's borders.
const FULL_LABEL_MIN_WIDTH = 80;

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

// A single lego-block on the timeline. Measures its own rendered width so the
// label can degrade gracefully ([1] 0:27 - 0:46 → [1]), and exposes a hover
// card with the full timestamp, a transcript preview, and a per-clip download.
function TimelineBlock({
  number,
  color,
  startSec,
  endSec,
  sourceName,
  transcript,
  growth,
  delay,
  onDownload,
}: {
  number: number;
  color: string;
  startSec: number;
  endSec: number;
  sourceName: string;
  transcript: string;
  growth: number;
  delay: number;
  onDownload: () => void;
}) {
  const blockRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    const el = blockRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const showFull = width >= FULL_LABEL_MIN_WIDTH;
  const fullTime = `${fmtTime(startSec)} - ${fmtTime(endSec)}`;
  const preview =
    transcript.length > 160 ? `${transcript.slice(0, 160).trimEnd()}…` : transcript;

  return (
    <div
      className="block-wrap"
      style={{ flexGrow: growth, flexBasis: 0 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <motion.div
        ref={blockRef}
        className="block"
        style={{ background: color }}
        initial={{ scale: 0.4, y: -16, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 14, delay }}
        title={`[${number}] ${sourceName} | ${fullTime}`}
      >
        <span className="block-label">{showFull ? `[${number}] ${fullTime}` : `[${number}]`}</span>
      </motion.div>

      <AnimatePresence>
        {hover && (
          <motion.div
            className="hovercard"
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 420, damping: 28 }}
          >
            <div className="hovercard-time">
              File {number} | {fullTime}
            </div>
            {preview && <div className="hovercard-text">{preview}</div>}
            <button
              type="button"
              className="hovercard-dl"
              onClick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
            >
              ↓ Download Clip
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
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
  const [activeClip, setActiveClip] = useState(-1);

  const audioRef = useRef<HTMLAudioElement>(null);

  const readyCount = useMemo(() => library.filter((f) => f.status === "ready").length, [library]);

  // Map a clip's source (its blob URL == library blob_url) to that file's capsule
  // accent, so the timeline doubles as a color legend for the active sources.
  const colorFor = useMemo(() => {
    const byUrl = new Map<string, string>();
    library.forEach((f, i) => byUrl.set(f.blob_url, ACCENTS[i % ACCENTS.length]));
    return (filePath: string) => byUrl.get(filePath) ?? FALLBACK_COLOR;
  }, [library]);

  // 1-based file number (the capsule legend key) keyed by source blob URL.
  const numberFor = useMemo(() => {
    const byUrl = new Map<string, number>();
    library.forEach((f, i) => byUrl.set(f.blob_url, i + 1));
    return (filePath: string) => byUrl.get(filePath) ?? 0;
  }, [library]);

  // Resolve each clip's transcript by finding the retrieved hit (same source)
  // whose time range overlaps it the most. Powers the hover preview + teleprompter.
  const transcriptFor = useMemo(() => {
    const overlap = (a1: number, a2: number, b1: number, b2: number) =>
      Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
    return (clip: Clip) => {
      let best: Hit | null = null;
      let bestOv = 0;
      for (const h of hits) {
        if (h.file_path !== clip.file_path) continue;
        const ov = overlap(clip.start_time_ms, clip.end_time_ms, h.start_time_ms, h.end_time_ms);
        if (ov > bestOv) {
          bestOv = ov;
          best = h;
        }
      }
      return best ? best.child_text || best.parent_text || "" : "";
    };
  }, [hits]);

  // Where each clip sits on the stitched output timeline (seconds), accounting
  // for the hard silence gaps baked between clips. Used to map playback time → clip.
  const clipWindows = useMemo(() => {
    const gap = GAP_MS / 1000;
    let cursor = 0;
    return clips.map((c) => {
      const dur = Math.max(0, (c.end_time_ms - c.start_time_ms) / 1000);
      const start = cursor;
      cursor += dur + gap;
      return { start, end: start + dur };
    });
  }, [clips]);

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

  // Drive the playhead + teleprompter from a rAF loop while playing: read the
  // hidden <audio>'s currentTime and resolve which clip window we're inside.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) {
        const t = el.currentTime;
        setCurTime(t);
        if (el.duration) setProgress(t / el.duration);
        let idx = clipWindows.length ? 0 : -1;
        for (let i = 0; i < clipWindows.length; i++) {
          if (t >= clipWindows[i].start) idx = i;
          else break;
        }
        setActiveClip(idx);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clipWindows]);

  // Custom transport: drive the hidden <audio> directly so the native chrome
  // never appears (it broke the brutalist look).
  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }

  // Slice a single clip out and trigger a local WAV download — same pipeline as
  // the master reel, isolated to this clip's start/end (no inter-clip gap).
  async function downloadClip(clip: Clip, number: number) {
    try {
      const { buffer } = await stitchClips([clip], 0);
      const wav = audioBufferToWav(buffer);
      const url = URL.createObjectURL(wav);
      const a = document.createElement("a");
      a.href = url;
      a.download = `clip_${number}_${Math.round(clip.start_time_ms / 1000)}s.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
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
    setActiveClip(-1);
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
      const { buffer } = await stitchClips(data.clips, GAP_MS);
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
          <div className="muted">{clips.length} clip(s)</div>

          {/* Lego-block timeline: each block's color maps to its source file's
              capsule (a legend) and shows its timestamp (or just [N] when too
              narrow). Hover for a card with a transcript preview + download.
              Click anywhere to seek. */}
          <div
            className={`timeline ${audioUrl ? "seekable" : ""}`}
            onClick={audioUrl ? seekFromTimeline : undefined}
          >
            {clips.map((c, i) => (
              <TimelineBlock
                key={`${c.file_path}-${c.start_time_ms}-${i}`}
                number={numberFor(c.file_path)}
                color={colorFor(c.file_path)}
                startSec={c.start_time_ms / 1000}
                endSec={c.end_time_ms / 1000}
                sourceName={cleanSourceName(c.file_path)}
                transcript={transcriptFor(c)}
                growth={Math.max(1, c.end_time_ms - c.start_time_ms)}
                delay={i * 0.07}
                onDownload={() => downloadClip(c, numberFor(c.file_path))}
              />
            ))}
            {audioUrl && (
              <div className="playhead" style={{ left: `${Math.min(1, progress) * 100}%` }} />
            )}
          </div>

          {/* Teleprompter: snaps to the transcript of the clip currently playing
              so you can read along; idle until playback starts. */}
          <div className="teleprompter">
            {playing && activeClip >= 0 && activeClip < clips.length
              ? transcriptFor(clips[activeClip]) || "…"
              : "Hit play to read along…"}
          </div>
        </div>
      )}

      {/* Custom brutalist transport replaces the native player. The <audio> is
          kept permanently mounted but visually hidden, driven directly via the
          ref so the native chrome never shows. */}
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
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
          setCurTime(0);
          setActiveClip(-1);
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
