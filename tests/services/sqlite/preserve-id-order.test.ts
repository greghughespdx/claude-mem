import { describe, it, expect } from 'bun:test';
import { preserveIdOrder } from '../../../src/services/sqlite/preserve-id-order.js';

describe('preserveIdOrder', () => {
  it('reorders rows to match the caller-provided id sequence', () => {
    const rows = [
      { id: 3, value: 'c' },
      { id: 1, value: 'a' },
      { id: 2, value: 'b' }
    ];
    const ids = [1, 2, 3];
    const result = preserveIdOrder(rows, ids);
    expect(result.map(r => r.id)).toEqual([1, 2, 3]);
  });

  it('preserves Chroma relevance order (best match first)', () => {
    const rows = [
      { id: 10, value: 'older but returned second by SQLite' },
      { id: 7, value: 'best semantic match' },
      { id: 4, value: 'third match' }
    ];
    // Chroma returned them best-first: 7, 4, 10
    const ids = [7, 4, 10];
    const result = preserveIdOrder(rows, ids);
    expect(result.map(r => r.id)).toEqual([7, 4, 10]);
  });

  it('applies limit after reordering', () => {
    const rows = [
      { id: 3, value: 'c' },
      { id: 1, value: 'a' },
      { id: 2, value: 'b' }
    ];
    const ids = [1, 2, 3];
    const result = preserveIdOrder(rows, ids, 2);
    expect(result.map(r => r.id)).toEqual([1, 2]);
  });

  it('places rows with unknown ids at the end', () => {
    const rows = [
      { id: 99, value: 'unknown' },
      { id: 1, value: 'known' }
    ];
    const ids = [1];
    const result = preserveIdOrder(rows, ids);
    expect(result[0].id).toBe(1);
    expect(result[1].id).toBe(99);
  });

  it('returns empty array for empty input', () => {
    expect(preserveIdOrder([], [])).toEqual([]);
  });
});
