// A tiny "library" of indexed files, persisted as a single JSON manifest in
// Vercel Blob. There's no database — for a single-user hobby app this is enough
// to remember which audio files exist across reloads and to scope queries.

import { put, list } from "@vercel/blob";
import type { LibraryFile } from "./types";

const MANIFEST_PATH = "library/manifest.json";

export async function getLibrary(): Promise<LibraryFile[]> {
  try {
    const { blobs } = await list({ prefix: MANIFEST_PATH, limit: 1 });
    if (!blobs.length) return [];
    const res = await fetch(blobs[0].url, { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as LibraryFile[]) : [];
  } catch {
    // Manifest missing or unreadable — treat as an empty library.
    return [];
  }
}

// Upsert an entry by file_id and write the manifest back. Returns the full list.
export async function saveLibraryEntry(entry: LibraryFile): Promise<LibraryFile[]> {
  const current = await getLibrary();
  const next = [...current.filter((f) => f.file_id !== entry.file_id), entry].sort((a, b) =>
    a.indexed_at.localeCompare(b.indexed_at)
  );
  await put(MANIFEST_PATH, JSON.stringify(next), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    cacheControlMaxAge: 0, // status changes must be visible to pollers immediately
  });
  return next;
}

// Remove a file from the manifest by id. Returns the updated list.
export async function removeLibraryEntry(fileId: string): Promise<LibraryFile[]> {
  const current = await getLibrary();
  const next = current.filter((f) => f.file_id !== fileId);
  await put(MANIFEST_PATH, JSON.stringify(next), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
  });
  return next;
}
