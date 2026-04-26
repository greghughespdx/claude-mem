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

export interface ObservationFieldWeights {
  title: number;
  subtitle: number;
  type: number;
  concepts: number;
  narrative: number;
  facts: number;
  text: number;
  files: number;
  project: number;
}

export interface SessionFieldWeights {
  request: number;
  learned: number;
  completed: number;
  investigated: number;
  nextSteps: number;
  notes: number;
  files: number;
  project: number;
}

export interface PromptFieldWeights {
  promptText: number;
  project: number;
}

export interface RerankFieldWeights {
  observation: ObservationFieldWeights;
  session: SessionFieldWeights;
  prompt: PromptFieldWeights;
}

export interface RerankFieldWeightOverrides {
  observation?: Partial<ObservationFieldWeights>;
  session?: Partial<SessionFieldWeights>;
  prompt?: Partial<PromptFieldWeights>;
}
