#!/usr/bin/env bun
/**
 * Compare claude-mem's local lexical reranker against baseline SQLite FTS order
 * and, optionally, an installed Python flashrank package.
 *
 * Examples:
 *   bun scripts/benchmark-lexical-rerank.ts --all-queries
 *   bun scripts/benchmark-lexical-rerank.ts "agent messaging protocol" --flashrank
 *   bun scripts/benchmark-lexical-rerank.ts --judgments ./rerank-judgments.json --json
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { LexicalSearchReranker } from '../src/services/worker/search/rerank/index.js';
import type { ObservationSearchResult } from '../src/services/worker/search/types.js';

const DEFAULT_DB = join(homedir(), '.claude-mem', 'claude-mem.db');
const DEFAULT_QUERIES = [
  'agent messaging protocol',
  'Telegram plugin polling',
  'KML Creator format learning',
  'vault credentials access',
  'overnight session close-out',
  'deployment drift'
];

interface CliOptions {
  dbPath: string;
  queries: string[];
  limit: number;
  flashrank: boolean;
  json: boolean;
  judgmentsPath?: string;
}

interface ObservationCandidate extends ObservationSearchResult {
  rank?: number;
}

interface JudgmentSet {
  [query: string]: number[];
}

interface RankingResult {
  ids: number[];
  scores?: Record<number, number>;
  latencyMs: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dbPath: DEFAULT_DB,
    queries: [],
    limit: 20,
    flashrank: false,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      options.dbPath = argv[++i];
    } else if (arg === '--limit') {
      options.limit = Number.parseInt(argv[++i], 10);
    } else if (arg === '--all-queries') {
      options.queries = [...DEFAULT_QUERIES];
    } else if (arg === '--flashrank') {
      options.flashrank = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--judgments') {
      options.judgmentsPath = argv[++i];
    } else if (!arg.startsWith('--')) {
      options.queries.push(arg);
    }
  }

  if (options.queries.length === 0) {
    options.queries = [DEFAULT_QUERIES[0]];
  }

  if (!Number.isFinite(options.limit) || options.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }

  return options;
}

function loadJudgments(path?: string): JudgmentSet {
  if (!path) return {};
  if (!existsSync(path)) {
    throw new Error(`Judgments file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as JudgmentSet;
}

function ftsSearch(db: Database, query: string, limit: number): ObservationCandidate[] {
  const safeQuery = query.replace(/"/g, '""');
  try {
    const rows = db.query(`
      SELECT
        o.id,
        o.memory_session_id,
        o.project,
        o.text,
        o.type,
        o.title,
        o.subtitle,
        o.facts,
        o.narrative,
        o.concepts,
        o.files_read,
        o.files_modified,
        o.prompt_number,
        o.discovery_tokens,
        o.created_at,
        o.created_at_epoch,
        rank
      FROM observations_fts fts
      JOIN observations o ON o.id = fts.rowid
      WHERE observations_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(safeQuery, limit);
    return rows as ObservationCandidate[];
  } catch {
    return likeSearch(db, query, limit);
  }
}

function likeSearch(db: Database, query: string, limit: number): ObservationCandidate[] {
  const words = query.split(/\s+/).filter(Boolean);
  const conditions = words.map(() => '(o.title LIKE ? OR o.narrative LIKE ? OR o.text LIKE ?)').join(' OR ');
  const params = words.flatMap(word => [`%${word}%`, `%${word}%`, `%${word}%`]);
  const rows = db.query(`
    SELECT
      o.id,
      o.memory_session_id,
      o.project,
      o.text,
      o.type,
      o.title,
      o.subtitle,
      o.facts,
      o.narrative,
      o.concepts,
      o.files_read,
      o.files_modified,
      o.prompt_number,
      o.discovery_tokens,
      o.created_at,
      o.created_at_epoch,
      0 as rank
    FROM observations o
    WHERE ${conditions || '1=1'}
    LIMIT ?
  `).all(...params, limit);
  return rows as ObservationCandidate[];
}

function runLexical(query: string, observations: ObservationCandidate[]): RankingResult {
  const reranker = new LexicalSearchReranker();
  const started = performance.now();
  const reranked = reranker.rerank(
    query,
    observations.map((item, index) => ({
      id: item.id,
      type: 'observation' as const,
      item,
      chromaRank: index
    })),
    { timeoutMs: 100 }
  );
  return {
    ids: reranked.map(candidate => candidate.id),
    scores: Object.fromEntries(reranked.map(candidate => [candidate.id, candidate.lexicalScore])),
    latencyMs: performance.now() - started
  };
}

function runFlashrank(query: string, observations: ObservationCandidate[]): RankingResult | null {
  const passages = observations.map(obs => ({
    id: obs.id,
    text: [obs.title, obs.subtitle, obs.narrative, obs.text].filter(Boolean).join(' | ')
  }));
  const payload = JSON.stringify({ query, passages });
  const started = performance.now();
  const script = `
import json, sys
from flashrank import Ranker, RerankRequest
payload = json.load(sys.stdin)
ranker = Ranker(log_level="WARNING")
result = ranker.rerank(RerankRequest(query=payload["query"], passages=payload["passages"]))
print(json.dumps([{"id": item.get("id"), "score": item.get("score", 0)} for item in result]))
`;
  const result = spawnSync('python3', ['-c', script], {
    input: payload,
    encoding: 'utf-8'
  });
  if (result.status !== 0) {
    return null;
  }
  const ranked = JSON.parse(result.stdout) as Array<{ id: number; score: number }>;
  return {
    ids: ranked.map(item => item.id),
    scores: Object.fromEntries(ranked.map(item => [item.id, item.score])),
    latencyMs: performance.now() - started
  };
}

function reciprocalRank(ids: number[], relevant: Set<number>, cutoff: number): number {
  for (let i = 0; i < Math.min(ids.length, cutoff); i += 1) {
    if (relevant.has(ids[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function recallAt(ids: number[], relevant: Set<number>, cutoff: number): number {
  if (relevant.size === 0) return 0;
  const found = ids.slice(0, cutoff).filter(id => relevant.has(id)).length;
  return found / relevant.size;
}

function summarizeMove(original: number[], reranked: number[]): string {
  const originalRank = new Map(original.map((id, index) => [id, index + 1]));
  const biggestMoves = reranked
    .map((id, index) => ({
      id,
      from: originalRank.get(id) ?? 0,
      to: index + 1
    }))
    .filter(move => move.from !== move.to)
    .sort((a, b) => Math.abs(b.from - b.to) - Math.abs(a.from - a.to))
    .slice(0, 3);

  if (biggestMoves.length === 0) return 'no order change';
  return biggestMoves.map(move => `#${move.id} ${move.from}->${move.to}`).join(', ');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.dbPath)) {
    throw new Error(`Database not found: ${options.dbPath}`);
  }

  const judgments = loadJudgments(options.judgmentsPath);
  const db = new Database(options.dbPath, { readonly: true });
  const report: any[] = [];

  try {
    for (const query of options.queries) {
      const searchStarted = performance.now();
      const observations = ftsSearch(db, query, options.limit);
      const searchMs = performance.now() - searchStarted;
      const baseline = observations.map(obs => obs.id);
      const lexical = runLexical(query, observations);
      const flashrank = options.flashrank ? runFlashrank(query, observations) : null;
      const relevant = new Set(judgments[query] ?? []);

      const row = {
        query,
        results: observations.length,
        search_ms: Number(searchMs.toFixed(1)),
        baseline: {
          mrr_at_10: relevant.size ? reciprocalRank(baseline, relevant, 10) : null,
          recall_at_10: relevant.size ? recallAt(baseline, relevant, 10) : null
        },
        lexical: {
          latency_ms: Number(lexical.latencyMs.toFixed(1)),
          moves: summarizeMove(baseline, lexical.ids),
          mrr_at_10: relevant.size ? reciprocalRank(lexical.ids, relevant, 10) : null,
          recall_at_10: relevant.size ? recallAt(lexical.ids, relevant, 10) : null
        },
        flashrank: flashrank ? {
          latency_ms: Number(flashrank.latencyMs.toFixed(1)),
          moves: summarizeMove(baseline, flashrank.ids),
          mrr_at_10: relevant.size ? reciprocalRank(flashrank.ids, relevant, 10) : null,
          recall_at_10: relevant.size ? recallAt(flashrank.ids, relevant, 10) : null
        } : null
      };
      report.push(row);
    }
  } finally {
    db.close();
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  for (const row of report) {
    console.log(`\nQuery: ${row.query}`);
    console.log(`  Results: ${row.results} | FTS: ${row.search_ms}ms`);
    console.log(`  Lexical: ${row.lexical.latency_ms}ms | ${row.lexical.moves}`);
    if (row.flashrank) {
      console.log(`  Flashrank: ${row.flashrank.latency_ms}ms | ${row.flashrank.moves}`);
    } else if (options.flashrank) {
      console.log('  Flashrank: unavailable (install Python package `flashrank` to compare)');
    }
    if (row.baseline.mrr_at_10 !== null) {
      console.log(`  MRR@10 baseline=${row.baseline.mrr_at_10.toFixed(3)} lexical=${row.lexical.mrr_at_10.toFixed(3)}`);
      console.log(`  Recall@10 baseline=${row.baseline.recall_at_10.toFixed(3)} lexical=${row.lexical.recall_at_10.toFixed(3)}`);
    }
  }
}

main();
