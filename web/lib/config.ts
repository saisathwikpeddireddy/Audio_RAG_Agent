// Central config, read from environment variables (set in Vercel project settings).

export const config = {
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  pineconeApiKey: process.env.PINECONE_API_KEY ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",

  pineconeIndex: process.env.PINECONE_INDEX_NAME ?? "audio-rag",
  pineconeNamespace: process.env.PINECONE_NAMESPACE ?? "default",
  pineconeCloud: process.env.PINECONE_CLOUD ?? "aws",
  pineconeRegion: process.env.PINECONE_REGION ?? "us-east-1",
  pineconeEmbedModel: process.env.PINECONE_EMBED_MODEL ?? "llama-text-embed-v2",

  groqWhisperModel: process.env.GROQ_WHISPER_MODEL ?? "whisper-large-v3-turbo",

  // "gemini" (default) or "groq" fallback for the editor LLM.
  editorProvider: (process.env.EDITOR_PROVIDER ?? "gemini").toLowerCase(),
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
  groqLlmModel: process.env.GROQ_LLM_MODEL ?? "llama-3.3-70b-versatile",

  topK: parseInt(process.env.TOP_K ?? "5", 10),
  parentMaxSeconds: parseFloat(process.env.PARENT_MAX_SECONDS ?? "30"),
  pauseThresholdSeconds: parseFloat(process.env.PAUSE_THRESHOLD_SECONDS ?? "0.7"),
  crossfadeMs: parseInt(process.env.CROSSFADE_MS ?? "50", 10),

  // The record field whose text Pinecone embeds for the integrated index.
  textField: "child_text",
};

export function requireKeys(...keys: (keyof typeof config)[]) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing
        .map((k) => k.toString())
        .join(", ")}. Set them in your Vercel project settings.`
    );
  }
}
