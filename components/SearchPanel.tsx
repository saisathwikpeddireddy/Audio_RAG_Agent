"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type ClipWindow = { start: number; end: number };

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

// Subscribe to the hidden <audio>'s current time. Uses requestAnimationFrame
// while playing for smoothness, and discrete media events (seek/load) when paused
// so the playhead still tracks scrubbing. This lives ONLY inside leaf components,
// so the 60fps updates never re-render the parent workspace or the memoized blocks.
function usePlaybackTime(
  audioRef: React.RefObject<HTMLAudioElement>,
  playing: boolean
): number {
  const [time, setTime] = useState(0);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const sync = () => setTime(el.currentTime);
    const reset = () => setTime(0);
    el.addEventListener("seeked", sync);
    el.addEventListener("loadedmetadata", sync);
    el.addEventListener("ended", reset);
    return () => {
      el.removeEventListener("seeked", sync);
      el.removeEventListener("loadedmetadata", sync);
      el.removeEventListener("ended", reset);
    };
  }, [audioRef]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) setTime(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, audioRef]);

  return time;
}

function audioDuration(audioRef: React.RefObject<HTMLAudioElement>): number {
  const d = audioRef.current?.duration;
  return d && Number.isFinite(d) ? d : 0;
}

// The moving playhead. Isolated leaf so its per-frame position updates don't
// touch the timeline blocks.
const Playhead = memo(function Playhead({
  audioRef,
  playing,
}: {
  audioRef: React.RefObject<HTMLAudioElement>;
  playing: boolean;
}) {
  const time = usePlaybackTime(audioRef, playing);
  const dur = audioDuration(audioRef);
  const frac = dur ? Math.min(1, time / dur) : 0;
  return <div className="playhead" style={{ left: `${frac * 100}%` }} />;
});

// The MM:SS / MM:SS readout. Isolated so its updates don't re-render the panel.
const TransportClock = memo(function TransportClock({
  audioRef,
  playing,
}: {
  audioRef: React.RefObject<HTMLAudioElement>;
  playing: boolean;
}) {
  const time = usePlaybackTime(audioRef, playing);
  return (
    <span className="transport-time">
      {fmtTime(time)} / {fmtTime(audioDuration(audioRef))}
    </span>
  );
});

// The teleprompter snaps to the transcript of the clip currently playing. Owns
// its own high-frequency time state so the rest of the tree stays still. It keys
// off currentTime (not the play/pause flag) so it keeps showing the active line
// while paused — users pause specifically to read.
const Teleprompter = memo(function Teleprompter({
  audioRef,
  playing,
  clips,
  clipWindows,
  transcriptFor,
}: {
  audioRef: React.RefObject<HTMLAudioElement>;
  playing: boolean;
  clips: Clip[];
  clipWindows: ClipWindow[];
  transcriptFor: (clip: Clip) => string;
}) {
  const time = usePlaybackTime(audioRef, playing);

  // Find the clip whose reel-window [startInReel, endInReel) contains the current
  // playback time. While inside the 400ms silent gap after a clip, retain that
  // clip's line so the text doesn't flicker to the placeholder between segments.
  let idx = -1;
  for (let i = 0; i < clipWindows.length; i++) {
    const w = clipWindows[i];
    if (time >= w.start && time < w.end) {
      idx = i;
      break;
    }
    if (time >= w.start) idx = i; // in the gap just after clip i → keep showing it
  }

  // Placeholder ONLY at the very start (currentTime === 0) or after the reel has
  // fully ended (usePlaybackTime resets time to 0 on "ended"). A pause mid-reel
  // leaves time > 0, so the active transcript stays on screen.
  const text =
    time > 0 && idx >= 0 && idx < clips.length
      ? transcriptFor(clips[idx]) || "…"
      : "Hit play to read along…";

  return <div className="teleprompter">{text}</div>;
});

// A single lego-block on the timeline. Memoized so the 60fps playback leaves it
// untouched. Measures its own rendered width so the label degrades gracefully
// ([1] 0:27 - 0:46 → [1]), and exposes a hover card with the full timestamp, a
// transcript preview, and a per-clip download.
const TimelineBlock = memo(function TimelineBlock({
  clip,
  index,
  number,
  color,
  sourceName,
  transcript,
  onDownloadClip,
}: {
  clip: Clip;
  index: number;
  number: number;
  color: string;
  sourceName: string;
  transcript: string;
  onDownloadClip: (clip: Clip, number: number) => void;
}) {
  const blockRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState(false);
  // Small grace delay on leave so the pointer can travel from the block into the
  // card (which sits just above it) without the card vanishing mid-reach.
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = blockRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }, []);

  const openCard = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    setHover(true);
  };
  const scheduleClose = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHover(false), 140);
  };

  const startSec = clip.start_time_ms / 1000;
  const endSec = clip.end_time_ms / 1000;
  const showFull = width >= FULL_LABEL_MIN_WIDTH;
  const fullTime = `${fmtTime(startSec)} - ${fmtTime(endSec)}`;

  return (
    <div
      className="block-wrap"
      style={{ flexGrow: Math.max(1, clip.end_time_ms - clip.start_time_ms), flexBasis: 0 }}
      onMouseEnter={openCard}
      onMouseLeave={scheduleClose}
    >
      <motion.div
        ref={blockRef}
        className="block"
        style={{ background: color }}
        initial={{ scale: 0.4, y: -16, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 14, delay: index * 0.07 }}
      >
        <span className="block-label">{showFull ? `[${number}] ${fullTime}` : `[${number}]`}</span>
      </motion.div>

      <AnimatePresence>
        {hover && (
          <motion.div
            className="hovercard"
            onMouseEnter={openCard}
            onMouseLeave={scheduleClose}
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 420, damping: 28 }}
          >
            <div className="hovercard-time">
              [{number}] {fullTime}
            </div>
            {transcript && <div className="hovercard-text">{transcript}</div>}
            <button
              type="button"
              className="hovercard-dl"
              onClick={(e) => {
                e.stopPropagation();
                onDownloadClip(clip, number);
              }}
            >
              ↓ Download Chunk
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

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
  const [playing, setPlaying] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

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
  const transcriptFor = useCallback(
    (clip: Clip) => {
      const overlap = (a1: number, a2: number, b1: number, b2: number) =>
        Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
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
    },
    [hits]
  );

  // Where each clip sits on the stitched output ("reel") timeline, in seconds.
  // The master buffer lays clips back-to-back with GAP_MS of silence between
  // them, so for clip i:
  //   startInReel = Σ(durations of clips 0..i-1) + i * (GAP_MS / 1000)
  //   endInReel   = startInReel + thisClipDuration
  // The teleprompter maps <audio>.currentTime into [startInReel, endInReel).
  const clipWindows = useMemo<ClipWindow[]>(() => {
    const gap = GAP_MS / 1000;
    let prevDurations = 0;
    return clips.map((c, i) => {
      const dur = Math.max(0, (c.end_time_ms - c.start_time_ms) / 1000);
      const start = prevDurations + i * gap;
      prevDurations += dur;
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
  // Stable identity keeps the memoized TimelineBlocks from re-rendering.
  const onDownloadClip = useCallback(async (clip: Clip, number: number) => {
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
  }, []);

  // Click anywhere on the lego timeline to scrub — replaces the native bar. The
  // isolated <Playhead> picks up the new position via the audio's "seeked" event.
  function seekFromTimeline(e: React.MouseEvent<HTMLDivElement>) {
    const el = audioRef.current;
    if (!el || !audioUrl || !el.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = frac * el.duration;
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
    setPlaying(false);
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
      // Prefer the friendly, classified message from the API (e.g. rate-limit copy).
      if (!res.ok) throw new Error(data.message || data.error || "Search failed");

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
                clip={c}
                index={i}
                number={numberFor(c.file_path)}
                color={colorFor(c.file_path)}
                sourceName={cleanSourceName(c.file_path)}
                transcript={transcriptFor(c)}
                onDownloadClip={onDownloadClip}
              />
            ))}
            {audioUrl && <Playhead audioRef={audioRef} playing={playing} />}
          </div>

          {/* Teleprompter: snaps to the transcript of the clip currently playing
              so you can read along; idle until playback starts. */}
          <Teleprompter
            audioRef={audioRef}
            playing={playing}
            clips={clips}
            clipWindows={clipWindows}
            transcriptFor={transcriptFor}
          />
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
          <TransportClock audioRef={audioRef} playing={playing} />
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
        onEnded={() => setPlaying(false)}
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
