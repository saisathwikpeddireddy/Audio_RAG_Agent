"use client";

import { AnimatePresence, motion } from "framer-motion";
import { formatSourceName } from "@/lib/format";
import type { LibraryFile } from "@/lib/types";

const ACCENTS = ["#ec4899", "#06b6d4", "#eab308"];

// The capsule stack: every indexed file as a chunky, tappable pill with an
// explicit selected/unselected state (not color alone). Tapping a ready pill
// toggles whether it's searched; processing/failed pills show their own state.
export default function CapsuleStack({
  library,
  selected,
  onToggle,
  onReingest,
}: {
  library: LibraryFile[];
  selected: string[];
  onToggle: (fileId: string) => void;
  onReingest?: (file: LibraryFile) => void;
}) {
  if (library.length === 0) return null;
  const sel = new Set(selected);

  return (
    <div className="capsules">
      <AnimatePresence initial={false}>
        {library.map((f, i) => {
          const ready = f.status === "ready";
          const active = ready && sel.has(f.file_id);
          const cls = ready ? (active ? "active" : "unselected") : f.status; // "processing" | "failed"
          return (
            <motion.button
              type="button"
              key={f.file_id}
              className={`capsule ${cls}`}
              style={active ? { background: ACCENTS[i % ACCENTS.length] } : undefined}
              onClick={() => ready && onToggle(f.file_id)}
              disabled={!ready}
              layout
              initial={{ opacity: 0, scale: 0.7, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.6, x: 24 }}
              transition={{ type: "spring", stiffness: 320, damping: 22 }}
              whileHover={ready ? { scale: 1.02 } : undefined}
              whileTap={ready ? { scale: 0.96 } : undefined}
              title={f.filename}
            >
              {ready && <span className="capsule-icon">{active ? "✓" : "+"}</span>}
              <span className="capsule-name">
                <span className="capsule-num">[{i + 1}]</span> {f.title || formatSourceName(f.filename)}
              </span>
              {f.status === "processing" && <span className="capsule-state">Listening &amp; Indexing…</span>}
              {f.status === "failed" && (
                <span
                  className="capsule-retry"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onReingest?.(f);
                  }}
                >
                  ⚠ retry
                </span>
              )}
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
