# Hydration-Order Fix — Fresh A/B Benchmark (2026-07-05)

**Ticket:** mc-iiz. **Branch:** `fix/hydration-order-preservation` @ `a84c98e8`.
**Prior status:** parked 2026-06-10 (`mission-control/docs/research/lexical-hydration-port-2026-06-10.md`)
— fix complete and tested, but the MRR/Recall benchmark was blocked by a corpus
mismatch (a June 10 re-embed had indexed only 7.6% of observations; the old
46-query judgment set had 2/543 overlap with what was actually indexed).
Artifacts for this pass: `docs/reports/2026-07-05--hydration-order-benchmark/`.

## 1. Index coverage today (real numbers)

The 7.6% gap is closed. Three weeks of normal operation refilled the index:

| | 2026-06-10 (parked) | 2026-07-05 (today) |
|---|---|---|
| Observations in `claude-mem.db` | 20,849 | 30,665 |
| Distinct observations embedded in Chroma | 1,460 | 25,996 |
| **Coverage** | **7.6%** | **84.8%** |
| Old 46-query judgment set (543 IDs) overlap with index | 2/543 (0.4%) | 421/543 (77.5%) |

(Chroma embeds one vector per observation *field* — narrative, text, each
fact — so raw `embedding_metadata` rows read 167,596 for 26,274 distinct
observation ids; that is normal per-field chunking, not stale duplication.)

## 2. A structural finding that changes the merge calculus

Tracing the fix's code path against the **current** worker (the repo has
moved 202 commits past the `main` this branch diffs against — `main` is
pinned at `bb1f8694`, HEAD/`v13.6.1` is at `3b1014a3`) surfaces something the
original port didn't have visibility into:

- The fix touches exactly 5 files: `SessionStore.ts`, `preserve-id-order.ts`,
  `ChromaSearchStrategy.ts`, and their tests (`git diff main
  fix/hydration-order-preservation --stat`).
- `ChromaSearchStrategy` (and the `SearchOrchestrator` that owns it) is wired
  **only** into the `build_corpus` / `query_corpus` knowledge-agent feature
  (`worker-service.ts` → `CorpusBuilder` → `SearchOrchestrator`).
- The primary, everyday MCP tools — `search`, `observation_search`,
  `memory_search` — are routed through `SearchRoutes` → **`SearchManager.ts`**
  (a separate, independently-implemented hydration path), which is wired up
  first in `worker-service.ts` and registered as the live HTTP search
  surface.
- `SearchManager.ts` hardcodes `orderBy: 'date_desc'` at every Chroma-result
  hydration call site (8 occurrences, e.g. lines 101, 973, 1048, 1123, 1513)
  and contains **zero** references to `'relevance'` anywhere in the file.
  Independently, upstream had already added `'relevance'`/`preserveIdOrder`
  support to `SessionStore.ts` itself (commit `37c8988f`/`46d204ee`, fixing
  issue #2153, authored by a different contributor in April) — but nothing
  in `SearchManager.ts` ever asks for it.

**Consequence:** merging this branch as scoped fixes ordering correctness for
the corpus-builder path only. It does **not** change what `search` /
`observation_search` return today, because `SearchManager.ts` never routes
through the code this branch touches. The ticket's original goal — fix
ordering for semantic search generally — is only partially delivered by this
diff.

## 3. Fresh judgment set

Methodology in full: `2026-07-05--hydration-order-benchmark/METHODOLOGY.md`.
Short version: the live persistent Chroma index (`chroma-mcp==0.2.6`, exactly
as `ChromaMcpManager` spawns it) segfaults reading this DB's on-disk HNSW
segments under every locally available `chromadb` version (1.2.1 panics
cleanly instead — a Rust migration-table bounds error — 1.4.0/1.5.9 segfault).
Reproduces on a byte-identical copy on two separate volumes, so it's not a
disk-space artifact; matching `python3.13`-under-`uv` crash reports exist in
`~/Library/Logs/DiagnosticReports/` from 2026-07-01 through 07-04, so this is
a pre-existing local fragility, not something this benchmark introduced. Not
pursued further (out of scope) but worth a separate look.

Substitute: re-embedded the 25,996 live-indexed observations with
`chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2.ONNXMiniLM_L6_V2` (the
exact function `chroma-mcp` uses; confirmed stable standalone) and did exact
brute-force cosine ranking in place of Chroma's HNSW ANN. This only concerns
re-*ordering* of Chroma's candidate set (which the bug/fix are entirely
about), so holding the candidate SET fixed and computing both orderings
(`chroma_order` = similarity desc, `date_desc_order` = same set by
`created_at_epoch` desc) over it is a faithful, apples-to-apples substitute
for the crashing path. Also applied the same 90-day recency filter and
`CHROMA_BATCH_SIZE=100` candidate pool production uses.

**Query set:** 53 queries built the way the original 46-query set reads (real
topic phrases sampled from actual recent corpus activity across the dominant
`mission-control` project and several smaller ones); 1 (`swarm-viz
visualization rendering`) returned zero candidates in the 90-day window and
was dropped, leaving **52 judged queries**. I judged relevance myself (rubric
in METHODOLOGY.md: does this observation substantively address the query
topic, not just share keywords) against the top 15 candidates per query by
similarity — **773 candidate judgments, 482 unique relevant observation
IDs**, avg 9.5 relevant/query (comparable scale to the original 46-query
set's 543 IDs / ~11.8 avg).

## 4. A/B results (MRR@10 / Recall@10, 52 queries)

| Metric | `date_desc` (baseline / current bug) | `chroma`/relevance (fix) | Δ |
|---|---:|---:|---:|
| Avg MRR@10 | 0.3656 | 0.9776 | **+0.6119** |
| Avg Recall@10 | 0.2196 | 0.8659 | **+0.6463** |

Per-query: **0 regressions** on either metric across all 52 queries. MRR
improved on 41/52 (11 tied, both scoring 1.0 — the relevant doc already
happened to be recent), Recall improved on 51/52 (1 tied). Full per-query
table: `ab_results.json`.

**Top-1 result differs between orderings: 51/52 queries (98%).**

Caveat on reading the absolute `chroma_order` numbers: judgments were pooled
from the top of the similarity ranking (standard IR pooling practice, and
presumably how the original 46-query set was built too), so `chroma_order`'s
near-ceiling MRR/Recall is partly a construction artifact, not evidence the
fix makes search "near-perfect." The real, unbiased signal is the relative
comparison — both orderings share the identical candidate set, so the gap is
entirely attributable to discarding Chroma's ranking, which is exactly the
bug in question.

## 5. Fresh re-run of the original 7-query top-1 check

Re-ran the June 10 doc's exact 7 queries against today's data (same
methodology as above):

| Query | chroma_order top-1 | date_desc top-1 | Same? |
|---|---|---|---|
| agent messaging protocol | 30090 | 32641 | No |
| Telegram plugin polling | 17745 | 32386 | No |
| vault credentials access | 21762 | 31564 | No |
| deployment drift | 15683 | 30696 | No |
| weather METAR retrieval | 26740 | 27116 | No |
| KML format learning | 17107 | 32255 | No |
| FlightDatum aircraft registration | 17038 | 31466 | No |

**7/7 differ** (June 10 pass found 5/7 on the then-mismatched corpus).

## 6. Verdict

**The ordering fix is correct and its benefit is real and large** on today's
actual data: zero regressions, a +0.61 MRR / +0.65 Recall@10 swing, top-1
changes on 98% of queries. The correctness argument from the June 10 doc
(`WHERE id IN (...)` doesn't preserve order; Chroma's ranking was being
silently discarded) is no longer just theoretically sound — it's now
quantified against the live corpus.

**But scoped as-is, it lands on the wrong path to deliver that benefit.**
`ChromaSearchStrategy`/`SearchOrchestrator` only serves `build_corpus` /
`query_corpus`. The `search` / `observation_search` / `memory_search` tools
— what actually gets used day to day — go through `SearchManager.ts`, which
independently hardcodes `date_desc` and isn't touched by this diff.

**Recommendation:**

1. Merge `fix/hydration-order-preservation` as-is — it's a correct, tested,
   narrowly-scoped improvement to the code it touches, with no downside.
2. File a follow-up to port the identical treatment (`orderBy: 'relevance'`
   default + removing the hardcoded `date_desc` at the ~8 Chroma-hydration
   call sites) into `SearchManager.ts`. That is where the now-demonstrated
   +0.61 MRR benefit would actually reach users. Without step 2, step 1 is
   real but low-impact.

Merge/PR decision on both is Greg's per standing process; this report and
its data are ready either way.
