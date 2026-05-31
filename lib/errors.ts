// Standardized API error classification. External providers (Groq, Gemini,
// Pinecone) surface their HTTP status inside the thrown Error's message
// (e.g. "Groq chat failed (429): ..."), so we sniff that to return a friendly,
// machine-readable payload the brutalist UI can theme — instead of leaking a raw
// stack/500 or failing silently.

export interface ApiError {
  status: number; // HTTP status for the Next.js response
  code: string; // machine-readable code for the client (e.g. "LLM_RATE_LIMIT")
  message: string; // friendly, human-facing copy
}

export function classifyError(error: unknown): ApiError {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();

  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("quota") ||
    lower.includes("resource_exhausted")
  ) {
    return {
      status: 429,
      code: "LLM_RATE_LIMIT",
      message: "Take a breath! The AI is cooling down — give it a few seconds and try again.",
    };
  }

  if (lower.includes("is not set")) {
    return {
      status: 500,
      code: "CONFIG_MISSING",
      message: "The server is missing an API key. Check the deployment's environment variables.",
    };
  }

  if (lower.includes("timed out") || lower.includes("took too long")) {
    return {
      status: 504,
      code: "TIMEOUT",
      message: "That took too long. Try a shorter clip or a narrower question.",
    };
  }

  return { status: 500, code: "INTERNAL", message: raw || "Something went wrong." };
}
