// Pinecone with integrated (hosted) embeddings - no OpenAI cost, free Starter tier.

import { Pinecone } from "@pinecone-database/pinecone";
import { config } from "./config";
import type { Hit } from "./types";
import type { AudioChunkRecord } from "@/types/pinecone";

let pc: Pinecone | null = null;

function client(): Pinecone {
  if (!pc) {
    if (!config.pineconeApiKey) throw new Error("PINECONE_API_KEY is not set.");
    pc = new Pinecone({ apiKey: config.pineconeApiKey });
  }
  return pc;
}

async function indexExists(name: string): Promise<boolean> {
  const list = await client().listIndexes();
  return (list.indexes ?? []).some((i) => i.name === name);
}

// Create the integrated-embeddings index on first use, then return a namespaced handle.
export async function ensureIndex() {
  const name = config.pineconeIndex;
  if (!(await indexExists(name))) {
    await client().createIndexForModel({
      name,
      cloud: config.pineconeCloud as "aws" | "gcp" | "azure",
      region: config.pineconeRegion,
      embed: {
        model: config.pineconeEmbedModel,
        fieldMap: { text: config.textField },
      },
      waitUntilReady: true,
    });
  }
  return client().index(name).namespace(config.pineconeNamespace);
}

export async function upsertChildren(records: AudioChunkRecord[], batchSize = 90) {
  const ns = await ensureIndex();
  for (let i = 0; i < records.length; i += batchSize) {
    const batch: AudioChunkRecord[] = records.slice(i, i + batchSize);
    // upsertRecords embeds `child_text` for us via the integrated model. The
    // AudioChunkRecord type enforces the metadata schema at the call boundary.
    await ns.upsertRecords({
      records: batch as unknown as Array<Record<string, string | number> & { _id: string }>,
    });
  }
}

export async function search(
  queryText: string,
  topK: number,
  fileIds?: string[],
  sessionIds?: string[]
): Promise<Hit[]> {
  const ns = await ensureIndex();
  const query: {
    topK: number;
    inputs: { text: string };
    filter?: Record<string, unknown>;
  } = { topK, inputs: { text: queryText } };
  // Scope to the caller's own workspace + the shared demo corpus (security
  // boundary), and to the subset of files they selected (top-level keys AND).
  const filter: Record<string, unknown> = {};
  if (sessionIds && sessionIds.length) filter.session_id = { $in: sessionIds };
  if (fileIds && fileIds.length) filter.file_id = { $in: fileIds };
  if (Object.keys(filter).length) query.filter = filter;
  const res = await ns.searchRecords({ query });

  const hits = res.result?.hits ?? [];
  return hits.map((h: any) => {
    const f = (h.fields ?? {}) as Record<string, unknown>;
    // Resilient across schema generations: prefer the flat start/end, falling
    // back to older child_*/parent_* fields so pre-revert vectors still play.
    const num = (...vals: unknown[]) => {
      for (const v of vals) {
        if (v != null && !Number.isNaN(Number(v))) return Number(v);
      }
      return 0;
    };
    return {
      _id: h._id,
      _score: h._score,
      file_path: f.file_path as string,
      title: f.title as string | undefined,
      child_text: (f.child_text as string) ?? (f.parent_text as string) ?? "",
      start_time_ms: num(f.start_time_ms, f.child_start_ms, f.parent_start_ms),
      end_time_ms: num(f.end_time_ms, f.child_end_ms, f.parent_end_ms),
      audio_type: f.audio_type as string,
    } as Hit;
  });
}

// Delete every child vector for a file. Serverless/Starter indexes don't support
// delete-by-metadata-filter, so we list IDs by their deterministic prefix
// (`${fileId}-c{n}`) and delete by ID in batches. Returns the count removed.
export async function deleteFileVectors(fileId: string): Promise<number> {
  const ns = await ensureIndex();
  const prefix = `${fileId}-`;

  const ids: string[] = [];
  let paginationToken: string | undefined;
  do {
    const res: any = await ns.listPaginated({ prefix, paginationToken });
    for (const v of res.vectors ?? []) if (v?.id) ids.push(v.id);
    paginationToken = res.pagination?.next;
  } while (paginationToken);

  for (let i = 0; i < ids.length; i += 1000) {
    await ns.deleteMany({ ids: ids.slice(i, i + 1000) });
  }
  return ids.length;
}
