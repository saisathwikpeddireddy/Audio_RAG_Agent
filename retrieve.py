"""Phase 2 - Retrieval & LLM Editing.

Embeds the user query, searches Pinecone for the top-K child hits, compiles the
parent windows into a context payload, and hands it to the "LLM Scalpel"
(Gemini by default, Groq Llama as a fallback) to choose clip boundaries.
"""

import json
import re
from typing import List, Dict, Any

import config
from clients import with_retries


EDITOR_SYSTEM_PROMPT = """You are an expert Audio Editor. You are given a user query and several \
transcript chunks retrieved from various audio files. Each chunk includes the \
text, file path, and millisecond timestamps.

Your task is to create a logical "highlight reel" that answers the user's query \
by stringing these clips together.

RULES:
1. Trim conversational fluff. Find the core answer in the text.
2. Ensure the text you select represents a COMPLETE thought. Do not cut someone \
off mid-sentence.
3. Order the clips chronologically or in a logical narrative sequence.
4. If a chunk is irrelevant, discard it entirely.
5. Output ONLY a raw, valid JSON array of objects. No markdown formatting, no \
explanations.

Expected JSON schema:
[
  {
    "file_path": "path/to/file.mp3",
    "start_time_ms": 14500,
    "end_time_ms": 22000
  }
]"""


def compile_context(query: str, hits: List[Dict[str, Any]]) -> str:
    """Build the user-facing payload of retrieved parent blocks."""
    blocks = []
    for i, h in enumerate(hits, 1):
        blocks.append(
            f"CHUNK {i}\n"
            f"file_path: {h.get('file_path')}\n"
            f"start_time_ms: {h.get('start_time_ms')}\n"
            f"end_time_ms: {h.get('end_time_ms')}\n"
            f"text: {h.get('parent_text')}\n"
        )
    return f"USER QUERY: {query}\n\nRETRIEVED CHUNKS:\n\n" + "\n".join(blocks)


def _extract_json_array(text: str) -> List[Dict[str, Any]]:
    """Robustly pull a JSON array out of an LLM response."""
    text = text.strip()
    # Strip ```json ... ``` fences if present.
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    # Fall back to the first [...] block.
    if not text.startswith("["):
        bracket = re.search(r"\[.*\]", text, re.DOTALL)
        if bracket:
            text = bracket.group(0)
    data = json.loads(text)
    if not isinstance(data, list):
        raise ValueError("Editor did not return a JSON array.")
    return data


def _validate_clips(clips: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    valid = []
    for c in clips:
        try:
            fp = c["file_path"]
            start = int(c["start_time_ms"])
            end = int(c["end_time_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        if fp and end > start >= 0:
            valid.append({"file_path": fp, "start_time_ms": start, "end_time_ms": end})
    return valid


def _edit_gemini(query: str, hits: List[Dict[str, Any]]) -> str:
    import google.generativeai as genai

    config.require("GEMINI_API_KEY")
    genai.configure(api_key=config.GEMINI_API_KEY)
    model = genai.GenerativeModel(
        config.GEMINI_MODEL, system_instruction=EDITOR_SYSTEM_PROMPT
    )
    resp = with_retries(model.generate_content, compile_context(query, hits))
    return resp.text


def _edit_groq(query: str, hits: List[Dict[str, Any]]) -> str:
    from groq import Groq

    config.require("GROQ_API_KEY")
    client = Groq(api_key=config.GROQ_API_KEY)
    resp = with_retries(
        client.chat.completions.create,
        model=config.GROQ_LLM_MODEL,
        messages=[
            {"role": "system", "content": EDITOR_SYSTEM_PROMPT},
            {"role": "user", "content": compile_context(query, hits)},
        ],
        temperature=0.2,
    )
    return resp.choices[0].message.content


def edit(query: str, hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Run the configured editor LLM and return validated clip instructions."""
    if not hits:
        return []
    raw = _edit_groq(query, hits) if config.EDITOR_PROVIDER == "groq" else _edit_gemini(query, hits)
    clips = _extract_json_array(raw)
    return _validate_clips(clips)
