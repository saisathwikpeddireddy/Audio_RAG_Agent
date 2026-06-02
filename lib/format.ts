// Turn a raw indexed source string — a blob URL, a path, or a stored filename —
// into a clean human title for display. Strips the directory, percent-encoding,
// file extension, and the trailing "- audio overview - <DATE> UTC-<HASH>" junk
// that ingestion appends, leaving just the meaningful name.
export function formatSourceName(raw?: string): string {
  if (!raw) return "unknown source";

  // Keep only the final path/URL segment, then decode %20 etc.
  let name = raw.split(/[/\\]/).pop() || raw;
  try {
    name = decodeURIComponent(name);
  } catch {
    // leave as-is if it isn't valid percent-encoding
  }

  // Drop a trailing file extension (.mp3, .wav, .m4a, …).
  name = name.replace(/\.[a-z0-9]{1,5}$/i, "");
  // Underscores → spaces, collapse whitespace.
  name = name.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();

  // Take the first " - " segment ("Talk - Audio Overview - 2026-…" → "Talk").
  let first = name.split(/\s+-\s+/)[0]?.trim() || name;

  // Scrub any ISO/UTC date, "UTC", or long hex hash that survived.
  first = first
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?z?)?\b/gi, "")
    .replace(/\butc\b/gi, "")
    .replace(/\b[0-9a-f]{8,}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return first || name || "unknown source";
}
