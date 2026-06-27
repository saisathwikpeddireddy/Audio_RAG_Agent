// Rough cost estimates per action, so the admin dashboard can show "what this is
// costing me". These are ESTIMATES based on published list prices; tune the RATES
// if your providers' pricing changes. All functions return fractional US cents.

export const RATES = {
  // Groq whisper-large-v3-turbo transcription, per hour of audio.
  whisperPerHourUsd: 0.04,
  // Gemini 2.5 Flash, per 1M tokens (input / output).
  geminiInputPerMTokUsd: 0.3,
  geminiOutputPerMTokUsd: 2.5,
  // Vercel Blob storage, per GB-month.
  blobStoragePerGbMonthUsd: 0.023,
};

// Cheap token estimate (~4 chars/token) good enough for cost rough-cuts.
const estTokens = (chars: number) => Math.ceil(Math.max(0, chars) / 4);

export function transcriptionCostCents(seconds: number): number {
  return (Math.max(0, seconds) / 3600) * RATES.whisperPerHourUsd * 100;
}

export function answerCostCents(inputChars: number, outputChars: number): number {
  const inUsd = (estTokens(inputChars) / 1_000_000) * RATES.geminiInputPerMTokUsd;
  const outUsd = (estTokens(outputChars) / 1_000_000) * RATES.geminiOutputPerMTokUsd;
  return (inUsd + outUsd) * 100;
}

// One-off note: storage is an ongoing monthly cost, not per-event. The dashboard
// uses total stored bytes to estimate a monthly figure.
export function storageMonthlyCostCents(bytes: number): number {
  return (Math.max(0, bytes) / 1_000_000_000) * RATES.blobStoragePerGbMonthUsd * 100;
}
