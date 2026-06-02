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

// One matched child sentence inside a paragraph, with its precise audio offsets.
interface Match {
  text: string;
  startMs: number; // child_start_ms — where click-to-seek jumps to
  endMs: number; // child_end_ms — the tight "Download Quote" boundary
}

// Small-to-Big: one card per PARENT paragraph. It plays the whole paragraph for
// context, but emphasizes the matched child sentence(s) — and each highlight is
// click-to-seek, jumping the audio to that sentence's exact start.
interface CardData {
  key: string; // parent_id
  filePath: string;
  startMs: number; // parent span (full-paragraph playback)
  endMs: number;
  parentText: string;
  matches: Match[];
  score: number;
  source: string;
  color: string;
}

interface Segment {
  text: string;
  hit: boolean;
  startMs?: number; // present on hit segments — the seek target
  endMs?: number; // present on hit segments — the tight download boundary
}

// Split a paragraph into segments, tagging the spans that match a retrieved child
// sentence with that sentence's start/end offsets. Powers the typographical
// hierarchy (muted context + emphasized match), click-to-seek, and quote download.
function highlightSegments(parentText: string, matches: Match[]): Segment[] {
  const lower = parentText.toLowerCase();
  const ranges: Array<[number, number, number, number]> = []; // [start, end, startMs, endMs]
  for (const m of matches) {
    const needle = m.text.trim().toLowerCase();
    if (!needle) continue;
    let from = 0;
    let idx: number;
    while ((idx = lower.indexOf(needle, from)) !== -1) {
      ranges.push([idx, idx + needle.length, m.startMs, m.endMs]);
      from = idx + needle.length;
    }
  }
  if (!ranges.length) return [{ text: parentText, hit: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number, number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
      last[2] = Math.min(last[2], r[2]); // earliest quote start in the merged span
      last[3] = Math.max(last[3], r[3]); // latest quote end in the merged span
    } else {
      merged.push([...r]);
    }
  }

  const segs: Segment[] = [];
  let cursor = 0;
  for (const [s, e, startMs, endMs] of merged) {
    if (s > cursor) segs.push({ text: parentText.slice(cursor, s), hit: false });
    segs.push({ text: parentText.slice(s, e), hit: true, startMs, endMs });
    cursor = e;
  }
  if (cursor < parentText.length) segs.push({ text: parentText.slice(cursor), hit: false });
  return segs;
}

// A self-contained, skimmable audio paragraph. Header (source · timestamp · %
// match), the full paragraph with matched sentence(s) emphasized over muted
// context (each highlight is click-to-seek), and Play / Copy / Download controls.
// The download morphs between the full paragraph and the precise clicked quote.
function AudioResultCard({
  data,
  index,
  focused,
  active,
  isPlaying,
  registerRef,
  onFocus,
  onTogglePlay,
  onDownload,
  onSeek,
}: {
  data: CardData;
  index: number;
  focused: boolean;
  active: boolean;
  isPlaying: boolean;
  registerRef: (index: number, el: HTMLDivElement | null) => void;
  onFocus: (index: number) => void;
  onTogglePlay: (index: number) => void;
  onDownload: (index: number, startMs: number, endMs: number, kind: "paragraph" | "quote") => void;
  onSeek: (index: number, childStartMs: number) => void;
}) {
  const startSec = data.startMs / 1000;
  const endSec = data.endMs / 1000;
  const segments = useMemo(
    () => highlightSegments(data.parentText, data.matches),
    [data.parentText, data.matches]
  );

  // Download follows focus: the whole paragraph by default, or the precise clicked
  // quote once the user interacts with a highlight.
  const [downloadContext, setDownloadContext] = useState<"parent" | "child">("parent");
  const [activeChildMatch, setActiveChildMatch] = useState<Match | null>(null);
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    // Bold the focused quote (or the top match) inside the paragraph context.
    const child = activeChildMatch ?? data.matches[0] ?? null;
    const body = child ? data.parentText.replace(child.text, `**${child.text}**`) : data.parentText;
    const range = child
      ? `${fmtTime(child.startMs / 1000)} - ${fmtTime(child.endMs / 1000)}`
      : `${fmtTime(startSec)} - ${fmtTime(endSec)}`;
    const clipboardText = `> ${body}\n\n*Source: ${data.source || "Audio"} (${range})*`;
    try {
      await navigator.clipboard.writeText(clipboardText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked in this context — silently no-op
    }
  }, [activeChildMatch, data.matches, data.parentText, data.source, startSec, endSec]);

  const isChild = downloadContext === "child" && !!activeChildMatch;

  return (
    <motion.div
      ref={(el) => registerRef(index, el)}
      className={`rcard${focused ? " focused" : ""}`}
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
      </div>

      <p className="rcard-text">
        {segments.map((seg, i) =>
          seg.hit ? (
            <button
              key={i}
              type="button"
              className="ctx-hit"
              title="Jump to this moment"
              onClick={(e) => {
                e.stopPropagation();
                // Focus the download/copy on this exact quote, then seek + play.
                setDownloadContext("child");
                setActiveChildMatch({
                  text: seg.text,
                  startMs: seg.startMs ?? data.startMs,
                  endMs: seg.endMs ?? data.endMs,
                });
                onSeek(index, seg.startMs ?? data.startMs);
              }}
            >
              {seg.text}
            </button>
          ) : (
            <span key={i} className="ctx-muted">
              {seg.text}
            </span>
          )
        )}
      </p>

      <div className="rcard-actions">
        <button
          type="button"
          className="rcard-btn play"
          onClick={() => {
            // Playing the whole paragraph resets the download back to "paragraph".
            setDownloadContext("parent");
            setActiveChildMatch(null);
            onTogglePlay(index);
          }}
        >
          {active && isPlaying ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button type="button" className="rcard-btn copy" onClick={onCopy}>
          {copied ? "✓ Copied" : "⎘ Copy"}
        </button>
        <button
          type="button"
          className="rcard-btn dl"
          onClick={() =>
            isChild && activeChildMatch
              ? onDownload(index, activeChildMatch.startMs, activeChildMatch.endMs, "quote")
              : onDownload(index, data.startMs, data.endMs, "paragraph")
          }
        >
          {isChild ? "↓ Download Quote" : "↓ Download Paragraph"}
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

  // Playback: a single hidden <audio> plays one paragraph at a time, seeking into
  // the source file and auto-pausing at the paragraph's end.
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Keyboard-first navigation.
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const audioRef = useRef<HTMLAudioElement>(null);
  const activeRangeRef = useRef<{ start: number; end: number } | null>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Latest cards, so stable callbacks (keyboard / seek) read current data.
  const cardsRef = useRef<CardData[]>([]);

  const readyCount = useMemo(() => library.filter((f) => f.status === "ready").length, [library]);

  // Map a clip's source (its blob URL == library blob_url) to that file's accent.
  const colorFor = useMemo(() => {
    const byUrl = new Map<string, string>();
    library.forEach((f, i) => byUrl.set(f.blob_url, ACCENTS[i % ACCENTS.length]));
    return (filePath: string) => byUrl.get(filePath) ?? FALLBACK_COLOR;
  }, [library]);

  // Small-to-Big rollup: reduce the precise sentence hits into a map keyed by
  // parent paragraph, so each card is ONE paragraph that can never duplicate. Key
  // by parent_id, falling back to the parent_text itself (collapses identical
  // paragraphs even for vectors indexed before the parent_id schema landed).
  const cards = useMemo<CardData[]>(() => {
    const byParent = new Map<string, CardData>();
    for (const h of hits) {
      const key = h.parent_id || h.parent_text || h._id;
      const existing = byParent.get(key);
      if (existing) {
        // Same paragraph → record the additional matched sentence + its offsets.
        if (h.child_text)
          existing.matches.push({
            text: h.child_text,
            startMs: h.child_start_ms,
            endMs: h.child_end_ms,
          });
        existing.score = Math.max(existing.score, Math.round((h._score ?? 0) * 100));
      } else {
        byParent.set(key, {
          key,
          filePath: h.file_path,
          startMs: h.parent_start_ms,
          endMs: h.parent_end_ms,
          parentText: h.parent_text || h.child_text || "",
          matches: h.child_text
            ? [{ text: h.child_text, startMs: h.child_start_ms, endMs: h.child_end_ms }]
            : [],
          score: Math.round((h._score ?? 0) * 100),
          // Always run the formatter — stored titles may predate its upgrade.
          source: formatSourceName(h.title || h.file_path),
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

  // Wire the shared <audio>: reflect play/pause state and auto-pause at the
  // current segment's end boundary.
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

  // Shared helper: point the <audio> at a card's source and start at `fromSec`,
  // auto-pausing at the paragraph's end.
  const playFrom = useCallback((index: number, fromSec: number) => {
    const el = audioRef.current;
    const card = cardsRef.current[index];
    if (!el || !card) return;
    activeRangeRef.current = { start: fromSec, end: card.endMs / 1000 };
    setPlayingIndex(index);

    const begin = () => {
      try {
        el.currentTime = fromSec;
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
  }, []);

  // Play (from the paragraph start) or pause the current card.
  const togglePlay = useCallback(
    (index: number) => {
      const el = audioRef.current;
      const card = cardsRef.current[index];
      if (!el || !card) return;
      if (playingIndex === index && !el.paused) {
        el.pause();
        return;
      }
      playFrom(index, card.startMs / 1000);
    },
    [playingIndex, playFrom]
  );

  // Click-to-seek: jump straight to a matched sentence and play from there.
  const seekToMatch = useCallback(
    (index: number, childStartMs: number) => {
      setFocusedIndex(index);
      playFrom(index, childStartMs / 1000);
    },
    [playFrom]
  );

  // Slice the requested span (paragraph OR a precise quote) to a local WAV.
  const downloadClip = useCallback(
    async (index: number, startMs: number, endMs: number, kind: "paragraph" | "quote") => {
      const card = cardsRef.current[index];
      if (!card) return;
      try {
        const clip: Clip = {
          file_path: card.filePath,
          start_time_ms: startMs,
          end_time_ms: endMs,
        };
        const { buffer } = await stitchClips([clip], 0);
        const wav = audioBufferToWav(buffer);
        const url = URL.createObjectURL(wav);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${kind}_${index + 1}_${Math.round(startMs / 1000)}s.wav`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    []
  );

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
          const card = cardsRef.current[idx];
          if (card) downloadClip(idx, card.startMs, card.endMs, "paragraph");
          return idx;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards.length, togglePlay, downloadClip]);

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
                registerRef={registerRef}
                onFocus={setFocusedIndex}
                onTogglePlay={togglePlay}
                onDownload={downloadClip}
                onSeek={seekToMatch}
              />
            ))}
          </div>
        </div>
      )}

      {/* One hidden <audio>, driven imperatively to play a single paragraph. */}
      <audio ref={audioRef} style={{ display: "none" }} />
    </div>
  );
}
