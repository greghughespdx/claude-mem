# Fresh judgment set methodology (2026-07-05)

## Why re-embedding instead of querying the live persistent Chroma index

The live `chroma-mcp==0.2.6` subprocess (spawned via `uvx`, exactly as
`ChromaMcpManager` does in production) was reproduced against a **copy** of
`~/.claude-mem/chroma` for read-only querying. `chroma_query_documents` calls
segfaulted (SIGSEGV) consistently across every cached `chromadb` version
tried (1.2.1 panics cleanly with a Rust slice-bounds error on the `migrations`
table instead of segfaulting; 1.4.0 and 1.5.9 segfault). This reproduces on a
byte-identical copy of the data dir, on both the internal SSD and the `500-1`
external volume, so it is not a disk-space artifact. Root cause not further
pursued (out of scope) but is itself worth flagging: something about this
Mac's onnxruntime/chromadb native stack crashes on read against this exact
on-disk index outside the long-running Node worker process. Prior crash
reports for `python3.13` parented by `uv` exist in
`~/Library/Diagnostics/DiagnosticReports/` from 2026-07-01 through 07-04,
so this is a pre-existing, recurring local fragility, not something newly
introduced by this benchmark.

**Substitute: brute-force re-embedding.** `ChromaSync.queryChroma` and the
bug/fix under test only concern **re-ordering of the same candidate ID set**
returned by Chroma — the fix does not change which candidates Chroma selects.
So the benchmark:

1. Re-embeds the current, live-indexed observation corpus (25,996 observations
   — the same set confirmed present in the live Chroma index, see
   INDEX-COVERAGE) using `chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2
   .ONNXMiniLM_L6_V2` — the exact embedding function `chroma-mcp` uses
   (confirmed working standalone, isolated from the crashing `PersistentClient`
   path). One document per observation: `title + subtitle + narrative + text +
   join(facts)`, truncated to 4000 chars (a coarser chunking than production's
   per-field embedding, disclosed as a simplification — see caveats below).
2. For each query, embeds the query with the same function, ranks the corpus
   by cosine similarity, takes the top 100 (`SEARCH_CONSTANTS.CHROMA_BATCH_SIZE`
   in the app), applies the same 90-day recency filter both `ChromaSearchStrategy`
   and `SearchManager` apply post-query.
3. That filtered candidate SET is fixed. Two orderings are computed over the
   *identical* set: `chroma_order` (similarity desc — the FIX's intended
   behavior) and `date_desc_order` (the BASELINE bug's actual behavior).

This isolates exactly the variable the fix changes (order), holding the
candidate set constant, which is the only fair way to A/B an ordering-only
change.

**Caveats:**
- Single combined per-observation embedding vs. production's per-field
  (narrative/text/each fact) embedding + best-chunk dedup. This is coarser;
  it can shift a few borderline rankings but does not change the qualitative
  comparison (chroma-similarity order vs. date-desc order), since both
  conditions use the exact same underlying similarity signal.
  entity)
- Brute-force cosine is exact NN, not HNSW-approximate NN. Exact search is a
  reasonable proxy for "what Chroma's similarity ranking intends," if
  anything slightly favorable to demonstrating the ordering signal exists,
  not to the fix specifically (both conditions share it).
- Session summaries and user prompts are out of scope for this benchmark;
  only `doc_type='observation'` is covered (matches the original 46-query
  judgment set, which was also observation-only).

## Judgment rubric (I am the judge)

For each query, the top 15 candidates by similarity were read (title +
~220-char snippet of title/subtitle/narrative/text/facts) and marked
**relevant** if a person issuing that exact query, in the context of this
homelab/mission-control corpus, would consider the observation a useful,
on-topic hit — i.e. it directly describes, resolves, or documents the
queried topic. Marked **not relevant** if the match is superficial keyword
overlap, wrong subject entirely, or only tangential (mentions the topic in
passing without being substantively about it). This mirrors the standard the
original 46-query set appears to have used (topic-substance match, not
string match).
