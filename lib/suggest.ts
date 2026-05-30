// Generate a few grounded example questions for a freshly-indexed file, so the
// Query tab can offer one-click prompts that actually match the audio content.
// Uses Groq (fast, free, reliable) and is best-effort: any failure yields [].

import { groqChatJson } from "./groq";
import { config } from "./config";

const SUGGEST_PROMPT = `You write example questions a user might ask about an audio transcript.
Given the transcript, return exactly 3 short, specific, natural questions that THIS audio can answer.
Each question must be under 70 characters and end with a question mark.
Output ONLY valid JSON: { "questions": ["...", "...", "..."] }`;

export async function suggestQuestions(transcript: string): Promise<string[]> {
  if (!config.groqApiKey || !transcript.trim()) return [];
  try {
    const raw = await groqChatJson(SUGGEST_PROMPT, transcript.slice(0, 6000));
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return [];
      parsed = JSON.parse(m[0]);
    }
    const qs = Array.isArray(parsed?.questions) ? parsed.questions : [];
    return qs
      .filter((q: unknown): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q: string) => q.trim())
      .slice(0, 3);
  } catch {
    return [];
  }
}
