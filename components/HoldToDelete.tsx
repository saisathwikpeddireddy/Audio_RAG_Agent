"use client";

// Press-and-hold to confirm a destructive action. A crimson bar fills left→right
// over HOLD_MS; releasing early resets it, filling fully fires onConfirm. Guards
// against accidentally wiping a long transcribed file with a stray click.

import { useRef, useState } from "react";

const HOLD_MS = 1500;

export default function HoldToDelete({
  onConfirm,
  disabled,
  label = "Delete",
}: {
  onConfirm: () => void;
  disabled?: boolean;
  label?: string;
}) {
  const [progress, setProgress] = useState(0);
  const raf = useRef<number | null>(null);
  const start = useRef(0);
  const fired = useRef(false);

  function stop() {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }

  function begin(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    if (disabled) return;
    fired.current = false;
    start.current = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start.current) / HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        if (!fired.current) {
          fired.current = true;
          stop();
          setProgress(0);
          onConfirm();
        }
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }

  function cancel() {
    stop();
    if (!fired.current) setProgress(0);
  }

  return (
    <button
      type="button"
      className="hold-del"
      disabled={disabled}
      onMouseDown={begin}
      onMouseUp={cancel}
      onMouseLeave={cancel}
      onTouchStart={begin}
      onTouchEnd={cancel}
      title="Press and hold to delete"
      aria-label="Press and hold to delete"
    >
      <span className="hold-fill" style={{ width: `${progress * 100}%` }} />
      <span className="hold-label">{progress > 0 ? "hold…" : label}</span>
    </button>
  );
}
