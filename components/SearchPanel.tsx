"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { stitchClips, audioBufferToWav } from "@/lib/stitch";
import type { Hit, Clip, LibraryFile } from "@/lib/types";

// Must match the capsule accents in CapsuleStack, keyed by the file's position
// in the library — so a card's accent stripe is a legend back to its source.
const ACCENTS = ["#ec4899", "#06b6d4", "#eab308"];
const FALLBACK_COLOR = "#9ca3af";

// Number of bars in each card's playback visualizer.
const VIZ_BARS = 32;

// Turn an ugly indexed path ("…/The%20Attention_Equation%20v3.mp3") into a clean,
// human title ("The Attention Equation v3").
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

// Reduce a source to its first meaningful segment for display. Raw indexed names
// often carry trailing junk ("My Talk - Audio Overview - 2026-01-15T09:22Z - a3f9…").
// Split on " - " separators, keep the first chunk, and scrub any stray ISO/UTC
// date or long hex hash that survived, so the card shows just the real title.
function formatSourceLabel(path?: string): string {
  const name = cleanSourceName(path); // decoded, extension-stripped, _ → space
  const first = name.split(/\s+-\s+/)[0]?.trim() || name;
  const scrubbed = first
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?z?)?\b/gi, "")
    .replace(/\b[0-9a-f]{8,}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return scrubbed || first || name;
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// Derived, render-ready data for one result card.
interface CardData {
  key: string;
  clip: Clip;
  text: string;
  score: number | null;
  source: string;
  color: string;
}

// The per-card frequency visualizer + sweeping playhead. Only the active card
// mounts this, and only it runs a requestAnimationFrame loop — so the 60fps
// progress updates stay isolated to the one playing card. The bars are CSS-
// animated (a simulated frequency wall); the playhead reflects real progress
// through the chunk's [start, end] window.
function CardVisualizer({
  audioRef,
  isPlaying,
  startSec,
  endSec,
}: {
  audioRef: React.RefObject<HTMLAudioElement>;
  isPlaying: boolean;
  startSec: number;
  endSec: number;
}) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const span = Math.max(0.001, endSec - startSec);
    const read = () => {
      const el = audioRef.current;
      if (!el) return;
      setProgress(Math.min(1, Math.max(0, (el.currentTime - startSec) / span)));
    };
    read();
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      read();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioRef, isPlaying, startSec, endSec]);

  return (
    <div className={`viz${isPlaying ? " playing" : ""}`} aria-hidden>
      {Array.from({ length: VIZ_BARS }).map((_, i) => (
        <div
          key={i}
          className="viz-bar"
          style={{
            animationDelay: `${(i % 8) * 0.07}s`,
            animationDuration: `${0.5 + (i % 5) * 0.11}s`,
          }}
        />
      ))}
      <div className="viz-playhead" style={{ left: `${progress * 100}%` }} />
    </div>
  );
}

// A self-contained, skimmable audio quote. Header (source + timestamp + score),
// the exact RAG text, an inline visualizer while playing, and its own Play /
// Download / Pin controls. Not memoized: the list is small and the only 60fps
// work lives inside CardVisualizer, so the card body stays cheap to re-render.
function AudioResultCard({
  data,
  index,
  focused,
  active,
  isPlaying,
  pinned,
  audioRef,
  registerRef,
  onFocus,
  onTogglePlay,
  onDownload,
  onTogglePin,
}: {
  data: CardData;
  index: number;
  focused: boolean;
  active: boolean;
  isPlaying: boolean;
  pinned: boolean;
  audioRef: React.RefObject<HTMLAudioElement>;
  registerRef: (index: number, el: HTMLDivElement | null) => void;
  onFocus: (index: number) => void;
  onTogglePlay: (index: number) => void;
  onDownload: (index: number) => void;
  onTogglePin: (index: number) => void;
}) {
  const startSec = data.clip.start_time_ms / 1000;
  const endSec = data.clip.end_time_ms / 1000;

  return (
    <motion.div
      ref={(el) => registerRef(index, el)}
      className={`rcard${focused ? " focused" : ""}${pinned ? " pinned" : ""}`}
      onMouseDown={() => onFocus(index)}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 26, delay: index * 0.04 }}
    >
      <span className="rcard-accent" style={{ background: data.color }} />

      <div className="rcard-head">
        <span className="rcard-source">{data.source}</span>
        <span className="rcard-time">
          {fmtTime(startSec)} – {fmtTime(endSec)}
        </span>
        {data.score != null && <span className="rcard-score">{data.score}% match</span>}
        <button
          type="button"
          className={`rcard-pin${pinned ? " on" : ""}`}
          onClick={() => onTogglePin(index)}
          aria-pressed={pinned}
        >
          {pinned ? "★ Saved" : "☆ Pin"}
        </button>
      </div>

      <p className="rcard-text">{data.text || "(no transcript text for this moment)"}</p>

      {active && (
        <CardVisualizer
          audioRef={audioRef}
          isPlaying={isPlaying}
          startSec={startSec}
          endSec={endSec}
        />
      )}

      <div className="rcard-actions">
        <button type="button" className="rcard-btn play" onClick={() => onTogglePlay(index)}>
          {active && isPlaying ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button type="button" className="rcard-btn dl" onClick={() => onDownload(index)}>
          ↓ Download Chunk
        </button>
      </div>
    </motion.div>
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
  const [answer, setAnswer] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  // Playback: a single hidden <audio> plays one chunk at a time, seeking into the
  // source file and auto-pausing at the chunk's end. No global stitched reel.
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Keyboard-first navigation.
  const [focusedIndex, setFocusedIndex] = useState(-1);

  // The Extraction Tray: staged quotes for batch markdown export.
  const [pins, setPins] = useState<CardData[]>([]);
  const [copied, setCopied] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const activeRangeRef = useRef<{ start: number; end: number } | null>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Latest cards, so stable callbacks (togglePin/keyboard) read current data.
  const cardsRef = useRef<CardData[]>([]);

  const readyCount = useMemo(() => library.filter((f) => f.status === "ready").length, [library]);

  // Map a clip's source (its blob URL == library blob_url) to that file's accent.
  const colorFor = useMemo(() => {
    const byUrl = new Map<string, string>();
    library.forEach((f, i) => byUrl.set(f.blob_url, ACCENTS[i % ACCENTS.length]));
    return (filePath: string) => byUrl.get(filePath) ?? FALLBACK_COLOR;
  }, [library]);

  // Build the render-ready cards: one per extracted clip, with the exact RAG text
  // resolved from whichever retrieved hit overlaps it most (same source file).
  const cards = useMemo<CardData[]>(() => {
    const overlap = (a1: number, a2: number, b1: number, b2: number) =>
      Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
    return clips.map((clip, i) => {
      let best: Hit | null = null;
      let bestOv = -1;
      for (const h of hits) {
        if (h.file_path !== clip.file_path) continue;
        const ov = overlap(clip.start_time_ms, clip.end_time_ms, h.start_time_ms, h.end_time_ms);
        if (ov > bestOv) {
          bestOv = ov;
          best = h;
        }
      }
      return {
        key: `${clip.file_path}-${clip.start_time_ms}-${i}`,
        clip,
        text: best ? best.child_text || best.parent_text || "" : "",
        score: best ? Math.round((best._score ?? 0) * 100) : null,
        source: formatSourceLabel(clip.file_path),
        color: colorFor(clip.file_path),
      };
    });
  }, [clips, hits, colorFor]);

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

  const registerRef = useCallback((index: number, el: HTMLDivElement | null) => {
    cardRefs.current[index] = el;
  }, []);

  // Wire the shared <audio>: reflect play/pause state and auto-pause each chunk
  // at its end boundary so a card only ever plays its own moment.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => {
      const r = activeRangeRef.current;
      if (r && el.currentTime >= r.end) el.pause();
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
    };
  }, []);

  // Play (or pause) just one card's chunk: seek into its source file and let the
  // auto-pause watcher stop it at the chunk's end.
  const togglePlay = useCallback(
    (index: number) => {
      const el = audioRef.current;
      const card = cards[index];
      if (!el || !card) return;
      const startSec = card.clip.start_time_ms / 1000;
      const endSec = card.clip.end_time_ms / 1000;

      if (playingIndex === index && !el.paused) {
        el.pause();
        return;
      }

      activeRangeRef.current = { start: startSec, end: endSec };
      setPlayingIndex(index);

      const begin = () => {
        try {
          el.currentTime = startSec;
        } catch {
          // ignore: will start from 0 if seeking isn't ready yet
        }
        el.play().catch(() => {});
      };

      if (el.getAttribute("data-src") !== card.clip.file_path) {
        el.src = card.clip.file_path;
        el.setAttribute("data-src", card.clip.file_path);
        el.addEventListener("loadedmetadata", begin, { once: true });
        el.load();
      } else {
        begin();
      }
    },
    [cards, playingIndex]
  );

  // Slice a single chunk out and trigger a local WAV download (no inter-clip gap).
  const downloadChunk = useCallback(
    async (index: number) => {
      const card = cards[index];
      if (!card) return;
      try {
        const { buffer } = await stitchClips([card.clip], 0);
        const wav = audioBufferToWav(buffer);
        const url = URL.createObjectURL(wav);
        const a = document.createElement("a");
        a.href = url;
        a.download = `chunk_${index + 1}_${Math.round(card.clip.start_time_ms / 1000)}s.wav`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [cards]
  );

  const togglePin = useCallback((index: number) => {
    setPins((prev) => {
      const card = cardsRef.current[index];
      if (!card) return prev;
      return prev.some((p) => p.key === card.key)
        ? prev.filter((p) => p.key !== card.key)
        : [...prev, card];
    });
  }, []);

  // Keep cardsRef in sync so the stable callbacks above read the latest cards.
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  // Focus the first card whenever a new result set lands; clear when empty.
  useEffect(() => {
    setFocusedIndex(cards.length ? 0 : -1);
  }, [cards.length]);

  // Smoothly center the focused card in the viewport.
  useEffect(() => {
    if (focusedIndex < 0) return;
    cardRefs.current[focusedIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedIndex]);

  // Keyboard-first navigation: J/K + arrows move focus, Space plays the focused
  // card, D downloads it, P pins it. Ignored while typing in the search box.
  useEffect(() => {
    if (!cards.length) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(cards.length - 1, (i < 0 ? -1 : i) + 1));
      } else if (k === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(0, (i < 0 ? 1 : i) - 1));
      } else if (e.key === " ") {
        e.preventDefault();
        setFocusedIndex((i) => {
          const idx = i < 0 ? 0 : i;
          togglePlay(idx);
          return idx;
        });
      } else if (k === "d") {
        e.preventDefault();
        setFocusedIndex((i) => {
          const idx = i < 0 ? 0 : i;
          downloadChunk(idx);
          return idx;
        });
      } else if (k === "p") {
        e.preventDefault();
        setFocusedIndex((i) => {
          const idx = i < 0 ? 0 : i;
          togglePin(idx);
          return idx;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards.length, togglePlay, downloadChunk, togglePin]);

  // Copy every pinned quote to the clipboard as clean Markdown.
  const exportPins = useCallback(async () => {
    if (!pins.length) return;
    const md = pins
      .map(
        (p) =>
          `- **${p.source}** (${fmtTime(p.clip.start_time_ms / 1000)}–${fmtTime(
            p.clip.end_time_ms / 1000
          )}): ${p.text}`
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't access the clipboard — copy is blocked in this context.");
    }
  }, [pins]);

  async function run(override?: string) {
    const q = (override ?? query).trim();
    if (!q || busy) return;
    if (readyCount === 0) {
      setError("Add some audio above first, then search.");
      return;
    }
    if (selected.length === 0) {
      setError("Select at least one source above to search.");
      return;
    }

    // Stop any in-flight playback and clear the previous result set.
    audioRef.current?.pause();
    setPlayingIndex(null);
    setBusy(true);
    setError("");
    setHits([]);
    setClips([]);
    setAnswer("");
    setShowRaw(false);
    setPins([]);
    setFocusedIndex(-1);

    try {
      setStage("Searching your audio…");
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, fileIds: selected }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Search failed");

      setHits(data.hits ?? []);
      setClips(data.clips ?? []);
      setAnswer(data.answer ?? "");
      setStage("");
      if (data.note) throw new Error(data.note);

      if (!data.clips?.length && !data.answer) {
        throw new Error("Couldn't find a clear moment for that — try rephrasing?");
      }
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
          placeholder="Query the transcript (e.g., “What was the pricing decision?”)"
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
              onClick={() => {
                setQuery(q);
                run(q);
              }}
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

      {cards.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="muted">
            Extracted {cards.length} quote{cards.length === 1 ? "" : "s"}
          </div>
          <div className="results-hint">
            <kbd>J</kbd> / <kbd>K</kbd> navigate · <kbd>Space</kbd> play · <kbd>D</kbd> download ·{" "}
            <kbd>P</kbd> pin
          </div>

          {/* Vertical feed of atomic, independently-actionable result cards. */}
          <div className="results">
            {cards.map((c, i) => (
              <AudioResultCard
                key={c.key}
                data={c}
                index={i}
                focused={i === focusedIndex}
                active={i === playingIndex}
                isPlaying={i === playingIndex && isPlaying}
                pinned={pins.some((p) => p.key === c.key)}
                audioRef={audioRef}
                registerRef={registerRef}
                onFocus={setFocusedIndex}
                onTogglePlay={togglePlay}
                onDownload={downloadChunk}
                onTogglePin={togglePin}
              />
            ))}
          </div>
        </div>
      )}

      {/* One hidden <audio>, driven imperatively to play a single chunk at a time. */}
      <audio ref={audioRef} style={{ display: "none" }} />

      {cards.length > 0 && hits.length > 0 && (
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
                        <span className="hit-name">{formatSourceLabel(h.file_path)}</span>
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

      {/* The Extraction Tray: slides up once at least one quote is pinned. */}
      <AnimatePresence>
        {pins.length > 0 && (
          <motion.div
            className="tray"
            initial={{ y: 140 }}
            animate={{ y: 0 }}
            exit={{ y: 140 }}
            transition={{ type: "spring", stiffness: 320, damping: 30 }}
          >
            <div className="tray-inner">
              <span className="tray-count">
                {pins.length} Insight{pins.length === 1 ? "" : "s"} Staged
              </span>
              <div className="tray-actions">
                <button type="button" className="tray-clear" onClick={() => setPins([])}>
                  Clear
                </button>
                <button type="button" className="tray-export" onClick={exportPins}>
                  {copied ? "✓ Copied" : "⬇ Export"}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
