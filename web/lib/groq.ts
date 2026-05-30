// Groq Whisper transcription. We pass the Vercel Blob *URL* directly to Groq so
// the serverless function never has to buffer the whole MP3 in memory.

import { config } from "./config";
import type { Segment } from "./types";

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export async function transcribeUrl(audioUrl: string): Promise<Segment[]> {
  const form = new FormData();
  form.append("url", audioUrl);
  form.append("model", config.groqWhisperModel);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const res = await fetch(GROQ_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.groqApiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Groq transcription failed (${res.status}): ${detail.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    text?: string;
    duration?: number;
    segments?: Array<{ start: number; end: number; text: string }>;
  };

  if (data.segments && data.segments.length) {
    return data.segments.map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: s.text ?? "",
    }));
  }

  // Fallback: one segment spanning the whole clip.
  if (data.text) {
    return [{ start: 0, end: Number(data.duration) || 0, text: data.text }];
  }
  return [];
}

// Groq Llama as the fallback "editor" LLM (used when EDITOR_PROVIDER=groq).
export async function groqChatJson(systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.groqLlmModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Groq editor failed (${res.status}): ${detail.slice(0, 500)}`);
  }
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}
