// Phase 3 (browser): fetch the referenced audio, slice each clip by millisecond,
// join with a short linear crossfade, and render to a single playable buffer.
// Runs entirely client-side via the Web Audio API — no ffmpeg required.

import type { Clip } from "./types";

const audioBufferCache = new Map<string, AudioBuffer>();

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

// Render clips into one AudioBuffer with `crossfadeMs` overlaps between them.
export async function stitchClips(clips: Clip[], crossfadeMs = 50): Promise<StitchResult> {
  if (!clips.length) throw new Error("No clips to stitch.");

  // A scratch context just for decoding (decodeAudioData needs a context).
  const decodeCtx = new (window.AudioContext || (window as any).webkitAudioContext)();

  // Pre-load + resolve each clip's slice as {buffer, startSample, lengthSamples}.
  type Slice = { source: AudioBuffer; offsetSec: number; durationSec: number };
  const slices: Slice[] = [];
  let sampleRate = 44100;
  let channels = 2;

  for (const clip of clips) {
    const buf = await loadBuffer(decodeCtx, clip.file_path);
    sampleRate = buf.sampleRate;
    channels = Math.max(channels, buf.numberOfChannels);
    const start = Math.max(0, clip.start_time_ms / 1000);
    const end = Math.min(buf.duration, clip.end_time_ms / 1000);
    if (end <= start) continue;
    slices.push({ source: buf, offsetSec: start, durationSec: end - start });
  }
  if (!slices.length) throw new Error("All clips were empty after clamping.");

  const crossfadeSec = crossfadeMs / 1000;
  // Total timeline = sum of clip durations minus the overlapped crossfades.
  const totalSec =
    slices.reduce((acc, s) => acc + s.durationSec, 0) - crossfadeSec * (slices.length - 1);

  const offline = new OfflineAudioContext(
    channels,
    Math.ceil(Math.max(totalSec, 0.01) * sampleRate),
    sampleRate
  );

  let cursor = 0; // seconds on the output timeline
  slices.forEach((slice, i) => {
    const node = offline.createBufferSource();
    node.buffer = slice.source;

    const gain = offline.createGain();
    node.connect(gain).connect(offline.destination);

    const startAt = cursor;
    const fadeIn = i > 0 ? crossfadeSec : 0;
    const fadeOut = i < slices.length - 1 ? crossfadeSec : 0;

    // Linear crossfades at the seams.
    gain.gain.setValueAtTime(fadeIn > 0 ? 0 : 1, startAt);
    if (fadeIn > 0) gain.gain.linearRampToValueAtTime(1, startAt + fadeIn);
    const endAt = startAt + slice.durationSec;
    if (fadeOut > 0) {
      gain.gain.setValueAtTime(1, endAt - fadeOut);
      gain.gain.linearRampToValueAtTime(0, endAt);
    }

    node.start(startAt, slice.offsetSec, slice.durationSec);

    // Advance the cursor, overlapping the next clip by one crossfade.
    cursor = endAt - fadeOut;
  });

  const rendered = await offline.startRendering();
  decodeCtx.close();
  return { buffer: rendered, durationSec: rendered.duration };
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
