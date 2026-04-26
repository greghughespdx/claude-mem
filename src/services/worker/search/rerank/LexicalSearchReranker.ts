import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import type {
  RerankCandidate,
  RerankFieldWeightOverrides,
  RerankFieldWeights,
  RerankOptions,
  RerankScoredCandidate,
  RerankableSearchResult
} from './types.js';

const TOKEN_RE = /[a-z0-9][a-z0-9_-]*/g;
const DEFAULT_TIMEOUT_MS = 25;
const DEFAULT_FIELD_WEIGHTS: RerankFieldWeights = {
  observation: {
    title: 1.8,
    subtitle: 1.4,
    type: 1.0,
    concepts: 1.0,
    narrative: 0.9,
    facts: 0.9,
    text: 0.8,
    files: 0.5,
    project: 0.4
  },
  session: {
    request: 1.6,
    learned: 1.2,
    completed: 1.0,
    investigated: 0.8,
    nextSteps: 0.8,
    notes: 0.6,
    files: 0.4,
    project: 0.4
  },
  prompt: {
    promptText: 1.6,
    project: 0.4
  }
};

export class RerankTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Lexical rerank exceeded ${timeoutMs}ms budget`);
    this.name = 'RerankTimeoutError';
  }
}

export class LexicalSearchReranker {
  private readonly weights: RerankFieldWeights;

  constructor(weightOverrides: RerankFieldWeightOverrides = {}) {
    this.weights = {
      observation: { ...DEFAULT_FIELD_WEIGHTS.observation, ...weightOverrides.observation },
      session: { ...DEFAULT_FIELD_WEIGHTS.session, ...weightOverrides.session },
      prompt: { ...DEFAULT_FIELD_WEIGHTS.prompt, ...weightOverrides.prompt }
    };
  }

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
    const fields = extractWeightedFields(candidate.item, this.weights);
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

function extractWeightedFields(
  item: RerankableSearchResult,
  weights: RerankFieldWeights
): Array<{ text?: string | null; weight: number }> {
  if ('prompt_text' in item) {
    return [
      { text: item.prompt_text, weight: weights.prompt.promptText },
      { text: item.project, weight: weights.prompt.project }
    ];
  }

  if ('request' in item) {
    const session = item as SessionSummarySearchResult;
    return [
      { text: session.request, weight: weights.session.request },
      { text: session.learned, weight: weights.session.learned },
      { text: session.completed, weight: weights.session.completed },
      { text: session.investigated, weight: weights.session.investigated },
      { text: session.next_steps, weight: weights.session.nextSteps },
      { text: session.notes, weight: weights.session.notes },
      { text: session.files_read, weight: weights.session.files },
      { text: session.files_edited, weight: weights.session.files },
      { text: session.project, weight: weights.session.project }
    ];
  }

  const observation = item as ObservationSearchResult;
  return [
    { text: observation.title, weight: weights.observation.title },
    { text: observation.subtitle, weight: weights.observation.subtitle },
    { text: observation.type, weight: weights.observation.type },
    { text: observation.concepts, weight: weights.observation.concepts },
    { text: observation.narrative, weight: weights.observation.narrative },
    { text: observation.facts, weight: weights.observation.facts },
    { text: observation.text, weight: weights.observation.text },
    { text: observation.files_read, weight: weights.observation.files },
    { text: observation.files_modified, weight: weights.observation.files },
    { text: observation.project, weight: weights.observation.project }
  ];
}
