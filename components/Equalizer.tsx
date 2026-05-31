"use client";

// Kinetic Brutalist Equalizer — replaces the 3D blob. Lives next to the PLAY
// button in the player panel.
//   idle:      short static bars
//   searching: a slow cascading sine wave (framer-motion)
//   playing:   bar heights driven by live Web Audio frequency data

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";

const BARS = 6;
const ACCENTS = ["#ec4899", "#06b6d4", "#eab308", "#ec4899", "#06b6d4", "#eab308"];

export type EqState = "idle" | "searching" | "playing";

export default function Equalizer({
  analyser,
  state,
}: {
  analyser: AnalyserNode | null;
  state: EqState;
}) {
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const raf = useRef<number | null>(null);

  // Drive bar heights from frequency data while playing.
  useEffect(() => {
    if (state !== "playing" || !analyser) {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
      if (state === "idle") {
        barRefs.current.forEach((b) => b && (b.style.height = "22%"));
      }
      return;
    }

    const bins = new Uint8Array(analyser.frequencyBinCount);
    const step = Math.max(1, Math.floor(bins.length / BARS));
    const tick = () => {
      analyser.getByteFrequencyData(bins as any);
      for (let i = 0; i < BARS; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += bins[i * step + j] ?? 0;
        const avg = sum / step / 255; // 0..1
        const el = barRefs.current[i];
        if (el) el.style.height = `${12 + avg * 88}%`;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [state, analyser]);

  return (
    <div className="eq" aria-hidden data-state={state}>
      {Array.from({ length: BARS }).map((_, i) =>
        state === "searching" ? (
          <motion.span
            key={`s${i}`}
            className="eq-bar"
            style={{ background: ACCENTS[i % ACCENTS.length] }}
            animate={{ height: ["25%", "90%", "25%"] }}
            transition={{ duration: 1, repeat: Infinity, ease: "easeInOut", delay: i * 0.12 }}
          />
        ) : (
          <span
            key={`b${i}`}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
            className="eq-bar"
            style={{ background: ACCENTS[i % ACCENTS.length], height: "22%" }}
          />
        )
      )}
    </div>
  );
}
