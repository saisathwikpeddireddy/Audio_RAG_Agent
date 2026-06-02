"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { stitchClips, audioBufferToWav } from "@/lib/stitch";
import { formatSourceName } from "@/lib/format";
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

// Small-to-Big: one card per PARENT paragraph. It plays the whole paragraph for
// context, but visually emphasizes the exact child sentence(s) that matched.
interface CardData {
  key: string; // parent_id
  filePath: string;
  startMs: number; // parent span (playback)
  endMs: number;
  parentText: string; // full paragraph rendered in the card
  childTexts: string[]; // matched sentence(s), highlighted within the paragraph
  score: number; // best matching child score
  source: string;
  color: string;
}

// Split a paragraph into segments, marking the spans that match a retrieved child
// sentence. Powers the typographical hierarchy: muted context + emphasized match.
function highlightSegments(
  parentText: string,
  childTexts: string[]
): Array<{ text: string; hit: boolean }> {
  const lower = parentText.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const ct of childTexts) {
    const needle = ct.trim().toLowerCase();
    if (!needle) continue;
    let from = 0;
    let idx: number;
    while ((idx = lower.indexOf(needle, from)) !== -1) {
      ranges.push([idx, idx + needle.length]);
      from = idx + needle.length;
    }
  }
  if (!ranges.length) return [{ text: parentText, hit: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }

  const segs: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) segs.push({ text: parentText.slice(cursor, s), hit: false });
    segs.push({ text: parentText.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < parentText.length) segs.push({ text: parentText.slice(cursor), hit: false });
  return segs;
}

// A self-contained, skimmable audio paragraph. Header (source · timestamp · %
// match), the full paragraph with the matched sentence(s) emphasized over muted
// context, and its own Play / Download / Pin controls.
function AudioResultCard({
  data,
  index,
  focused,
  active,
  isPlaying,
  pinned,
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
  registerRef: (index: number, el: HTMLDivElement | null) => void;
  onFocus: (index: number) => void;
  onTogglePlay: (index: number) => void;
  onDownload: (index: number) => void;
  onTogglePin: (index: number) => void;
}) {
  const startSec = data.startMs / 1000;
  const endSec = data.endMs / 1000;
  const segments = useMemo(
    () => highlightSegments(data.parentText, data.childTexts),
    [data.parentText, data.childTexts]
  );

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
        <span className="rcard-source" title={data.source}>
          {data.source}
        </span>
        <span className="rcard-time">
          {fmtTime(startSec)} – {fmtTime(endSec)}
        </span>
        <span className="rcard-score">{data.score}%</span>
        <button
          type="button"
          className={`rcard-pin${pinned ? " on" : ""}`}
          onClick={() => onTogglePin(index)}
          aria-pressed={pinned}
        >
          {pinned ? "★ Saved" : "☆ Pin"}
        </button>
      </div>

      <p className="rcard-text">
        {segments.map((seg, i) => (
          <span key={i} className={seg.hit ? "ctx-hit" : "ctx-muted"}>
            {seg.text}
          </span>
        ))}
      </p>

      <div className="rcard-actions">
        <button type="button" className="rcard-btn play" onClick={() => onTogglePlay(index)}>
          {active && isPlaying ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button type="button" className="rcard-btn dl" onClick={() => onDownload(index)}>
          ↓ Download Paragraph
        </button>
      </div>
    </motion.div>
  );
}

// The keyboard legend, shown only while the Extraction Tray is up (no static
// clutter in the main flow).
function ShortcutLegend() {
  return (
    <span className="tray-legend">
      <kbd>J</kbd>/<kbd>K</kbd> nav · <kbd>Space</kbd> play · <kbd>D</kbd> download · <kbd>P</kbd> pin
    </span>
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

  // Playback: a single hidden <audio> plays one chunk at a time, seeking into the
  // source file and auto-pausing at the hit's end. No global stitched reel.
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

  // Cards map STRICTLY 1:1 from hits — no overlap math, no dedup, no rollups. The
  // Small-to-Big rollup: group the precise sentence hits by their parent
  // paragraph, so each card is one paragraph. We keep every matched sentence
  // (to highlight) and the best score, in first-seen (score) order.
  const cards = useMemo<CardData[]>(() => {
    const byParent = new Map<string, CardData>();
    for (const h of hits) {
      const key = h.parent_id || h._id;
      const existing = byParent.get(key);
      if (existing) {
        if (h.child_text) existing.childTexts.push(h.child_text);
        existing.score = Math.max(existing.score, Math.round((h._score ?? 0) * 100));
      } else {
        byParent.set(key, {
          key,
          filePath: h.file_path,
          startMs: h.parent_start_ms,
          endMs: h.parent_end_ms,
          parentText: h.parent_text || h.child_text || "",
          childTexts: h.child_text ? [h.child_text] : [],
          score: Math.round((h._score ?? 0) * 100),
          source: h.title || formatSourceName(h.file_path),
          color: colorFor(h.file_path),
        });
      }
    }
    return [...byParent.values()];
  }, [hits, colorFor]);

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

  // Play (or pause) just one card's chunk: seek into its source file at hit.start
  // and let the auto-pause watcher stop it at hit.end.
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

  // Slice a single chunk out and trigger a local WAV download (no inter-clip gap).
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
      a.download = `paragraph_${index + 1}_${Math.round(card.startMs / 1000)}s.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

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
          `- **${p.source}** (${fmtTime(p.startMs / 1000)}–${fmtTime(p.endMs / 1000)}): ${p.parentText}`
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
    setAnswer("");
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
            {cards.length} result{cards.length === 1 ? "" : "s"}
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

      {/* The Extraction Tray: slides up once at least one quote is pinned. Also
          hosts the keyboard legend, so shortcuts surface only when relevant. */}
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
              <ShortcutLegend />
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
