/**
 * ChromaSearchStrategy - Vector-based semantic search via Chroma
 *
 * This strategy handles semantic search queries using ChromaDB:
 * 1. Query Chroma for semantically similar documents
 * 2. Filter by recency (90-day window)
 * 3. Categorize by document type
 * 4. Hydrate from SQLite
 *
 * Used when: Query text is provided and Chroma is available
 */

import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ChromaMetadata,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { ChromaSync } from '../../../sync/ChromaSync.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { logger } from '../../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { LexicalSearchReranker } from '../rerank/index.js';
import type { RerankCandidate, RerankDocumentType, RerankableSearchResult } from '../rerank/index.js';

interface RerankConfig {
  enabled: boolean;
  candidates: number;
  timeoutMs: number;
}

export class ChromaSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'chroma';
  private readonly rerankConfig: RerankConfig;

  constructor(
    private chromaSync: ChromaSync,
    private sessionStore: SessionStore,
    private reranker: LexicalSearchReranker = new LexicalSearchReranker(),
    rerankConfigOverride?: RerankConfig
  ) {
    super();
    this.rerankConfig = rerankConfigOverride ?? loadRerankConfigFromSettings();
  }

  canHandle(options: StrategySearchOptions): boolean {
    // Can handle when query text is provided and Chroma is available
    return !!options.query && !!this.chromaSync;
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      query,
      searchType = 'all',
      obsType,
      concepts,
      files,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      project,
      orderBy = 'relevance'
    } = options;

    if (!query) {
      return this.emptyResult('chroma');
    }

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';
    const searchPrompts = searchType === 'all' || searchType === 'prompts';

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    // Build Chroma where filter for doc_type and project
    const whereFilter = this.buildWhereFilter(searchType, project);

    logger.debug('SEARCH', 'ChromaSearchStrategy: Querying Chroma', { query, searchType });

    try {
      return await this.executeChromaSearch(query, whereFilter, {
        searchObservations, searchSessions, searchPrompts,
        obsType, concepts, files, orderBy, limit, project
      });
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      logger.error('WORKER', 'ChromaSearchStrategy: Search failed', {}, errorObj);
      // Return empty result - caller may try fallback strategy
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: false,
        fellBack: false,
        strategy: 'chroma'
      };
    }
  }

  private async executeChromaSearch(
    query: string,
    whereFilter: Record<string, any> | undefined,
    options: {
      searchObservations: boolean;
      searchSessions: boolean;
      searchPrompts: boolean;
      obsType?: string | string[];
      concepts?: string | string[];
      files?: string | string[];
      orderBy: 'relevance' | 'date_desc' | 'date_asc';
      limit: number;
      project?: string;
    }
  ): Promise<StrategySearchResult> {
    const rerankConfig = this.rerankConfig;
    const candidateLimit = rerankConfig.enabled
      ? Math.max(options.limit, Math.min(rerankConfig.candidates, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE))
      : SEARCH_CONSTANTS.CHROMA_BATCH_SIZE;

    const chromaResults = await this.chromaSync.queryChroma(
      query,
      candidateLimit,
      whereFilter
    );

    if (chromaResults.ids.length === 0) {
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: true,
        fellBack: false,
        strategy: 'chroma'
      };
    }

    const recentItems = this.filterByRecency(chromaResults);
    const categorized = this.categorizeByDocType(recentItems, options);
    const chromaRankByKey = this.buildChromaRankMap(recentItems);
    const hydrationLimit = rerankConfig.enabled ? candidateLimit : options.limit;

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    if (categorized.obsIds.length > 0) {
      const obsOptions = { type: options.obsType, concepts: options.concepts, files: options.files, orderBy: options.orderBy, limit: hydrationLimit, project: options.project };
      observations = this.sessionStore.getObservationsByIds(categorized.obsIds, obsOptions);
    }

    if (categorized.sessionIds.length > 0) {
      sessions = this.sessionStore.getSessionSummariesByIds(categorized.sessionIds, {
        orderBy: options.orderBy, limit: hydrationLimit, project: options.project
      });
    }

    if (categorized.promptIds.length > 0) {
      prompts = this.sessionStore.getUserPromptsByIds(categorized.promptIds, {
        orderBy: options.orderBy, limit: hydrationLimit, project: options.project
      });
    }

    if (rerankConfig.enabled && options.orderBy === 'relevance') {
      ({ observations, sessions, prompts } = this.rerankResultsSafely(
        query,
        chromaRankByKey,
        { observations, sessions, prompts },
        rerankConfig,
        options.limit
      ));
    }

    return {
      results: { observations, sessions, prompts },
      usedChroma: true,
      fellBack: false,
      strategy: 'chroma'
    };
  }

  /**
   * Build Chroma where filter for document type and project
   *
   * When a project is specified, includes it in the ChromaDB where clause
   * so that vector search is scoped to the target project. Without this,
   * larger projects dominate the top-N results and smaller projects get
   * crowded out before the post-hoc SQLite project filter can take effect.
   */
  private buildWhereFilter(searchType: string, project?: string): Record<string, any> | undefined {
    let docTypeFilter: Record<string, any> | undefined;
    switch (searchType) {
      case 'observations':
        docTypeFilter = { doc_type: 'observation' };
        break;
      case 'sessions':
        docTypeFilter = { doc_type: 'session_summary' };
        break;
      case 'prompts':
        docTypeFilter = { doc_type: 'user_prompt' };
        break;
      default:
        docTypeFilter = undefined;
    }

    if (project) {
      const projectFilter = { project };
      if (docTypeFilter) {
        return { $and: [docTypeFilter, projectFilter] };
      }
      return projectFilter;
    }

    return docTypeFilter;
  }

  /**
   * Filter results by recency (90-day window)
   *
   * IMPORTANT: ChromaSync.queryChroma() returns deduplicated `ids` (unique sqlite_ids)
   * but the `metadatas` array may contain multiple entries per sqlite_id (e.g., one
   * observation can have narrative + multiple facts as separate Chroma documents).
   *
   * This method iterates over the deduplicated `ids` and finds the first matching
   * metadata for each ID to avoid array misalignment issues.
   */
  private filterByRecency(chromaResults: {
    ids: number[];
    metadatas: ChromaMetadata[];
  }): Array<{ id: number; meta: ChromaMetadata }> {
    const cutoff = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;

    // Build a map from sqlite_id to first metadata for efficient lookup
    const metadataByIdMap = new Map<number, ChromaMetadata>();
    for (const meta of chromaResults.metadatas) {
      if (meta?.sqlite_id !== undefined && !metadataByIdMap.has(meta.sqlite_id)) {
        metadataByIdMap.set(meta.sqlite_id, meta);
      }
    }

    // Iterate over deduplicated ids and get corresponding metadata
    return chromaResults.ids
      .map(id => ({
        id,
        meta: metadataByIdMap.get(id) as ChromaMetadata
      }))
      .filter(item => item.meta && item.meta.created_at_epoch > cutoff);
  }

  /**
   * Categorize IDs by document type
   */
  private categorizeByDocType(
    items: Array<{ id: number; meta: ChromaMetadata }>,
    options: {
      searchObservations: boolean;
      searchSessions: boolean;
      searchPrompts: boolean;
    }
  ): { obsIds: number[]; sessionIds: number[]; promptIds: number[] } {
    const obsIds: number[] = [];
    const sessionIds: number[] = [];
    const promptIds: number[] = [];

    for (const item of items) {
      const docType = item.meta?.doc_type;
      if (docType === 'observation' && options.searchObservations) {
        obsIds.push(item.id);
      } else if (docType === 'session_summary' && options.searchSessions) {
        sessionIds.push(item.id);
      } else if (docType === 'user_prompt' && options.searchPrompts) {
        promptIds.push(item.id);
      }
    }

    return { obsIds, sessionIds, promptIds };
  }

  private buildChromaRankMap(items: Array<{ id: number; meta: ChromaMetadata }>): Map<string, number> {
    const ranks = new Map<string, number>();
    items.forEach((item, index) => {
      const type = this.toRerankDocumentType(item.meta.doc_type);
      ranks.set(this.rankKey(type, item.id), index);
    });
    return ranks;
  }

  private rerankResultsSafely(
    query: string,
    chromaRankByKey: Map<string, number>,
    results: {
      observations: ObservationSearchResult[];
      sessions: SessionSummarySearchResult[];
      prompts: UserPromptSearchResult[];
    },
    config: RerankConfig,
    limit: number
  ): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
    prompts: UserPromptSearchResult[];
  } {
    try {
      return {
        observations: this.rerankGroup(query, 'observation', results.observations, chromaRankByKey, config, limit),
        sessions: this.rerankGroup(query, 'session', results.sessions, chromaRankByKey, config, limit),
        prompts: this.rerankGroup(query, 'prompt', results.prompts, chromaRankByKey, config, limit)
      };
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      logger.warn('SEARCH', 'ChromaSearchStrategy: Lexical rerank failed, preserving Chroma order', {
        error: errorObj.message
      });
      return results;
    }
  }

  private rerankGroup<T extends RerankableSearchResult>(
    query: string,
    type: RerankDocumentType,
    items: T[],
    chromaRankByKey: Map<string, number>,
    config: RerankConfig,
    limit: number
  ): T[] {
    const candidates: RerankCandidate<T>[] = items.map((item, index) => ({
      id: item.id,
      type,
      item,
      chromaRank: chromaRankByKey.get(this.rankKey(type, item.id)) ?? index
    }));

    return this.reranker
      .rerank(query, candidates, { timeoutMs: config.timeoutMs })
      .slice(0, limit)
      .map(candidate => candidate.item);
  }

  private toRerankDocumentType(docType: ChromaMetadata['doc_type']): RerankDocumentType {
    switch (docType) {
      case 'session_summary':
        return 'session';
      case 'user_prompt':
        return 'prompt';
      default:
        return 'observation';
    }
  }

  private rankKey(type: RerankDocumentType, id: number): string {
    return `${type}:${id}`;
  }
}

function loadRerankConfigFromSettings(): RerankConfig {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const candidates = parsePositiveInt(
    settings.CLAUDE_MEM_SEARCH_RERANK_CANDIDATES,
    50,
    SEARCH_CONSTANTS.CHROMA_BATCH_SIZE
  );
  const timeoutMs = parsePositiveInt(settings.CLAUDE_MEM_SEARCH_RERANK_TIMEOUT_MS, 25, 500);

  return {
    enabled: settings.CLAUDE_MEM_SEARCH_RERANK_ENABLED === 'true',
    candidates,
    timeoutMs
  };
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
