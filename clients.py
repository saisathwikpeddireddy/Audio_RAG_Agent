"""Thin wrappers around the cloud services + a tiny retry helper.

This module hides the provider differences (Pinecone integrated embeddings
vs. OpenAI embeddings) behind two functions: ``upsert_children`` and
``search``. The rest of the pipeline never has to care which is active.
"""

import time
from typing import Callable, List, Dict, Any

import config


def with_retries(fn: Callable, *args, retries: int = 4, base_delay: float = 2.0, **kwargs):
    """Run ``fn`` with exponential backoff on transient/rate-limit errors."""
    last_exc = None
    for attempt in range(retries + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - we want to retry broadly on API errors
            last_exc = exc
            msg = str(exc).lower()
            transient = any(
                tok in msg
                for tok in ("rate limit", "429", "timeout", "timed out", "503", "502", "overloaded", "connection")
            )
            if attempt == retries or not transient:
                raise
            delay = base_delay * (2 ** attempt)
            print(f"  [retry {attempt + 1}/{retries}] {exc} -> waiting {delay:.0f}s")
            time.sleep(delay)
    raise last_exc  # pragma: no cover


# --------------------------------------------------------------------------
# Pinecone
# --------------------------------------------------------------------------
_pc = None


def get_pinecone():
    global _pc
    if _pc is None:
        from pinecone import Pinecone

        config.require("PINECONE_API_KEY")
        _pc = Pinecone(api_key=config.PINECONE_API_KEY)
    return _pc


def _index_exists(pc, name: str) -> bool:
    return name in [i["name"] for i in pc.list_indexes()]


def ensure_index():
    """Create the index if needed and return a handle to it.

    For ``EMBED_PROVIDER=pinecone`` we create an *integrated* index so Pinecone
    embeds text for us. For ``openai`` we create a plain dense index and embed
    locally before upserting.
    """
    pc = get_pinecone()
    name = config.PINECONE_INDEX_NAME

    if not _index_exists(pc, name):
        if config.EMBED_PROVIDER == "pinecone":
            print(f"Creating Pinecone integrated index '{name}' ({config.PINECONE_EMBED_MODEL})...")
            pc.create_index_for_model(
                name=name,
                cloud=config.PINECONE_CLOUD,
                region=config.PINECONE_REGION,
                embed={
                    "model": config.PINECONE_EMBED_MODEL,
                    "field_map": {"text": config.TEXT_FIELD},
                },
            )
        else:
            from pinecone import ServerlessSpec

            print(f"Creating Pinecone dense index '{name}' (OpenAI {config.OPENAI_EMBED_MODEL})...")
            pc.create_index(
                name=name,
                dimension=1536,  # text-embedding-3-small
                metric="cosine",
                spec=ServerlessSpec(cloud=config.PINECONE_CLOUD, region=config.PINECONE_REGION),
            )
        # Wait for the index to become ready.
        while not pc.describe_index(name).status["ready"]:
            time.sleep(1)

    return pc.Index(name)


# --------------------------------------------------------------------------
# OpenAI embeddings (only used when EMBED_PROVIDER=openai)
# --------------------------------------------------------------------------
_openai = None


def _get_openai():
    global _openai
    if _openai is None:
        from openai import OpenAI

        config.require("OPENAI_API_KEY")
        _openai = OpenAI(api_key=config.OPENAI_API_KEY)
    return _openai


def _embed_openai(texts: List[str]) -> List[List[float]]:
    client = _get_openai()
    resp = with_retries(
        client.embeddings.create, model=config.OPENAI_EMBED_MODEL, input=texts
    )
    return [d.embedding for d in resp.data]


# --------------------------------------------------------------------------
# Unified upsert / search
# --------------------------------------------------------------------------
def upsert_children(index, records: List[Dict[str, Any]], batch_size: int = 90) -> None:
    """Upsert child records. ``records`` carry ``_id`` + metadata + child_text."""
    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        if config.EMBED_PROVIDER == "pinecone":
            with_retries(index.upsert_records, config.PINECONE_NAMESPACE, batch)
        else:
            vectors = _embed_openai([r[config.TEXT_FIELD] for r in batch])
            payload = [
                {
                    "id": r["_id"],
                    "values": vec,
                    "metadata": {k: v for k, v in r.items() if k != "_id"},
                }
                for r, vec in zip(batch, vectors)
            ]
            with_retries(index.upsert, vectors=payload, namespace=config.PINECONE_NAMESPACE)
        print(f"  upserted {min(i + batch_size, len(records))}/{len(records)} child vectors")


def search(index, query_text: str, top_k: int) -> List[Dict[str, Any]]:
    """Return a list of hit dicts with the metadata fields flattened in."""
    if config.EMBED_PROVIDER == "pinecone":
        res = with_retries(
            index.search,
            namespace=config.PINECONE_NAMESPACE,
            query={"inputs": {"text": query_text}, "top_k": top_k},
        )
        hits = []
        for h in res["result"]["hits"]:
            fields = dict(h.get("fields", {}))
            fields["_id"] = h.get("_id")
            fields["_score"] = h.get("_score")
            hits.append(fields)
        return hits

    # OpenAI path: embed the query, then query by vector.
    vec = _embed_openai([query_text])[0]
    res = with_retries(
        index.query,
        vector=vec,
        top_k=top_k,
        namespace=config.PINECONE_NAMESPACE,
        include_metadata=True,
    )
    hits = []
    for m in res["matches"]:
        fields = dict(m.get("metadata", {}))
        fields["_id"] = m.get("id")
        fields["_score"] = m.get("score")
        hits.append(fields)
    return hits
