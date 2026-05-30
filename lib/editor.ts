// Phase 2 editor "scalpel": turn retrieved parent blocks into clip boundaries.
// Default provider is Gemini; set EDITOR_PROVIDER=groq to use Groq Llama instead.

import { config } from "./config";
import { groqChatJson } from "./groq";
import type { Hit, Clip } from "./types";

export const EDITOR_SYSTEM_PROMPT = `You are an expert Audio Editor. You are given a user query and several transcript chunks retrieved from various audio files. Each chunk includes the text, file path, and millisecond timestamps.

Your task is to create a logical "highlight reel" that answers the user's query by stringing these clips together.

RULES:
1. Trim conversational fluff. Find the core answer in the text.
2. Ensure the text you select represents a COMPLETE thought. Do not cut someone off mid-sentence.
3. Order the clips chronologically or in a logical narrative sequence.
4. If a chunk is irrelevant, discard it entirely.
5. Output ONLY a raw, valid JSON array of objects. No markdown formatting, no explanations.

Expected JSON schema:
[
  {
    "file_path": "path/to/file.mp3",
    "start_time_ms": 14500,
    "end_time_ms": 22000
  }
]`;

export function compileContext(query: string, hits: Hit[]): string {
  const blocks = hits.map(
    (h, i) =>
      `CHUNK ${i + 1}\n` +
      `file_path: ${h.file_path}\n` +
      `start_time_ms: ${h.start_time_ms}\n` +
      `end_time_ms: ${h.end_time_ms}\n` +
      `text: ${h.parent_text}\n`
  );
  return `USER QUERY: ${query}\n\nRETRIEVED CHUNKS:\n\n${blocks.join("\n")}`;
}

function extractClips(raw: string): Clip[] {
  let text = raw.trim();

  // Strip ```json ... ``` fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  // Some models (and Groq json_object mode) wrap the array in an object.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const bracket = text.match(/\[[\s\S]*\]/);
    if (!bracket) throw new Error("Editor did not return parseable JSON.");
    parsed = JSON.parse(bracket[0]);
  }

  let arr: any[];
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === "object") {
    // Find the first array-valued property (e.g. { "clips": [...] }).
    const vals = Object.values(parsed as Record<string, unknown>);
    const found = vals.find((v) => Array.isArray(v));
    arr = (found as any[]) ?? [];
  } else {
    arr = [];
  }

  const clips: Clip[] = [];
  for (const c of arr) {
    const fp = c?.file_path;
    const start = Number(c?.start_time_ms);
    const end = Number(c?.end_time_ms);
    if (typeof fp === "string" && fp && Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0) {
      clips.push({ file_path: fp, start_time_ms: Math.round(start), end_time_ms: Math.round(end) });
    }
  }
  return clips;
}

async function geminiEdit(query: string, hits: Hit[]): Promise<string> {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not set.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.geminiApiKey,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: EDITOR_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: compileContext(query, hits) }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini editor failed (${res.status}): ${detail.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

export async function editClips(query: string, hits: Hit[]): Promise<Clip[]> {
  if (!hits.length) return [];
  const raw =
    config.editorProvider === "groq"
      ? await groqChatJson(EDITOR_SYSTEM_PROMPT, compileContext(query, hits))
      : await geminiEdit(query, hits);
  return extractClips(raw);
}
