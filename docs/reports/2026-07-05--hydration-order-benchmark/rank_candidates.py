#!/usr/bin/env python3
"""
For each query: embed it, brute-force cosine-similarity rank against the
cached corpus vectors (a faithful re-embedding of the same MiniLM model
Chroma uses), apply the same 90-day recency filter and CHROMA_BATCH_SIZE=100
candidate-pool size that production's ChromaSearchStrategy/SearchManager use,
then emit:
  - chroma_order: ids sorted by similarity desc (the FIX behavior)
  - date_desc_order: same candidate SET sorted by created_at_epoch desc (the BASELINE bug behavior)
  - judge_pack: compact title/snippet text for the top 15 (chroma order) for manual judging
"""
import json
import time
import numpy as np
from chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 import ONNXMiniLM_L6_V2

CORPUS_VECS = "/tmp/claude-mem-bench-20260705/corpus_vecs.npy"
CORPUS_IDS = "/tmp/claude-mem-bench-20260705/corpus_ids.npy"
CORPUS_JSONL = "/tmp/claude-mem-bench-20260705/obs_corpus.jsonl"
QUERIES = "/tmp/claude-mem-bench-20260705/queries.json"
OUT = "/tmp/claude-mem-bench-20260705/candidates.json"

CHROMA_BATCH_SIZE = 100
RECENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
JUDGE_TOPN = 15

# "now" for the recency filter: use the max created_at_epoch in the corpus
# (mirrors "most recent data available" rather than wall-clock, since this is
# a point-in-time snapshot of the live DB).
def main():
    vecs = np.load(CORPUS_VECS)
    ids = np.load(CORPUS_IDS)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1e-9
    unit = vecs / norms

    meta = {}
    with open(CORPUS_JSONL) as f:
        for line in f:
            row = json.loads(line)
            meta[row['id']] = row

    now_ms = max(row['created_at_epoch'] for row in meta.values())
    print(f"using now_ms={now_ms} ({time.strftime('%Y-%m-%d', time.gmtime(now_ms/1000))})")

    ef = ONNXMiniLM_L6_V2()
    queries = json.load(open(QUERIES))

    results = {}
    for q in queries:
        qvec = np.array(ef([q])[0], dtype=np.float32)
        qvec = qvec / (np.linalg.norm(qvec) + 1e-9)
        sims = unit @ qvec  # cosine similarity, higher = more similar
        order = np.argsort(-sims)[:CHROMA_BATCH_SIZE]  # top-100 like Chroma n_results
        cand_ids = ids[order].tolist()
        cand_sims = sims[order].tolist()

        # recency filter (matches production's 90-day window applied post-Chroma-query)
        kept = [(cid, cs) for cid, cs in zip(cand_ids, cand_sims)
                if now_ms - meta[cid]['created_at_epoch'] <= RECENCY_WINDOW_MS]

        chroma_order = [cid for cid, _ in kept]  # already sorted by similarity desc
        date_desc_order = sorted([cid for cid, _ in kept],
                                  key=lambda cid: meta[cid]['created_at_epoch'], reverse=True)

        judge_pack = []
        for cid, cs in kept[:JUDGE_TOPN]:
            row = meta[cid]
            snippet = row['doc'][:220].replace('\n', ' ')
            judge_pack.append({
                'id': cid, 'sim': round(cs, 4), 'project': row['project'],
                'snippet': snippet
            })

        results[q] = {
            'candidate_count': len(kept),
            'chroma_order': chroma_order,
            'date_desc_order': date_desc_order,
            'judge_pack': judge_pack
        }
        print(f"{q!r}: {len(kept)} candidates in 90d window (of {len(cand_ids)} raw)")

    json.dump(results, open(OUT, 'w'), indent=2)
    print("wrote", OUT)

if __name__ == "__main__":
    main()
