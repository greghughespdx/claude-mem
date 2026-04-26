/**
 * Tests for SessionStore in-memory database operations
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses real SQLite with ':memory:' - tests actual SQL and schema
 * - All CRUD operations are tested against real database behavior
 * - Timestamp handling and FK relationships are validated
 *
 * Value: Validates core persistence layer without filesystem dependencies
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('should correctly count user prompts', () => {
    const claudeId = 'claude-session-1';
    store.createSDKSession(claudeId, 'test-project', 'initial prompt');
    
    // Should be 0 initially
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(0);

    // Save prompt 1
    store.saveUserPrompt(claudeId, 1, 'First prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(1);

    // Save prompt 2
    store.saveUserPrompt(claudeId, 2, 'Second prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(2);

    // Save prompt for another session
    store.createSDKSession('claude-session-2', 'test-project', 'initial prompt');
    store.saveUserPrompt('claude-session-2', 1, 'Other prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(2);
  });

  it('should store observation with timestamp override', () => {
    const claudeId = 'claude-sess-obs';
    const memoryId = 'memory-sess-obs';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    // Set the memory_session_id before storing observations
    // createSDKSession now initializes memory_session_id = NULL
    store.updateMemorySessionId(sdkId, memoryId);

    const obs = {
      type: 'discovery',
      title: 'Test Obs',
      subtitle: null,
      facts: [],
      narrative: 'Testing',
      concepts: [],
      files_read: [],
      files_modified: []
    };

    const pastTimestamp = 1600000000000; // Some time in the past

    const result = store.storeObservation(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      obs,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = store.getObservationById(result.id);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);

    // Verify ISO string matches
    expect(new Date(stored!.created_at).getTime()).toBe(pastTimestamp);
  });

  it('should store summary with timestamp override', () => {
    const claudeId = 'claude-sess-sum';
    const memoryId = 'memory-sess-sum';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    // Set the memory_session_id before storing summaries
    store.updateMemorySessionId(sdkId, memoryId);

    const summary = {
      request: 'Do something',
      investigated: 'Stuff',
      learned: 'Things',
      completed: 'Done',
      next_steps: 'More',
      notes: null
    };

    const pastTimestamp = 1650000000000;

    const result = store.storeSummary(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      summary,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = store.getSummaryForSession(memoryId);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);
  });

  it('should preserve input ID order when hydrating observations by relevance', () => {
    const sdkId = store.createSDKSession('claude-sess-relevance-obs', 'test-project', 'initial prompt');
    store.updateMemorySessionId(sdkId, 'memory-sess-relevance-obs');

    const createObservation = (title: string, timestamp: number) => store.storeObservation(
      'memory-sess-relevance-obs',
      'test-project',
      {
        type: 'discovery',
        title,
        subtitle: null,
        facts: [],
        narrative: title,
        concepts: [],
        files_read: [],
        files_modified: []
      },
      1,
      0,
      timestamp
    ).id;

    const oldest = createObservation('oldest', 1000);
    const newest = createObservation('newest', 3000);
    const middle = createObservation('middle', 2000);

    const rows = store.getObservationsByIds([oldest, newest, middle], {
      orderBy: 'relevance',
      limit: 2
    });

    expect(rows.map(row => row.id)).toEqual([oldest, newest]);
  });

  it('should preserve input ID order when hydrating session summaries by relevance', () => {
    const sdkId = store.createSDKSession('claude-sess-relevance-summary', 'test-project', 'initial prompt');
    store.updateMemorySessionId(sdkId, 'memory-sess-relevance-summary');

    const createSummary = (request: string, timestamp: number) => store.storeSummary(
      'memory-sess-relevance-summary',
      'test-project',
      {
        request,
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        notes: null
      },
      1,
      0,
      timestamp
    ).id;

    const oldest = createSummary('oldest', 1000);
    const newest = createSummary('newest', 3000);
    const middle = createSummary('middle', 2000);

    const rows = store.getSessionSummariesByIds([oldest, newest, middle], {
      orderBy: 'relevance',
      limit: 2
    });

    expect(rows.map(row => row.id)).toEqual([oldest, newest]);
  });

  it('should preserve input ID order when hydrating user prompts by relevance', () => {
    store.createSDKSession('claude-sess-relevance-prompt', 'test-project', 'initial prompt');

    const first = store.saveUserPrompt('claude-sess-relevance-prompt', 1, 'first');
    const second = store.saveUserPrompt('claude-sess-relevance-prompt', 2, 'second');
    const third = store.saveUserPrompt('claude-sess-relevance-prompt', 3, 'third');

    store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?').run(1000, first);
    store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?').run(3000, second);
    store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?').run(2000, third);

    const rows = store.getUserPromptsByIds([first, second, third], {
      orderBy: 'relevance',
      limit: 2
    });

    expect(rows.map(row => row.id)).toEqual([first, second]);
  });
});
