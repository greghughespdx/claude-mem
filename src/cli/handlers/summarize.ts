/**
 * Summarize Handler - Stop
 *
 * Extracted from summary-hook.ts - sends summary request to worker.
 * Transcript parsing stays in the hook because only the hook has access to
 * the transcript file path.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

const SUMMARIZE_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.DEFAULT);

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip summary gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, transcriptPath } = input;

    // Validate required fields before processing
    if (!transcriptPath) {
      // No transcript available - skip summary gracefully (not an error)
      logger.debug('HOOK', `No transcriptPath in Stop hook input for session ${sessionId} - skipping summary`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Check if the last user prompt matches ignore patterns (e.g., idle heartbeats)
    // Session-init skips ignored prompts, but the Stop hook fires regardless.
    // Without this check, summaries accumulate for every ignored prompt in long-running sessions.
    try {
      const lastUserMessage = extractLastMessage(transcriptPath, 'user', false);
      if (lastUserMessage) {
        const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
        const ignorePatterns = settings.CLAUDE_MEM_IGNORE_PROMPT_PATTERNS;
        if (ignorePatterns) {
          const patterns = ignorePatterns.split(',').map((p: string) => p.trim()).filter(Boolean);
          if (patterns.some((pattern: string) => lastUserMessage.includes(pattern))) {
            logger.debug('HOOK', 'Stop hook - last user prompt matches ignore pattern, skipping summary', {
              contentSessionId: sessionId
            });
            return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
          }
        }
      }
    } catch (err) {
      // Non-critical: if we can't check, proceed with summarization
      logger.debug('HOOK', `Stop hook - could not check ignore patterns: ${err instanceof Error ? err.message : err}`);
    }

    // Extract last assistant message from transcript (the work Claude did)
    // Note: "user" messages in transcripts are mostly tool_results, not actual user input.
    // The user's original request is already stored in user_prompts table.
    let lastAssistantMessage = '';
    try {
      lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);
    } catch (err) {
      logger.warn('HOOK', `Stop hook: failed to extract last assistant message for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      hasLastAssistantMessage: !!lastAssistantMessage
    });

    // Send to worker - worker handles privacy check and database operations
    const response = await workerHttpRequest('/api/sessions/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        last_assistant_message: lastAssistantMessage
      }),
      timeoutMs: SUMMARIZE_TIMEOUT_MS
    });

    if (!response.ok) {
      // Return standard response even on failure (matches original behavior)
      return { continue: true, suppressOutput: true };
    }

    logger.debug('HOOK', 'Summary request sent successfully');

    return { continue: true, suppressOutput: true };
  }
};
