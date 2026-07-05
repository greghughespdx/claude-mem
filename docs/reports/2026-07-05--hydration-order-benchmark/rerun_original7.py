#!/usr/bin/env python3
import json, time
import numpy as np
from chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 import ONNXMiniLM_L6_V2

vecs = np.load('/tmp/claude-mem-bench-20260705/corpus_vecs.npy')
ids = np.load('/tmp/claude-mem-bench-20260705/corpus_ids.npy')
norms = np.linalg.norm(vecs, axis=1, keepdims=True); norms[norms==0]=1e-9
unit = vecs / norms

meta = {}
with open('/tmp/claude-mem-bench-20260705/obs_corpus.jsonl') as f:
    for line in f:
        row = json.loads(line)
        meta[row['id']] = row

QUERIES = [
  "agent messaging protocol",
  "Telegram plugin polling",
  "vault credentials access",
  "deployment drift",
  "weather METAR retrieval",
  "KML format learning",
  "FlightDatum aircraft registration",
]

ef = ONNXMiniLM_L6_V2()
now_ms = max(r['created_at_epoch'] for r in meta.values())
RECENCY = 90*24*3600*1000

diffs = 0
for q in QUERIES:
    qvec = np.array(ef([q])[0], dtype=np.float32)
    qvec = qvec / (np.linalg.norm(qvec)+1e-9)
    sims = unit @ qvec
    order = np.argsort(-sims)
    cand_ids = ids[order].tolist()
    kept = [cid for cid in cand_ids if now_ms - meta[cid]['created_at_epoch'] <= RECENCY][:100]
    chroma_top1 = kept[0]
    date_desc_top1 = sorted(kept, key=lambda cid: meta[cid]['created_at_epoch'], reverse=True)[0]
    same = chroma_top1 == date_desc_top1
    if not same: diffs += 1
    print(f"{q!r}: chroma_top1={chroma_top1} ({meta[chroma_top1]['project']}) date_desc_top1={date_desc_top1} ({meta[date_desc_top1]['project']}) same={same}")

print(f"\n{diffs}/{len(QUERIES)} queries: different top-1 result between orderings")
