// Phase 3 (browser): fetch the referenced audio, slice each clip by millisecond,
// and render to a single playable buffer. Clips are placed back-to-back with a
// hard gap of absolute silence between them (no crossfade) — speech transients
// (leading/trailing consonants) survive intact, and the gap gives the listener
// a "breath" to register each context switch. Client-side via Web Audio.

import type { Clip } from "./types";

const audioBufferCache = new Map<string, AudioBuffer>();

// A single, lazily-created AudioContext shared across every stitch/decode call.
// Browsers cap the number of live AudioContexts (~6 in Safari), so reusing one
// instead of new-ing (and orphaning) one per search is essential to avoid the
// classic Web Audio leak. It's created on first use, which only ever happens
// behind a user gesture (search / play / download).
let decodeCtx: AudioContext | null = null;

function getDecodeContext(): AudioContext {
  if (!decodeCtx || decodeCtx.state === "closed") {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    decodeCtx = new Ctor();
  }
  return decodeCtx;
}

async function loadBuffer(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const cached = audioBufferCache.get(url);
  if (cached) return cached;
  // Browsers auto-suspend AudioContexts that weren't created inside a user gesture.
  // Resume before decoding so decodeAudioData doesn't stall on a suspended context.
  if (ctx instanceof AudioContext && ctx.state === "suspended") {
    await ctx.resume();
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch audio: ${url} (${res.status})`);
  const data = await res.arrayBuffer();
  const buffer = await ctx.decodeAudioData(data);
  audioBufferCache.set(url, buffer);
  return buffer;
}

export interface StitchResult {
  buffer: AudioBuffer;
  durationSec: number;
}

// Render clips into one AudioBuffer, separated by `gapMs` of absolute silence.
// The silence is baked into the rendered buffer, so the <audio> element's
// currentTime/duration include the gaps and the visual playhead stays in sync.
export async function stitchClips(clips: Clip[], gapMs = 400): Promise<StitchResult> {
  if (!clips.length) throw new Error("No clips to stitch.");

  // Decoding needs a context; reuse the shared singleton (never new one per call).
  const ctx = getDecodeContext();

  // Pre-load + resolve each clip's slice as {buffer, offsetSec, durationSec}.
  type Slice = { source: AudioBuffer; offsetSec: number; durationSec: number };
  const slices: Slice[] = [];
  let sampleRate = 44100;
  let channels = 1;

  for (const clip of clips) {
    const buf = await loadBuffer(ctx, clip.file_path);
    sampleRate = buf.sampleRate;
    channels = Math.max(channels, buf.numberOfChannels);
    const start = Math.max(0, clip.start_time_ms / 1000);
    const end = Math.min(buf.duration, clip.end_time_ms / 1000);
    if (end <= start) continue;
    slices.push({ source: buf, offsetSec: start, durationSec: end - start });
  }
  if (!slices.length) throw new Error("All clips were empty after clamping.");

  const gapSec = Math.max(0, gapMs / 1000);
  // Total timeline = sum of clip durations + the injected silent gaps between.
  const totalSec =
    slices.reduce((acc, s) => acc + s.durationSec, 0) + gapSec * (slices.length - 1);

  const offline = new OfflineAudioContext(
    channels,
    Math.ceil(Math.max(totalSec, 0.01) * sampleRate),
    sampleRate
  );

  let cursor = 0; // seconds on the output timeline
  const nodes: AudioBufferSourceNode[] = [];
  slices.forEach((slice) => {
    const node = offline.createBufferSource();
    node.buffer = slice.source;
    // No gain ramps — play each slice at full volume so consonants stay crisp.
    node.connect(offline.destination);
    node.start(cursor, slice.offsetSec, slice.durationSec);
    nodes.push(node);
    // Advance past this clip plus a hard gap of silence before the next one.
    cursor += slice.durationSec + gapSec;
  });

  try {
    const rendered = await offline.startRendering();
    return { buffer: rendered, durationSec: rendered.duration };
  } finally {
    // Explicitly tear down the source nodes so they don't linger as detached
    // Web Audio objects. The shared decode context is intentionally NOT closed
    // (it's reused across searches); the OfflineAudioContext is GC'd on its own.
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
  }
}

// Encode an AudioBuffer to a 16-bit PCM WAV Blob (universally playable/downloadable).
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  // Interleave channels.
  const chans: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) chans.push(buffer.getChannelData(c));

  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }

  return new Blob([ab], { type: "audio/wav" });
}
