#!/usr/bin/env python3
import json
import time
import numpy as np
from chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 import ONNXMiniLM_L6_V2

ef = ONNXMiniLM_L6_V2()

ids = []
projects = []
epochs = []
docs = []
with open('/tmp/claude-mem-bench-20260705/obs_corpus.jsonl') as f:
    for line in f:
        row = json.loads(line)
        ids.append(row['id'])
        projects.append(row['project'])
        epochs.append(row['created_at_epoch'])
        docs.append(row['doc'] if row['doc'].strip() else 'empty')

print(f"Embedding {len(docs)} observations...", flush=True)
t0 = time.time()
BATCH = 256
vecs = []
for i in range(0, len(docs), BATCH):
    batch = docs[i:i+BATCH]
    vecs.extend(ef(batch))
    if (i // BATCH) % 10 == 0:
        print(f"  {i}/{len(docs)}  elapsed={time.time()-t0:.1f}s", flush=True)

vecs = np.array(vecs, dtype=np.float32)
print("done embedding, shape:", vecs.shape, "elapsed:", time.time() - t0, flush=True)

np.save('/tmp/claude-mem-bench-20260705/corpus_vecs.npy', vecs)
np.save('/tmp/claude-mem-bench-20260705/corpus_ids.npy', np.array(ids, dtype=np.int64))
with open('/tmp/claude-mem-bench-20260705/corpus_meta.json', 'w') as f:
    json.dump({'ids': ids, 'projects': projects, 'epochs': epochs}, f)

print("saved.", flush=True)
