import { describe, it, expect } from 'bun:test';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { isRetryableKind, DEFAULT_PROVIDER_TIMEOUT_MS } from '../../src/services/worker/retry.js';

// Pins the retry policy: quota/auth/unrecoverable errors must fail fast (no
// pointless retries of something that cannot succeed); transient and
// rate-limit errors retry; unclassified errors keep the historical
// "treat as transient" default.

const classified = (kind: string) => new ClassifiedProviderError(`test ${kind}`, { kind, cause: null });

describe('isRetryableKind', () => {
  for (const kind of ['quota_exhausted', 'auth_invalid', 'unrecoverable']) {
    it(`does not retry ${kind}`, () => {
      expect(isRetryableKind(classified(kind))).toBe(false);
    });
  }

  for (const kind of ['transient', 'rate_limit']) {
    it(`retries ${kind}`, () => {
      expect(isRetryableKind(classified(kind))).toBe(true);
    });
  }

  it('retries a plain (unclassified) Error — preserves the existing default', () => {
    expect(isRetryableKind(new Error('ECONNRESET'))).toBe(true);
  });

  it('does not retry an allowance_exhausted gateway envelope carried as quota_exhausted', () => {
    const err = new ClassifiedProviderError('You have used your allowance.', {
      kind: 'quota_exhausted',
      cause: null,
      code: 'allowance_exhausted',
      requestId: 'abc',
    });
    expect(isRetryableKind(err)).toBe(false);
  });
});

describe('per-attempt provider timeout (mc-u2vo2 fix 3)', () => {
  it('defaults to 180 seconds, not the old 30', () => {
    expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBe(180_000);
  });
});

