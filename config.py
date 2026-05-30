"""Central configuration for the Audio RAG Auto-Editor.

Loads settings from a local .env file (see .env.example). Keeping all the
knobs in one place makes it trivial to swap embedding/editor providers
without touching the pipeline code.
"""

import os

from dotenv import load_dotenv

load_dotenv()


def _get(name: str, default: str = "") -> str:
    return os.getenv(name, default)


# ---- API keys ----
GROQ_API_KEY = _get("GROQ_API_KEY")
PINECONE_API_KEY = _get("PINECONE_API_KEY")
GEMINI_API_KEY = _get("GEMINI_API_KEY")
OPENAI_API_KEY = _get("OPENAI_API_KEY")

# ---- Pinecone ----
PINECONE_INDEX_NAME = _get("PINECONE_INDEX_NAME", "audio-rag")
PINECONE_NAMESPACE = _get("PINECONE_NAMESPACE", "default")
PINECONE_CLOUD = _get("PINECONE_CLOUD", "aws")
PINECONE_REGION = _get("PINECONE_REGION", "us-east-1")

# ---- Embeddings ----
EMBED_PROVIDER = _get("EMBED_PROVIDER", "pinecone").lower()
PINECONE_EMBED_MODEL = _get("PINECONE_EMBED_MODEL", "llama-text-embed-v2")
OPENAI_EMBED_MODEL = _get("OPENAI_EMBED_MODEL", "text-embedding-3-small")

# ---- Transcription ----
GROQ_WHISPER_MODEL = _get("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo")

# ---- Editor LLM ----
EDITOR_PROVIDER = _get("EDITOR_PROVIDER", "gemini").lower()
GEMINI_MODEL = _get("GEMINI_MODEL", "gemini-2.0-flash")
GROQ_LLM_MODEL = _get("GROQ_LLM_MODEL", "llama-3.3-70b-versatile")

# ---- Pipeline tuning ----
TOP_K = int(_get("TOP_K", "5"))
PARENT_MAX_SECONDS = float(_get("PARENT_MAX_SECONDS", "30"))
PAUSE_THRESHOLD_SECONDS = float(_get("PAUSE_THRESHOLD_SECONDS", "0.7"))
CROSSFADE_MS = int(_get("CROSSFADE_MS", "50"))
INPUT_DIR = _get("INPUT_DIR", "data/input")
OUTPUT_PATH = _get("OUTPUT_PATH", "highlight_reel.mp3")

# The field that holds the embedded text for Pinecone integrated embeddings.
TEXT_FIELD = "child_text"


def require(*keys: str) -> None:
    """Fail fast with a helpful message if a required key is missing."""
    missing = [k for k in keys if not globals().get(k)]
    if missing:
        raise SystemExit(
            "Missing required configuration: "
            + ", ".join(missing)
            + "\nCopy .env.example to .env and fill in the values."
        )
