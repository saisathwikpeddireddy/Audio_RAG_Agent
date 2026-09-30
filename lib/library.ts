// Per-session "library" of indexed files, persisted as a JSON manifest per
// session in Vercel Blob (`library/{sessionId}/manifest-{version}.json`). There's
// no database - this is enough to remember a visitor's files across reloads and
// to scope queries. The shared, read-only "demo" session is merged into every
// visitor's view so the app is never empty on first visit.
//
// Every write goes to a NEW path, and readers pick the newest version from
// list(). Overwriting one fixed path doesn't work: the Blob CDN keeps serving the
// old copy for minutes, so a file that finished indexing still read back as
// "processing" (and a stale read-modify-write could undo the update entirely).

import { put, list, del } from "@vercel/blob";
import type { LibraryFile } from "./types";
import { DEMO_SESSION } from "./sessionServer";

function manifestPrefix(sid: string): string {
  return `library/${sid}/manifest`;
}

// Version stamp from a manifest pathname. The pre-versioning fixed path
// (`manifest.json`) counts as the oldest possible version.
function manifestVersion(pathname: string): number {
  const m = pathname.match(/\/manifest-(\d+)\.json$/);
  return m ? Number(m[1]) : 0;
}

async function listManifests(sid: string) {
  const { blobs } = await list({ prefix: manifestPrefix(sid) });
  return blobs
    .filter((b) => /\/manifest(-\d+)?\.json$/.test(b.pathname))
    .sort((a, b) => manifestVersion(b.pathname) - manifestVersion(a.pathname));
}

async function readManifest(sid: string): Promise<LibraryFile[]> {
  try {
    const [newest] = await listManifests(sid);
    if (!newest) return [];
    const res = await fetch(newest.url, { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as LibraryFile[]) : [];
  } catch {
    return [];
  }
}

let lastVersion = 0;

async function writeManifest(sid: string, files: LibraryFile[]): Promise<void> {
  // Strictly increasing within this instance, even for writes in the same ms.
  const version = Math.max(Date.now(), lastVersion + 1);
  lastVersion = version;
  await put(`${manifestPrefix(sid)}-${version}.json`, JSON.stringify(files), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
  });
  // Drop superseded versions (only older ones, so a concurrent newer write from
  // another instance survives). Best-effort: a leftover old version is harmless.
  try {
    const stale = (await listManifests(sid)).filter((b) => manifestVersion(b.pathname) < version);
    if (stale.length) await del(stale.map((b) => b.url));
  } catch {
    // ignore
  }
}

// A visitor's view = the shared demo corpus (flagged read-only, in its curated
// order) followed by their own files in index order.
export async function getLibrary(sid: string | null): Promise<LibraryFile[]> {
  const [demo, own] = await Promise.all([
    readManifest(DEMO_SESSION),
    sid ? readManifest(sid) : Promise.resolve<LibraryFile[]>([]),
  ]);
  const rank = (f: LibraryFile) => f.demo?.order ?? Number.MAX_SAFE_INTEGER;
  return [
    ...demo
      .map((f) => ({ ...f, readOnly: true }))
      .sort((a, b) => rank(a) - rank(b) || a.indexed_at.localeCompare(b.indexed_at)),
    ...own
      .filter((f) => f.session_id !== DEMO_SESSION)
      .sort((a, b) => a.indexed_at.localeCompare(b.indexed_at)),
  ];
}

// Manifest updates are read-modify-write, so two in the same process (e.g. the
// demo corpus indexing three files in parallel) would drop each other's entries.
// Chain them per session so they apply one at a time.
const writeQueues = new Map<string, Promise<unknown>>();

function serialized<T>(sid: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(sid) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  writeQueues.set(sid, run);
  run.finally(() => {
    if (writeQueues.get(sid) === run) writeQueues.delete(sid);
  }).catch(() => {});
  return run;
}

// Upsert an entry by file_id into a session's manifest. Returns that session's list.
export function saveLibraryEntry(sid: string, entry: LibraryFile): Promise<LibraryFile[]> {
  return serialized(sid, async () => {
    const current = await readManifest(sid);
    const next = [...current.filter((f) => f.file_id !== entry.file_id), entry].sort((a, b) =>
      a.indexed_at.localeCompare(b.indexed_at)
    );
    await writeManifest(sid, next);
    return next;
  });
}

// Remove a file from a session's manifest. Returns that session's updated list.
export function removeLibraryEntry(sid: string, fileId: string): Promise<LibraryFile[]> {
  return serialized(sid, async () => {
    const current = await readManifest(sid);
    const next = current.filter((f) => f.file_id !== fileId);
    await writeManifest(sid, next);
    return next;
  });
}

// Read a single session's raw manifest (used by delete-ownership checks + cron).
export async function getSessionManifest(sid: string): Promise<LibraryFile[]> {
  return readManifest(sid);
}

// Every session id that currently has a manifest (used by the cleanup cron).
export async function listSessionIds(): Promise<string[]> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const r = await list({ prefix: "library/", cursor });
    for (const b of r.blobs) {
      const m = b.pathname.match(/^library\/([^/]+)\/manifest(?:-\d+)?\.json$/);
      if (m) ids.add(m[1]);
    }
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return [...ids];
}

// Delete a session's manifest (every version) outright (cron, after purging its contents).
export async function deleteManifest(sid: string): Promise<void> {
  try {
    const blobs = await listManifests(sid);
    if (blobs.length) await del(blobs.map((b) => b.url));
  } catch {
    // best-effort
  }
}
