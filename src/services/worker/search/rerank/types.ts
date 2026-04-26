import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';

export type RerankDocumentType = 'observation' | 'session' | 'prompt';

export type RerankableSearchResult =
  | ObservationSearchResult
  | SessionSummarySearchResult
  | UserPromptSearchResult;

export interface RerankCandidate<T extends RerankableSearchResult = RerankableSearchResult> {
  id: number;
  type: RerankDocumentType;
  item: T;
  chromaRank: number;
}

export interface RerankOptions {
  timeoutMs: number;
}

export interface RerankScoredCandidate<T extends RerankableSearchResult = RerankableSearchResult>
  extends RerankCandidate<T> {
  lexicalScore: number;
}

