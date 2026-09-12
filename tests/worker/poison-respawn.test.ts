import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { WorkerRef } from '../../src/services/worker/agents/types.js';

function makeDbManager(storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }))): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-123',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      ensureMemorySessionIdRegistered: () => {},
      storeObservations,
    }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

const makeWorker = (): WorkerRef => ({
  broadcastProcessingStatus: mock(() => {}),
}) as unknown as WorkerRef;

async function queueAndClaimOne(sm: SessionManager, sessionDbId: number): Promise<void> {
  await sm.queueObservation(sessionDbId, {
    tool_name: 'Read',
    tool_input: {},
    tool_response: {},
    prompt_number: 1,
    toolUseId: `tu-${sessionDbId}`,
  });

  const iterator = sm.getMessageIterator(sessionDbId);
  const claimed = await iterator.next();
  expect(claimed.done).toBe(false);
  expect(sm.getMessageBuffer().getPendingCount(sessionDbId)).toBe(1);
  await iterator.return?.();
}

// mc-u2vo2 fix 2: a retry puts the batch back to pending and releases the
// claim. In the live worker the generator re-claims it on its next pass; these
// tests drive that step by hand.
async function claimPending(sm: SessionManager, sessionDbId: number): Promise<void> {
  const iterator = sm.getMessageIterator(sessionDbId);
  const claimed = await iterator.next();
  expect(claimed.done).toBe(false);
  await iterator.return?.();
}

let spies: ReturnType<typeof spyOn>[] = [];

describe('observer invalid-output handling (Phase 3 recovery)', () => {
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    spies.forEach(s => s.mockRestore());
    mock.restore();
  });

  // mc-u2vo2 fix 2 changed this contract deliberately. Unreadable output that
  // opened an <observation> tag used to be acked and thrown away on the first
  // pass; it is now retried once and then salvaged. The respawn guarantees this
  // test exists for - no abort, no abortReason, bounded work - still hold.
  it('retries unreadable XML output once instead of dropping the claimed batch', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(1, 'do the thing', 1);
    session.memorySessionId = 'mem-1';
    await queueAndClaimOne(sm, 1);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');
    const worker = makeWorker();

    await processAgentResponse(
      'I hit the context window and cannot continue <observation>',
      session,
      makeDbManager(),
      sm,
      worker,
      0,
      null,
      'TestAgent',
    );

    // The work is kept, not acknowledged away.
    expect(resetSpy).toHaveBeenCalledWith(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(1)).toBe(1);
    expect(session.invalidOutputRetried).toBe(true);
    expect(session.consecutiveInvalidOutputs).toBe(1);
    // And nothing about the session was aborted or poisoned.
    expect(session.abortController.signal.aborted).toBe(false);
    expect(session.abortReason ?? null).toBeNull();
  });

  it('repeated "No observations to record" acknowledgements retry once, then confirm, and never abort', async () => {
    const storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }));
    const sm = new SessionManager(makeDbManager(storeObservations));
    const session = sm.initializeSession(2, 'do the thing', 1);
    session.memorySessionId = 'mem-2';
    await queueAndClaimOne(sm, 2);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');

    const reply = async () => processAgentResponse(
      'No observations to record.',
      session,
      makeDbManager(storeObservations),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    // First reply: the batch is kept and reset to pending for one retry.
    await reply();
    expect(resetSpy).toHaveBeenCalledWith(2);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(session.invalidOutputRetried).toBe(true);
    expect(session.abortController.signal.aborted).toBe(false);

    // Second reply, same prose: confirmed away at ERROR level, never stored,
    // and never reset again. (claimPending re-claims the batch the way the
    // live generator does; the iterator resets pending itself, which is why
    // resetSpy is not a useful call counter past this point.)
    await claimPending(sm, 2);
    const resetsBeforeSecondReply = resetSpy.mock.calls.length;
    await reply();
    expect(resetSpy.mock.calls.length).toBe(resetsBeforeSecondReply);
    expect(confirmSpy).toHaveBeenCalledWith(2);
    expect(session.invalidOutputRetried).toBe(false);
    expect(session.abortController.signal.aborted).toBe(false);
    expect(storeObservations).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(2)).toBe(0);
    expect(session.claimedMessageIds).toEqual([]);
  });

  it('pauses on weekly-limit quota prose and preserves claimed pending work', async () => {
    const storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }));
    const sm = new SessionManager(makeDbManager(storeObservations));
    const session = sm.initializeSession(3, 'do the thing', 1);
    session.memorySessionId = 'mem-3';
    session.consecutiveInvalidOutputs = 2;
    await queueAndClaimOne(sm, 3);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');
    const worker = makeWorker();

    await processAgentResponse(
      'Claude usage limit reached. Your weekly limit will reset soon, so please try again later.',
      session,
      makeDbManager(storeObservations),
      sm,
      worker,
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalledWith(3);
    expect(sm.getMessageBuffer().getPendingCount(3)).toBe(1);
    expect(session.claimedMessageIds).toEqual([]);
    expect(session.consecutiveInvalidOutputs).toBe(0);
    expect(session.abortReason).toBe('quota:observer_text');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(worker.broadcastProcessingStatus).toHaveBeenCalled();
    expect(storeObservations).not.toHaveBeenCalled();
  });

  it('pauses on auth-failure prose without confirming or storing the claimed batch', async () => {
    const storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }));
    const sm = new SessionManager(makeDbManager(storeObservations));
    const session = sm.initializeSession(7, 'do the thing', 1);
    session.memorySessionId = 'mem-7';
    session.consecutiveInvalidOutputs = 2;
    await queueAndClaimOne(sm, 7);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');
    const worker = makeWorker();

    await processAgentResponse(
      'Failed to authenticate. API Error: 401 · Please run /login',
      session,
      makeDbManager(storeObservations),
      sm,
      worker,
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalledWith(7);
    expect(storeObservations).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(7)).toBe(1);
    expect(session.claimedMessageIds).toEqual([]);
    expect(session.earliestPendingTimestamp).not.toBeNull();
    expect(session.consecutiveInvalidOutputs).toBe(0);
    expect(session.abortReason).toBe('auth:observer_text');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(worker.broadcastProcessingStatus).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('pauses on a bare unauthorized status and preserves the claimed batch', async () => {
    const storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }));
    const sm = new SessionManager(makeDbManager(storeObservations));
    const session = sm.initializeSession(9, 'do the thing', 1);
    session.memorySessionId = 'mem-9';
    await queueAndClaimOne(sm, 9);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');

    await processAgentResponse(
      '401 Unauthorized',
      session,
      makeDbManager(storeObservations),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalledWith(9);
    expect(storeObservations).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(9)).toBe(1);
    expect(session.abortReason).toBe('auth:observer_text');
    expect(session.abortController.signal.aborted).toBe(true);
  });

  it('confirms unrelated login instructions as ordinary prose', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(10, 'do the thing', 1);
    session.memorySessionId = 'mem-10';
    await queueAndClaimOne(sm, 10);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');

    // mc-u2vo2 fix 2: the first pass buys one retry, the second confirms.
    for (let i = 0; i < 2; i++) {
      if (i > 0) await claimPending(sm, 10);
      await processAgentResponse(
        'Please run /login in the observed project instructions.',
        session,
        makeDbManager(),
        sm,
        makeWorker(),
        0,
        null,
        'TestAgent',
      );
    }

    expect(resetSpy).toHaveBeenCalledWith(10);
    expect(confirmSpy).toHaveBeenCalledWith(10);
    expect(sm.getMessageBuffer().getPendingCount(10)).toBe(0);
    expect(session.abortController.signal.aborted).toBe(false);
  });

  it('confirms project auth-guide prose as ordinary prose', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(11, 'do the thing', 1);
    session.memorySessionId = 'mem-11';
    await queueAndClaimOne(sm, 11);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');

    // mc-u2vo2 fix 2: the first pass buys one retry, the second confirms.
    for (let i = 0; i < 2; i++) {
      if (i > 0) await claimPending(sm, 11);
      await processAgentResponse(
        'The project authentication guide says to run /login before testing.',
        session,
        makeDbManager(),
        sm,
        makeWorker(),
        0,
        null,
        'TestAgent',
      );
    }

    expect(resetSpy).toHaveBeenCalledWith(11);
    expect(confirmSpy).toHaveBeenCalledWith(11);
    expect(sm.getMessageBuffer().getPendingCount(11)).toBe(0);
    expect(session.abortController.signal.aborted).toBe(false);
  });

  it('auth generator exit keeps the active session and in-memory buffer', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(8, 'do the thing', 1);
    session.memorySessionId = 'mem-8';
    session.currentProvider = 'claude';
    session.generatorPromise = Promise.resolve();
    await queueAndClaimOne(sm, 8);

    await processAgentResponse(
      'Failed to authenticate. API Error: 401 · Please run /login',
      session,
      makeDbManager(),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    const finalizeSession = mock(() => Promise.resolve());
    const removeSpy = spyOn(sm, 'removeSessionImmediate');

    await handleGeneratorExit(session, session.abortReason, {
      sessionManager: sm,
      completionHandler: { finalizeSession } as any,
    });

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(sm.getSession(8)).toBe(session);
    expect(sm.getMessageBuffer().getPendingCount(8)).toBe(1);
  });

  it('quota generator exit keeps the active session and in-memory buffer', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(6, 'do the thing', 1);
    session.memorySessionId = 'mem-6';
    session.currentProvider = 'claude';
    session.generatorPromise = Promise.resolve();
    await queueAndClaimOne(sm, 6);

    await processAgentResponse(
      'Claude usage limit reached. Your weekly limit will reset soon.',
      session,
      makeDbManager(),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    const finalizeSession = mock(() => Promise.resolve());
    const removeSpy = spyOn(sm, 'removeSessionImmediate');

    await handleGeneratorExit(session, session.abortReason, {
      sessionManager: sm,
      completionHandler: { finalizeSession } as any,
    });

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(sm.getSession(6)).toBe(session);
    expect(sm.getMessageBuffer().getPendingCount(6)).toBe(1);
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
  });

  it('confirms skip/no-op prose but preserves the same queue shape for quota pause', async () => {
    const skipSm = new SessionManager(makeDbManager());
    const skipSession = skipSm.initializeSession(4, 'do the thing', 1);
    skipSession.memorySessionId = 'mem-4';
    await queueAndClaimOne(skipSm, 4);

    // mc-u2vo2 fix 2: one retry, then the confirm. Two passes to reach the
    // settled state this test compares against the quota pause.
    for (let i = 0; i < 2; i++) {
      if (i > 0) await claimPending(skipSm, 4);
      await processAgentResponse(
        'No observations to record.',
        skipSession,
        makeDbManager(),
        skipSm,
        makeWorker(),
        0,
        null,
        'TestAgent',
      );
    }

    const quotaSm = new SessionManager(makeDbManager());
    const quotaSession = quotaSm.initializeSession(5, 'do the thing', 1);
    quotaSession.memorySessionId = 'mem-5';
    await queueAndClaimOne(quotaSm, 5);

    await processAgentResponse(
      'Your subscription weekly quota has been exhausted and resets later.',
      quotaSession,
      makeDbManager(),
      quotaSm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    expect(skipSm.getMessageBuffer().getPendingCount(4)).toBe(0);
    expect(quotaSm.getMessageBuffer().getPendingCount(5)).toBe(1);
  });
});
