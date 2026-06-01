// Phase 3 (browser): fetch the referenced audio, slice each clip by millisecond,
// and render to a single playable buffer. Clips are placed back-to-back with a
// hard gap of absolute silence between them (no crossfade) — speech transients
// (leading/trailing consonants) survive intact, and the gap gives the listener
// a "breath" to register each context switch. Client-side via Web Audio.

import type { Clip } from "./types";

const audioBufferCache = new Map<string, AudioBuffer>();

// Decoding audio does NOT require the live audio device — so we decode on a
// throwaway OfflineAudioContext rather than a live AudioContext. A live context
// here was the source of the intermittent "AudioContext encountered an error
// from the audio device or the WebAudio renderer" failures, which left the
// rendered reel buffer silent. The offline context also sidesteps the live-context
// cap (~6 in Safari) and any autoplay/suspend gymnastics. Actual playback happens
// via a plain hidden <audio> element, driven inside the play button's click handler.
let decodeCtx: OfflineAudioContext | null = null;

function getDecodeContext(): OfflineAudioContext {
  if (!decodeCtx) {
    const Ctor = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    // Minimal 1-frame context used purely for decodeAudioData. Decoded buffers
    // are resampled to 44.1kHz, which the output render context below also uses.
    decodeCtx = new Ctor(1, 1, 44100);
  }
  return decodeCtx;
}

async function loadBuffer(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const cached = audioBufferCache.get(url);
  if (cached) return cached;
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

// Synthesize a soft "tape click" chapter marker at `atSec` on the offline
// timeline: a brief 600Hz sine that fades 0.15 → ~0 in ~80ms, so the listener
// hears a gentle blip at each clip→gap boundary signalling the jump to a new
// timestamp. No external files — pure Web Audio. Returns its nodes for teardown.
function scheduleTick(ctx: OfflineAudioContext, atSec: number): AudioNode[] {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(600, atSec);
  // Quick exponential fade (can't target a true 0, so ramp to near-silence) —
  // soft attack/decay keeps it from clicking.
  gain.gain.setValueAtTime(0.0001, atSec);
  gain.gain.exponentialRampToValueAtTime(0.15, atSec + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, atSec + 0.08);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(atSec);
  osc.stop(atSec + 0.1);
  return [osc, gain];
}

// Render clips into one AudioBuffer, separated by `gapMs` of (near-)silence. A
// soft synthesized tick marks each clip boundary inside the gap. The gap +
// markers are baked into the rendered buffer, so the <audio> element's
// currentTime/duration include them and the visual playhead stays in sync.
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
  const nodes: AudioNode[] = [];
  slices.forEach((slice, i) => {
    const node = offline.createBufferSource();
    node.buffer = slice.source;
    // No gain ramps — play each slice at full volume so consonants stay crisp.
    node.connect(offline.destination);
    node.start(cursor, slice.offsetSec, slice.durationSec);
    nodes.push(node);
    const clipEnd = cursor + slice.durationSec;
    // Drop a soft auditory chapter marker the instant this clip ends (start of
    // the gap), except after the final clip — nothing follows it.
    if (gapSec > 0 && i < slices.length - 1) {
      nodes.push(...scheduleTick(offline, clipEnd));
    }
    // Advance past this clip plus a hard gap of silence before the next one.
    cursor = clipEnd + gapSec;
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
