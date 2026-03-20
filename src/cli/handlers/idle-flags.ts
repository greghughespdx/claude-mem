/**
 * Idle Flags — shared file-based signaling between hook handlers.
 *
 * When session-init dedup fires (session already initialized), it sets an
 * "idle" flag for that contentSessionId. If a PostToolUse observation arrives
 * before the Stop hook, the flag is cleared (real work happened). The
 * summarize handler checks the flag — if still set, it skips creating a
 * summary for what was just an idle ping response.
 *
 * File: ~/.claude-mem/session-idle-flags.json
 * Format: { [contentSessionId]: true }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from '../../shared/paths.js';

const IDLE_FLAGS_PATH = join(DATA_DIR, 'session-idle-flags.json');

interface IdleFlags {
  [contentSessionId: string]: boolean;
}

function loadFlags(): IdleFlags {
  try {
    if (!existsSync(IDLE_FLAGS_PATH)) return {};
    return JSON.parse(readFileSync(IDLE_FLAGS_PATH, 'utf-8')) as IdleFlags;
  } catch {
    return {};
  }
}

function saveFlags(flags: IdleFlags): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(IDLE_FLAGS_PATH, JSON.stringify(flags), 'utf-8');
  } catch {
    // Non-fatal
  }
}

/** Mark a session as idle (no real work expected this turn). */
export function setIdleFlag(contentSessionId: string): void {
  const flags = loadFlags();
  flags[contentSessionId] = true;
  saveFlags(flags);
}

/** Clear the idle flag (real work happened via PostToolUse). */
export function clearIdleFlag(contentSessionId: string): void {
  const flags = loadFlags();
  if (contentSessionId in flags) {
    delete flags[contentSessionId];
    saveFlags(flags);
  }
}

/** Check if the session is flagged as idle. */
export function isIdleFlagged(contentSessionId: string): boolean {
  const flags = loadFlags();
  return flags[contentSessionId] === true;
}
