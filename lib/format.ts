// Turn a raw indexed source string - a blob URL, a path, or a stored filename - // into a clean, human-readable Title Case name for display. Strips the directory,
// percent-encoding, file extension, ingestion descriptors ("- audio overview -
// <DATE> UTC-<HASH>"), and trailing version tags (v3, v3-2), then normalizes
// separators and applies Title Case. e.g. "the-attention-equation-v3-2.mp3" →
// "The Attention Equation".
export function formatSourceName(raw?: string): string {
  if (!raw) return "Unknown Source";

  // Keep only the final path/URL segment, then decode %20 etc.
  let name = raw.split(/[/\\]/).pop() || raw;
  try {
    name = decodeURIComponent(name);
  } catch {
    // leave as-is if it isn't valid percent-encoding
  }

  // Drop a trailing file extension (.mp3, .wav, .m4a, …).
  name = name.replace(/\.[a-z0-9]{1,5}$/i, "");

  // Cut the ingestion descriptor and everything after it ("… - audio overview …").
  name = name.replace(/[\s_-]+audio overview[\s\S]*$/i, "");

  // Strip dates / hashes BEFORE separators change (the date relies on hyphens).
  name = name
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?z?)?\b/gi, "")
    .replace(/\butc\b/gi, "")
    .replace(/\b[0-9a-f]{8,}\b/gi, "");

  // Strip a trailing version tag: "v3", "v3-2", "_v12 4", etc.
  name = name.replace(/[\s_-]v\d+(?:[\s_-]\d+)*\s*$/i, "");

  // Replace all hyphens and underscores with spaces, then collapse whitespace.
  name = name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

  // Title Case: capitalize the first letter of every word.
  const titled = name.replace(
    /\w\S*/g,
    (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );

  return titled || "Unknown Source";
}
