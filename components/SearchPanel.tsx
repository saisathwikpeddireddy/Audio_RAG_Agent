"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { stitchClips, audioBufferToWav } from "@/lib/stitch";
import { sessionHeaders } from "@/lib/session";
import type { Hit, Clip, LibraryFile } from "@/lib/types";

// Must match the capsule accents in CapsuleStack, keyed by the file's position
// in the library — so a card's accent stripe is a legend back to its source.
const ACCENTS = ["#ec4899", "#06b6d4", "#eab308"];
const FALLBACK_COLOR = "#9ca3af";

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// One card maps strictly 1:1 to a single hit (one complete sentence).
interface CardData {
  key: string;
  filePath: string;
  startMs: number;
  endMs: number;
  text: string;
  score: number;
  color: string;
}

// Track playback progress (0..1) through a chunk's [start, end] window. Only the
// active card mounts a consumer, and it only runs rAF while playing, so the 60fps
// updates stay isolated to the one card being heard.
function useChunkProgress(
  audioRef: React.RefObject<HTMLAudioElement>,
  isPlaying: boolean,
  startSec: number,
  endSec: number
): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const span = Math.max(0.001, endSec - startSec);
    const read = () => {
      const el = audioRef.current;
      if (el) setProgress(Math.min(1, Math.max(0, (el.currentTime - startSec) / span)));
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
  return progress;
}

// Karaoke: as the sentence plays, words light up left-to-right (solid yellow,
// black text), driven by (currentTime - chunk_start) / duration.
function KaraokeText({
  audioRef,
  isPlaying,
  startSec,
  endSec,
  text,
}: {
  audioRef: React.RefObject<HTMLAudioElement>;
  isPlaying: boolean;
  startSec: number;
  endSec: number;
  text: string;
}) {
  const progress = useChunkProgress(audioRef, isPlaying, startSec, endSec);
  const tokens = useMemo(() => text.split(/(\s+)/), [text]); // keep whitespace tokens
  const realCount = useMemo(() => tokens.filter((t) => t.trim()).length, [tokens]);
  const filled = Math.round(progress * realCount);

  let spoken = 0;
  return (
    <p className="rcard-text karaoke">
      {tokens.map((tok, i) => {
        if (!tok.trim()) return <span key={i}>{tok}</span>;
        const idx = spoken++;
        return (
          <span key={i} className={`kw${idx < filled ? " on" : ""}`}>
            {tok}
          </span>
        );
      })}
    </p>
  );
}

// Tactile "now playing" indicator: bars dance while this card's audio plays, and
// rest flat when paused. Pure CSS keyframes; animation only runs when .playing.
function Waveform({ playing }: { playing: boolean }) {
  return (
    <span className={`waveform${playing ? " playing" : ""}`} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="wf-bar" />
      ))}
    </span>
  );
}

// A minimal, self-contained audio sentence. Header is just the timestamp + match
// score (no repetitive title). Karaoke text while playing, plain otherwise. One
// Play control (with waveform) and one static Download Audio button.
function AudioResultCard({
  data,
  index,
  focused,
  active,
  isPlaying,
  audioRef,
  registerRef,
  onFocus,
  onTogglePlay,
  onDownload,
}: {
  data: CardData;
  index: number;
  focused: boolean;
  active: boolean;
  isPlaying: boolean;
  audioRef: React.RefObject<HTMLAudioElement>;
  registerRef: (index: number, el: HTMLDivElement | null) => void;
  onFocus: (index: number) => void;
  onTogglePlay: (index: number) => void;
  onDownload: (index: number) => void;
}) {
  const startSec = data.startMs / 1000;
  const endSec = data.endMs / 1000;
  const playing = active && isPlaying;

  return (
    <motion.div
      ref={(el) => registerRef(index, el)}
      className={`rcard${focused ? " focused" : ""}`}
      onMouseDown={() => onFocus(index)}
      initial={{ opacity: 0, y: 14, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ type: "spring", stiffness: 320, damping: 30, delay: index * 0.05 }}
    >
      <span className="rcard-accent" style={{ background: data.color }} />

      <div className="rcard-head">
        <span className="rcard-time">
          {fmtTime(startSec)} – {fmtTime(endSec)}
        </span>
        <span className="rcard-score">{data.score}%</span>
      </div>

      {active ? (
        <KaraokeText
          audioRef={audioRef}
          isPlaying={isPlaying}
          startSec={startSec}
          endSec={endSec}
          text={data.text}
        />
      ) : (
        <p className="rcard-text">{data.text}</p>
      )}

      <div className="rcard-actions">
        <button type="button" className="rcard-btn play" onClick={() => onTogglePlay(index)}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <Waveform playing={playing} />
        <button type="button" className="rcard-btn dl" onClick={() => onDownload(index)}>
          ↓ Download Audio
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
  const [answer, setAnswer] = useState("");

  // Playback: a single hidden <audio> plays one sentence at a time, seeking into
  // the source file and auto-pausing at the chunk's end.
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Keyboard-first navigation.
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const audioRef = useRef<HTMLAudioElement>(null);
  const activeRangeRef = useRef<{ start: number; end: number } | null>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Latest cards, so stable callbacks (keyboard) read current data.
  const cardsRef = useRef<CardData[]>([]);

  const readyCount = useMemo(() => library.filter((f) => f.status === "ready").length, [library]);

  // Map a clip's source (its blob URL == library blob_url) to that file's accent.
  const colorFor = useMemo(() => {
    const byUrl = new Map<string, string>();
    library.forEach((f, i) => byUrl.set(f.blob_url, ACCENTS[i % ACCENTS.length]));
    return (filePath: string) => byUrl.get(filePath) ?? FALLBACK_COLOR;
  }, [library]);

  // STRICTLY 1:1 — one hit, one card. No grouping, dedup, or rollups.
  const cards = useMemo<CardData[]>(
    () =>
      hits.map((h) => ({
        key: h._id,
        filePath: h.file_path,
        startMs: h.start_time_ms,
        endMs: h.end_time_ms,
        text: h.child_text || "",
        score: Math.round((h._score ?? 0) * 100),
        color: colorFor(h.file_path),
      })),
    [hits, colorFor]
  );

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
  // at its end boundary so a card only ever plays its own sentence.
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

  // Play (or pause) one card's sentence: seek into its source file at chunk start
  // and let the auto-pause watcher stop it at chunk end.
  const togglePlay = useCallback(
    (index: number) => {
      const el = audioRef.current;
      const card = cardsRef.current[index];
      if (!el || !card) return;
      const startSec = card.startMs / 1000;
      const endSec = card.endMs / 1000;

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

      if (el.getAttribute("data-src") !== card.filePath) {
        el.src = card.filePath;
        el.setAttribute("data-src", card.filePath);
        el.addEventListener("loadedmetadata", begin, { once: true });
        el.load();
      } else {
        begin();
      }
    },
    [playingIndex]
  );

  // Slice the sentence out and trigger a local WAV download (no inter-clip gap).
  const downloadChunk = useCallback(async (index: number) => {
    const card = cardsRef.current[index];
    if (!card) return;
    try {
      const clip: Clip = {
        file_path: card.filePath,
        start_time_ms: card.startMs,
        end_time_ms: card.endMs,
      };
      const { buffer } = await stitchClips([clip], 0);
      const wav = audioBufferToWav(buffer);
      const url = URL.createObjectURL(wav);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audio_${index + 1}_${Math.round(card.startMs / 1000)}s.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
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
  // card, D downloads it. Ignored while typing in the search box.
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards.length, togglePlay, downloadChunk]);

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
    setAnswer("");
    setFocusedIndex(-1);

    try {
      setStage("Searching your audio…");
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders() },
        body: JSON.stringify({ query: q, fileIds: selected }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Search failed");

      setHits(data.hits ?? []);
      setAnswer(data.answer ?? "");
      setStage("");
      if (data.note) throw new Error(data.note);

      if (!data.hits?.length && !data.answer) {
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
          whileTap={{ scale: 0.96 }}
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
              initial={{ opacity: 0, scale: 0.8, filter: "blur(4px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              transition={{ type: "spring", stiffness: 320, damping: 22, delay: i * 0.04 }}
              whileHover={{ scale: 1.06, rotate: -1.5 }}
              whileTap={{ scale: 0.96 }}
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

      <AnimatePresence initial={false}>
        {answer && (
          <motion.div
            className="answer"
            initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -12, filter: "blur(4px)", transition: { duration: 0.15, ease: "easeIn" } }}
            transition={{ type: "spring", stiffness: 300, damping: 26 }}
          >
            <div className="answer-label">Answer</div>
            <p>{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {cards.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="muted">
            {cards.length} result{cards.length === 1 ? "" : "s"}
          </div>

          {/* Vertical feed of atomic, 1:1 result cards. */}
          <div className="results">
            {cards.map((c, i) => (
              <AudioResultCard
                key={c.key}
                data={c}
                index={i}
                focused={i === focusedIndex}
                active={i === playingIndex}
                isPlaying={i === playingIndex && isPlaying}
                audioRef={audioRef}
                registerRef={registerRef}
                onFocus={setFocusedIndex}
                onTogglePlay={togglePlay}
                onDownload={downloadChunk}
              />
            ))}
          </div>
        </div>
      )}

      {/* One hidden <audio>, driven imperatively to play a single sentence. */}
      <audio ref={audioRef} style={{ display: "none" }} />
    </div>
  );
}
