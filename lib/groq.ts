// Groq Whisper transcription. We pass the Vercel Blob *URL* directly to Groq so
// the serverless function never has to buffer the whole MP3 in memory.

import { config } from "./config";

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

// A single word with its start/end offsets (seconds) inside the audio. The basis
// for precise per-chunk audio boundaries at ingest, and the karaoke highlight.
export interface Word {
  word: string;
  start: number;
  end: number;
}

// Transcribe a Vercel Blob URL with WORD-level timestamps. Groq accepts the URL
// directly, so the serverless function never buffers the whole MP3. These word
// offsets let ingestion bind each RAG chunk's [start, end] to its exact words.
export async function transcribeUrlWords(audioUrl: string): Promise<Word[]> {
  const form = new FormData();
  form.append("url", audioUrl);
  form.append("model", config.groqWhisperModel);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  const res = await fetch(GROQ_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.groqApiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text();
    // Groq caps transcription input at 25 MB - surface that as friendly copy
    // instead of leaking raw JSON into the UI.
    if (res.status === 400 && /too large|size limit/i.test(detail)) {
      throw new Error(
        "This audio is over the 25 MB transcription limit. Trim it, or re-export as mono at a lower bitrate, then try again."
      );
    }
    throw new Error(`Groq transcription failed (${res.status}): ${detail.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    words?: Array<{ word: string; start: number; end: number }>;
  };

  return (data.words ?? []).map((w) => ({
    word: w.word ?? "",
    start: Number(w.start) || 0,
    end: Number(w.end) || 0,
  }));
}

// Groq retires chat models over time (llama-3.3-70b-versatile now 404s for this
// account), so try the configured model first, then current alternatives,
// skipping any that don't exist. The first one that works is remembered.
const FALLBACK_CHAT_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "qwen/qwen3-32b",
  "llama-3.1-8b-instant",
];
let workingChatModel: string | null = null;

function chatModels(): string[] {
  const all = [workingChatModel, config.groqLlmModel, ...FALLBACK_CHAT_MODELS].filter(
    (m): m is string => !!m
  );
  return [...new Set(all)];
}

// Groq chat in JSON mode: the fallback "editor" LLM (EDITOR_PROVIDER=groq, or
// when Gemini fails) and the suggested-question generator.
export async function groqChatJson(systemPrompt: string, userPrompt: string): Promise<string> {
  let lastError = "";
  for (const model of chatModels()) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
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
      lastError = `Groq editor failed (${res.status}) on ${model}: ${detail.slice(0, 300)}`;
      // Unknown / retired model, or one without JSON mode: try the next one.
      // Anything else (auth, rate limit) is a real error.
      if (
        res.status === 404 ||
        /model_not_found|decommissioned|does not exist|response_format|json mode/i.test(detail)
      ) {
        if (workingChatModel === model) workingChatModel = null;
        continue;
      }
      throw new Error(lastError);
    }
    workingChatModel = model;
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }
  throw new Error(lastError || "No Groq chat model available.");
}
