// SPDX-License-Identifier: Apache-2.0
//
// mc-u2vo2 fixes 1 and 3: the two decisions the OpenRouter provider makes when
// a reply comes back with an empty `content` field, and the per-attempt
// timeout it now uses.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  looksLikeObserverXml,
  resolveProviderTimeoutMs,
} from '../../src/services/worker/OpenRouterProvider.js';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../../src/services/worker/retry.js';

describe('looksLikeObserverXml (reasoning-field fallback gate)', () => {
  it('accepts observer XML roots', () => {
    expect(looksLikeObserverXml('<observation><type>discovery</type></observation>')).toBe(true);
    expect(looksLikeObserverXml('<summary><request>x</request></summary>')).toBe(true);
    expect(looksLikeObserverXml('<skip_summary />')).toBe(true);
    expect(looksLikeObserverXml('<skip_observation/>')).toBe(true);
  });

  it('rejects the reasoning voice that is not an answer', () => {
    const reasoning = 'We need to produce observations from tool use messages. '
      + 'But we have no tool usage logs in this prompt. So produce nothing.';
    expect(looksLikeObserverXml(reasoning)).toBe(false);
    expect(looksLikeObserverXml('')).toBe(false);
  });
});

describe('resolveProviderTimeoutMs (mc-u2vo2 fix 3)', () => {
  let tempDir: string;
  let settingsPath: string;
  let saved: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `openrouter-timeout-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    saved = process.env.CLAUDE_MEM_PROVIDER_TIMEOUT_MS;
    delete process.env.CLAUDE_MEM_PROVIDER_TIMEOUT_MS;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_MEM_PROVIDER_TIMEOUT_MS;
    else process.env.CLAUDE_MEM_PROVIDER_TIMEOUT_MS = saved;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses the 180 s default when the setting is absent', () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    expect(resolveProviderTimeoutMs(settingsPath)).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
    expect(resolveProviderTimeoutMs(settingsPath)).toBe(180_000);
  });

  it('honors an explicit setting', () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_PROVIDER_TIMEOUT_MS: '90000' }));
    expect(resolveProviderTimeoutMs(settingsPath)).toBe(90_000);
  });

  it('falls back to the default on a nonsense setting', () => {
    for (const bad of ['', 'soon', '-5', '0']) {
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_PROVIDER_TIMEOUT_MS: bad }));
      expect(resolveProviderTimeoutMs(settingsPath)).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
    }
  });
});
