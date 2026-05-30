// Pinecone with integrated (hosted) embeddings — no OpenAI cost, free Starter tier.

import { Pinecone } from "@pinecone-database/pinecone";
import { config } from "./config";
import type { ChildRecord, Hit } from "./types";

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

export async function upsertChildren(records: ChildRecord[], batchSize = 90) {
  const ns = await ensureIndex();
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    // upsertRecords embeds `child_text` for us via the integrated model.
    await ns.upsertRecords({
      records: batch as unknown as Array<Record<string, string | number> & { _id: string }>,
    });
  }
}

export async function search(queryText: string, topK: number, fileIds?: string[]): Promise<Hit[]> {
  const ns = await ensureIndex();
  const query: {
    topK: number;
    inputs: { text: string };
    filter?: Record<string, unknown>;
  } = { topK, inputs: { text: queryText } };
  // Scope the search to a subset of files when the user selects sources.
  if (fileIds && fileIds.length) {
    query.filter = { file_id: { $in: fileIds } };
  }
  const res = await ns.searchRecords({ query });

  const hits = res.result?.hits ?? [];
  return hits.map((h: any) => {
    const f = h.fields ?? {};
    return {
      _id: h._id,
      _score: h._score,
      file_path: f.file_path,
      parent_text: f.parent_text,
      child_text: f.child_text,
      start_time_ms: Number(f.start_time_ms),
      end_time_ms: Number(f.end_time_ms),
      audio_type: f.audio_type,
    } as Hit;
  });
}
