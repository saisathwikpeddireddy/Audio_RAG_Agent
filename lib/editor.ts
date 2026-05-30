// Phase 2 editor "scalpel": turn retrieved parent blocks into clip boundaries.
// Default provider is Gemini; set EDITOR_PROVIDER=groq to use Groq Llama instead.

import { config } from "./config";
import { groqChatJson } from "./groq";
import type { Hit, Clip, ReelResult } from "./types";

export const EDITOR_SYSTEM_PROMPT = `You are an expert Audio Editor and research assistant. You are given a user query and several transcript chunks retrieved from various audio files. Each chunk includes the text, file path, and millisecond timestamps.

You have two jobs:

A) Write a concise spoken-language answer to the user's query, grounded ONLY in the provided chunks. 2-5 sentences. Do not invent facts that are not in the chunks. If the chunks do not actually answer the query, say so briefly.

B) Create a logical "highlight reel" of clips that backs up your answer by stringing the most relevant moments together.

CLIP RULES:
1. Trim conversational fluff. Find the core answer in the text.
2. Ensure the text you select represents a COMPLETE thought. Do not cut someone off mid-sentence.
3. Order the clips chronologically or in a logical narrative sequence.
4. If a chunk is irrelevant, discard it entirely.

Output ONLY a raw, valid JSON object. No markdown formatting, no explanations.

Expected JSON schema:
{
  "answer": "A concise text answer to the user's query.",
  "clips": [
    {
      "file_path": "path/to/file.mp3",
      "start_time_ms": 14500,
      "end_time_ms": 22000
    }
  ]
}`;

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

function parseReel(raw: string): ReelResult {
  let text = raw.trim();

  // Strip ```json ... ``` fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fall back to grabbing the outermost JSON object, then a bare array.
    const obj = text.match(/\{[\s\S]*\}/);
    const bracket = text.match(/\[[\s\S]*\]/);
    if (obj) parsed = JSON.parse(obj[0]);
    else if (bracket) parsed = JSON.parse(bracket[0]);
    else throw new Error("Editor did not return parseable JSON.");
  }

  // Locate the answer string and the clips array regardless of exact shape:
  // { answer, clips }, a bare array of clips, or { something: [...] }.
  let answer = "";
  let arr: any[] = [];
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.answer === "string") answer = obj.answer.trim();
    if (Array.isArray(obj.clips)) {
      arr = obj.clips;
    } else {
      const found = Object.values(obj).find((v) => Array.isArray(v));
      arr = (found as any[]) ?? [];
    }
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
  return { answer, clips };
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

export async function generateReel(query: string, hits: Hit[]): Promise<ReelResult> {
  if (!hits.length) return { answer: "", clips: [] };

  let raw: string;
  if (config.editorProvider === "groq") {
    raw = await groqChatJson(EDITOR_SYSTEM_PROMPT, compileContext(query, hits));
  } else {
    try {
      raw = await geminiEdit(query, hits);
    } catch (err) {
      // Gemini's free tier can be quota-limited or a model can be retired
      // (e.g. a 429 with "limit: 0"). Fall back to Groq Llama when available
      // so the editor step still succeeds.
      if (!config.groqApiKey) throw err;
      raw = await groqChatJson(EDITOR_SYSTEM_PROMPT, compileContext(query, hits));
    }
  }
  return parseReel(raw);
}
