import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { logger } from '../../../../utils/logger.js';
import type { RerankCandidate, RerankOptions, RerankScoredCandidate, RerankableSearchResult } from './types.js';

const TOKEN_RE = /[a-z0-9][a-z0-9_-]*/g;
const DEFAULT_TIMEOUT_MS = 25;

export class RerankTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Lexical rerank exceeded ${timeoutMs}ms budget`);
    this.name = 'RerankTimeoutError';
  }
}

export class LexicalSearchReranker {
  rerank<T extends RerankableSearchResult>(
    query: string,
    candidates: RerankCandidate<T>[],
    options: Partial<RerankOptions> = {}
  ): RerankScoredCandidate<T>[] {
    if (candidates.length <= 1) {
      return candidates.map(candidate => ({
        ...candidate,
        lexicalScore: 1
      }));
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const queryTokens = tokenize(query);
    const queryPhrases = buildPhrases(queryTokens);

    if (queryTokens.length === 0) {
      return candidates.map(candidate => ({
        ...candidate,
        lexicalScore: chromaPrior(candidate.chromaRank, candidates.length)
      }));
    }

    return candidates
      .map(candidate => {
        if (Date.now() > deadline) {
          throw new RerankTimeoutError(timeoutMs);
        }

        return {
          ...candidate,
          lexicalScore: this.scoreCandidate(candidate, queryTokens, queryPhrases, candidates.length)
        };
      })
      .sort((a, b) => {
        const scoreDelta = b.lexicalScore - a.lexicalScore;
        return scoreDelta !== 0 ? scoreDelta : a.chromaRank - b.chromaRank;
      });
  }

  scoreCandidate(
    candidate: RerankCandidate,
    queryTokens: string[],
    queryPhrases: string[],
    candidateCount: number
  ): number {
    const fields = extractWeightedFields(candidate.item);
    let score = chromaPrior(candidate.chromaRank, candidateCount);

    for (const field of fields) {
      if (!field.text) continue;

      const fieldText = field.text.toLowerCase();
      const fieldTokens = new Set(tokenize(fieldText));
      if (fieldTokens.size === 0) continue;

      let matches = 0;
      for (const token of queryTokens) {
        if (fieldTokens.has(token)) matches += 1;
      }

      if (matches > 0) {
        score += field.weight * (matches / queryTokens.length);
      }

      for (const phrase of queryPhrases) {
        if (fieldText.includes(phrase)) {
          score += field.weight * 0.25;
        }
      }
    }

    return score;
  }
}

function tokenize(text: string): string[] {
  return [...text.toLowerCase().matchAll(TOKEN_RE)].map(match => match[0]);
}

function buildPhrases(tokens: string[]): string[] {
  const phrases: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return phrases;
}

function chromaPrior(rank: number, count: number): number {
  if (count <= 1) return 1;
  return 0.15 * (1 - rank / (count - 1));
}

function extractWeightedFields(item: RerankableSearchResult): Array<{ text?: string | null; weight: number }> {
  if ('prompt_text' in item) {
    return [
      { text: item.prompt_text, weight: 1.6 },
      { text: item.project, weight: 0.4 }
    ];
  }

  if ('request' in item) {
    const session = item as SessionSummarySearchResult;
    return [
      { text: session.request, weight: 1.6 },
      { text: session.learned, weight: 1.2 },
      { text: session.completed, weight: 1.0 },
      { text: session.investigated, weight: 0.8 },
      { text: session.next_steps, weight: 0.8 },
      { text: session.notes, weight: 0.6 },
      { text: session.files_read, weight: 0.4 },
      { text: session.files_edited, weight: 0.4 },
      { text: session.project, weight: 0.4 }
    ];
  }

  const observation = item as ObservationSearchResult;
  return [
    { text: observation.title, weight: 1.8 },
    { text: observation.subtitle, weight: 1.4 },
    { text: observation.type, weight: 1.0 },
    { text: observation.concepts, weight: 1.0 },
    { text: observation.narrative, weight: 0.9 },
    { text: observation.facts, weight: 0.9 },
    { text: observation.text, weight: 0.8 },
    { text: observation.files_read, weight: 0.5 },
    { text: observation.files_modified, weight: 0.5 },
    { text: observation.project, weight: 0.4 }
  ];
}
