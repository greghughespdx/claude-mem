/**
 * SearchManager - Chroma relevance-order hydration
 *
 * SearchManager.ts is the module serving the primary `search`,
 * `search_observations`, `search_sessions`, `search_user_prompts`, `timeline`,
 * and `get_timeline_by_query` MCP tools/routes. Unlike ChromaSearchStrategy
 * (used only by the build_corpus/query_corpus knowledge-agent path), it talks
 * to SessionStore directly rather than through the strategy layer, and it
 * hardcoded `orderBy: 'date_desc'` at every Chroma-fed hydration call site --
 * silently discarding Chroma's relevance ranking (see mc-iiz, the
 * ChromaSearchStrategy hydration-order fix and its benchmark in
 * docs/reports/2026-07-05--hydration-order-benchmark/).
 *
 * This suite asserts, at the same mock-boundary as
 * tests/worker/search/strategies/chroma-search-strategy.test.ts, that every
 * semantic-search call site now defaults to `orderBy: 'relevance'` while an
 * explicit caller-supplied `orderBy` (a genuinely chronological ask) is still
 * honored. Pure ID-lookup call sites (e.g. resolving a single known session ID
 * for a timeline anchor) are untouched by design and are not exercised here.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// searchObservations()/searchSessions()/searchUserPrompts() render results
// through FormattingService, which reads observation-type icons off the
// ModeManager singleton. bun test runs every file in one process and
// mock.module() is global for the run, so relying on the real ModeManager
// (loadMode()) is order-dependent -- other suites (e.g.
// tests/worker/search/result-formatter.test.ts) already replace this module
// with a stub. Do the same here, consistent with that established pattern,
// and import the class-under-test only after the mock is registered.
mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [{ id: 'decision', icon: 'D' }],
        observation_concepts: [],
      }),
      getObservationTypes: () => [{ id: 'decision', icon: 'D' }],
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = { decision: 'D' };
        return icons[type] || '?';
      },
      getWorkEmoji: () => 'W',
    }),
  },
}));

import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../../src/services/sqlite/types.js';

const recentEpoch = Date.now() - 1000 * 60 * 60 * 24; // 1 day ago (within 90-day window)

const mockObservation: ObservationSearchResult = {
  id: 10,
  memory_session_id: 'session-123',
  project: 'test-project',
  text: 'Test observation text',
  type: 'decision',
  title: 'Test Decision',
  subtitle: 'A test subtitle',
  facts: '["fact1", "fact2"]',
  narrative: 'Test narrative',
  concepts: '["concept1", "concept2"]',
  files_read: '["file1.ts"]',
  files_modified: '["file2.ts"]',
  prompt_number: 1,
  discovery_tokens: 100,
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: recentEpoch
} as ObservationSearchResult;

const mockSession: SessionSummarySearchResult = {
  id: 20,
  memory_session_id: 'session-123',
  project: 'test-project',
  request: 'Test request',
  investigated: 'Test investigated',
  learned: 'Test learned',
  completed: 'Test completed',
  next_steps: 'Test next steps',
  files_read: '["file1.ts"]',
  files_edited: '["file2.ts"]',
  notes: 'Test notes',
  prompt_number: 1,
  discovery_tokens: 500,
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: recentEpoch
} as SessionSummarySearchResult;

const mockPrompt: UserPromptSearchResult = {
  id: 30,
  content_session_id: 'content-session-123',
  prompt_number: 1,
  prompt_text: 'Test prompt text',
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: recentEpoch
} as UserPromptSearchResult;

const ALL_CHROMA_RESULTS = {
  ids: [10, 20, 30],
  distances: [0.1, 0.2, 0.3],
  metadatas: [
    { sqlite_id: 10, doc_type: 'observation', created_at_epoch: recentEpoch },
    { sqlite_id: 20, doc_type: 'session_summary', created_at_epoch: recentEpoch },
    { sqlite_id: 30, doc_type: 'user_prompt', created_at_epoch: recentEpoch }
  ]
};

/**
 * Several call sites (searchObservations/Sessions/UserPrompts, timeline(),
 * getTimelineByQuery()) scope the Chroma query itself with a doc_type where
 * filter, so production Chroma only ever returns matches of that one type.
 * Mirror that here instead of hardcoding a single-type fixture per test.
 */
function extractDocType(where: any): string | undefined {
  if (!where) return undefined;
  if (where.doc_type) return where.doc_type;
  if (Array.isArray(where.$and)) {
    const hit = where.$and.find((clause: any) => clause?.doc_type);
    return hit?.doc_type;
  }
  return undefined;
}

function makeChromaResults(docType?: string) {
  if (!docType) return ALL_CHROMA_RESULTS;
  const keepIdxs = ALL_CHROMA_RESULTS.metadatas
    .map((meta, idx) => (meta.doc_type === docType ? idx : -1))
    .filter(idx => idx !== -1);
  return {
    ids: keepIdxs.map(idx => ALL_CHROMA_RESULTS.ids[idx]),
    distances: keepIdxs.map(idx => ALL_CHROMA_RESULTS.distances[idx]),
    metadatas: keepIdxs.map(idx => ALL_CHROMA_RESULTS.metadatas[idx])
  };
}

describe('SearchManager - relevance-order hydration (mc-iiz SearchManager port)', () => {
  let manager: SearchManager;
  let mockSessionSearch: any;
  let mockSessionStore: any;
  let mockChromaSync: any;

  beforeEach(() => {
    mockChromaSync = {
      queryChroma: mock((_query: string, _limit: number, where?: any) =>
        Promise.resolve(makeChromaResults(extractDocType(where)))
      )
    };

    mockSessionStore = {
      getObservationsByIds: mock(() => [mockObservation]),
      getSessionSummariesByIds: mock(() => [mockSession]),
      getUserPromptsByIds: mock(() => [mockPrompt]),
      // Empty timeline window => timeline()/getTimelineByQuery() short-circuit
      // before reaching text rendering, keeping this suite at the hydration
      // boundary (same scope as chroma-search-strategy.test.ts).
      getTimelineAroundObservation: mock(() => ({ observations: [], sessions: [], prompts: [] }))
    };

    mockSessionSearch = {
      searchObservations: mock(() => []),
      searchSessions: mock(() => []),
      searchUserPrompts: mock(() => [])
    };

    manager = new SearchManager(
      mockSessionSearch,
      mockSessionStore,
      mockChromaSync,
      new FormattingService(),
      new TimelineService()
    );
  });

  describe('search() - unified search tool, Chroma semantic path', () => {
    it('defaults observation hydration to relevance order when a query is present', async () => {
      await manager.search({ query: 'test query', format: 'json' });

      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith(
        [10],
        expect.objectContaining({ orderBy: 'relevance' })
      );
    });

    it('defaults session hydration to relevance order when a query is present', async () => {
      await manager.search({ query: 'test query', format: 'json' });

      expect(mockSessionStore.getSessionSummariesByIds).toHaveBeenCalledWith(
        [20],
        expect.objectContaining({ orderBy: 'relevance' })
      );
    });

    it('defaults prompt hydration to relevance order when a query is present', async () => {
      await manager.search({ query: 'test query', format: 'json' });

      expect(mockSessionStore.getUserPromptsByIds).toHaveBeenCalledWith(
        [30],
        expect.objectContaining({ orderBy: 'relevance' })
      );
    });

    it('honors an explicit caller orderBy override (chronological ask)', async () => {
      await manager.search({ query: 'test query', orderBy: 'date_desc', format: 'json' });

      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith(
        [10],
        expect.objectContaining({ orderBy: 'date_desc' })
      );
      expect(mockSessionStore.getSessionSummariesByIds).toHaveBeenCalledWith(
        [20],
        expect.objectContaining({ orderBy: 'date_desc' })
      );
      expect(mockSessionStore.getUserPromptsByIds).toHaveBeenCalledWith(
        [30],
        expect.objectContaining({ orderBy: 'date_desc' })
      );
    });
  });

  describe('searchObservations() - search_observations tool', () => {
    it('defaults to relevance order when a query is present', async () => {
      await manager.searchObservations({ query: 'test query' });

      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith(
        [10],
        expect.objectContaining({ orderBy: 'relevance' })
      );
    });

    it('honors an explicit caller orderBy override', async () => {
      await manager.searchObservations({ query: 'test query', orderBy: 'date_asc' });

      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith(
        [10],
        expect.objectContaining({ orderBy: 'date_asc' })
      );
    });
  });

  describe('searchSessions() - search_sessions tool', () => {
    it('defaults to relevance order when a query is present', async () => {
      await manager.searchSessions({ query: 'test query' });

      expect(mockSessionStore.getSessionSummariesByIds).toHaveBeenCalledWith(
        [20],
        expect.objectContaining({ orderBy: 'relevance' })
      );
    });

    it('honors an explicit caller orderBy override', async () => {
      await manager.searchSessions({ query: 'test query', orderBy: 'date_desc' });

      expect(mockSessionStore.getSessionSummariesByIds).toHaveBeenCalledWith(
        [20],
        expect.objectContaining({ orderBy: 'date_desc' })
      );
    });
  });

  describe('searchUserPrompts() - search_user_prompts tool', () => {
    it('defaults to relevance order when a query is present', async () => {
      await manager.searchUserPrompts({ query: 'test query' });

      expect(mockSessionStore.getUserPromptsByIds).toHaveBeenCalledWith(
        [30],
        expect.objectContaining({ orderBy: 'relevance' })
      );
    });

    it('honors an explicit caller orderBy override', async () => {
      await manager.searchUserPrompts({ query: 'test query', orderBy: 'date_asc' });

      expect(mockSessionStore.getUserPromptsByIds).toHaveBeenCalledWith(
        [30],
        expect.objectContaining({ orderBy: 'date_asc' })
      );
    });
  });

  describe('timeline() - query-based anchor selection (MODE 1)', () => {
    it('selects the timeline anchor by Chroma relevance, not recency', async () => {
      await manager.timeline({ query: 'test query' });

      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith(
        [10],
        expect.objectContaining({ orderBy: 'relevance', limit: 1 })
      );
    });
  });

  describe('getTimelineByQuery() - get_timeline_by_query tool', () => {
    it('ranks the single auto-mode anchor by Chroma relevance', async () => {
      await manager.getTimelineByQuery({ query: 'test query', mode: 'auto' });

      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith(
        [10],
        expect.objectContaining({ orderBy: 'relevance', limit: 1 })
      );
    });

    it('ranks interactive-mode candidates by Chroma relevance', async () => {
      await manager.getTimelineByQuery({ query: 'test query', mode: 'interactive', limit: 5 });

      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith(
        [10],
        expect.objectContaining({ orderBy: 'relevance', limit: 5 })
      );
    });
  });
});

/**
 * decisions()/changes()/howItWorks() - resort-before-limit truncation
 *
 * These three handlers (4 call sites total) rank IDs by Chroma relevance in
 * JS, then hydrate via sessionStore.getObservationsByIds(rankedIds, { limit })
 * WITHOUT passing `orderBy: 'relevance'`. getObservationsByIds defaults to
 * `orderBy: 'date_desc'`, which means the *real* SQLite call applies
 * `ORDER BY created_at_epoch DESC LIMIT <n>` -- truncating by recency BEFORE
 * the caller's subsequent `.sort()` by Chroma rank ever runs. A true top
 * semantic match that happens to be older than `limit` other matches is
 * dropped before the rank-based sort sees it.
 *
 * The fake getObservationsByIds below reproduces that real SQL behavior
 * (date-desc order + limit when orderBy != 'relevance'; rank-preserving
 * order + limit applied after sorting when orderBy === 'relevance') so the
 * truncation bug manifests the same way it does against the real database.
 */
describe('decisions()/changes()/howItWorks() - resort-before-limit truncation (mc-iiz follow-on)', () => {
  const oldEpoch = Date.now() - 1000 * 60 * 60 * 24 * 30; // 30 days ago -- oldest
  const midEpoch = Date.now() - 1000 * 60 * 60 * 24 * 5;  // 5 days ago
  const newEpoch = Date.now() - 1000 * 60 * 60 * 24 * 1;  // 1 day ago -- newest

  // Chroma relevance order (best match first) is [1, 2, 3]. Observation 1 is
  // the single best semantic match but the OLDEST by date; observation 3 is
  // the weakest semantic match but the NEWEST by date. A date-desc truncation
  // to limit=2 keeps {3, 2} and drops the true top match (1).
  const obsTopMatch: ObservationSearchResult = {
    ...mockObservation, id: 1, title: 'Top Chroma Match', created_at_epoch: oldEpoch
  };
  const obsMid: ObservationSearchResult = {
    ...mockObservation, id: 2, title: 'Mid Relevance Mid Date', created_at_epoch: midEpoch
  };
  const obsWeakButNewest: ObservationSearchResult = {
    ...mockObservation, id: 3, title: 'Weakest Match Newest Date', created_at_epoch: newEpoch
  };

  const observationsById: Record<number, ObservationSearchResult> = {
    1: obsTopMatch,
    2: obsMid,
    3: obsWeakButNewest
  };
  const RANKED_IDS = [1, 2, 3];

  function fakeGetObservationsByIds() {
    return mock((ids: number[], options: any = {}) => {
      const rows = ids.map(id => observationsById[id]).filter(Boolean);

      if (options.orderBy === 'relevance') {
        // Real preserveIdOrder() behavior: sort by caller-provided rank,
        // THEN apply the limit.
        const rank = new Map(ids.map((id, i) => [id, i]));
        const sorted = [...rows].sort((a, b) =>
          (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        );
        return typeof options.limit === 'number' ? sorted.slice(0, options.limit) : sorted;
      }

      // Real SQL default behavior: ORDER BY created_at_epoch DESC, with the
      // LIMIT applied in the SQL itself -- i.e. BEFORE any caller-side
      // relevance re-sort can run.
      const dateDesc = [...rows].sort((a, b) => b.created_at_epoch - a.created_at_epoch);
      return typeof options.limit === 'number' ? dateDesc.slice(0, options.limit) : dateDesc;
    });
  }

  let manager: SearchManager;

  beforeEach(() => {
    const mockChromaSync = {
      queryChroma: mock(() => Promise.resolve({
        ids: RANKED_IDS,
        distances: [0.05, 0.2, 0.3],
        metadatas: RANKED_IDS.map(id => ({
          sqlite_id: id,
          doc_type: 'observation',
          created_at_epoch: observationsById[id].created_at_epoch
        }))
      }))
    };

    const mockSessionStore = {
      getObservationsByIds: fakeGetObservationsByIds()
    };

    const mockSessionSearch = {
      findByType: mock(() => [obsTopMatch, obsMid, obsWeakButNewest]),
      findByConcept: mock(() => [obsTopMatch, obsMid, obsWeakButNewest])
    };

    manager = new SearchManager(
      mockSessionSearch as any,
      mockSessionStore as any,
      mockChromaSync as any,
      new FormattingService(),
      new TimelineService()
    );
  });

  it('decisions() query path preserves the top Chroma match under a limit', async () => {
    const result = await manager.decisions({ query: 'test query', limit: 2 });
    expect(result.content[0].text).toContain('Top Chroma Match');
  });

  it('decisions() no-query metadata+ranking path preserves the top Chroma match under a limit', async () => {
    const result = await manager.decisions({ limit: 2 });
    expect(result.content[0].text).toContain('Top Chroma Match');
  });

  it('changes() preserves the top Chroma match under a limit', async () => {
    const result = await manager.changes({ limit: 2 });
    expect(result.content[0].text).toContain('Top Chroma Match');
  });

  it('howItWorks() preserves the top Chroma match under a limit', async () => {
    const result = await manager.howItWorks({ limit: 2 });
    expect(result.content[0].text).toContain('Top Chroma Match');
  });
});
