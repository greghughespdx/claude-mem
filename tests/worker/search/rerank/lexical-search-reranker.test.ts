import { describe, it, expect } from 'bun:test';
import { LexicalSearchReranker } from '../../../../src/services/worker/search/rerank/index.js';
import type { ObservationSearchResult } from '../../../../src/services/worker/search/types.js';

function observation(id: number, title: string, narrative: string): ObservationSearchResult {
  return {
    id,
    memory_session_id: `session-${id}`,
    project: 'test-project',
    text: narrative,
    type: 'discovery',
    title,
    subtitle: null,
    facts: '[]',
    narrative,
    concepts: '[]',
    files_read: '[]',
    files_modified: '[]',
    prompt_number: id,
    discovery_tokens: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    created_at_epoch: id
  };
}

describe('LexicalSearchReranker', () => {
  it('promotes candidates with stronger lexical matches while preserving Chroma as tie-breaker', () => {
    const reranker = new LexicalSearchReranker();
    const candidates = [
      {
        id: 1,
        type: 'observation' as const,
        item: observation(1, 'General deployment notes', 'Release checklist'),
        chromaRank: 0
      },
      {
        id: 2,
        type: 'observation' as const,
        item: observation(2, 'Telegram plugin polling failure', 'getUpdates slot was stolen'),
        chromaRank: 1
      }
    ];

    const reranked = reranker.rerank('telegram getUpdates polling', candidates);

    expect(reranked.map(candidate => candidate.id)).toEqual([2, 1]);
  });

  it('keeps Chroma order for lexical ties', () => {
    const reranker = new LexicalSearchReranker();
    const candidates = [
      {
        id: 1,
        type: 'observation' as const,
        item: observation(1, 'Alpha', 'Shared term'),
        chromaRank: 0
      },
      {
        id: 2,
        type: 'observation' as const,
        item: observation(2, 'Beta', 'Shared term'),
        chromaRank: 1
      }
    ];

    const reranked = reranker.rerank('shared term', candidates);

    expect(reranked.map(candidate => candidate.id)).toEqual([1, 2]);
  });
});

