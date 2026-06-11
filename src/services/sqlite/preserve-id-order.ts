/**
 * Preserve caller-provided ranking after hydrating rows by ID.
 *
 * SQLite's `WHERE id IN (...)` does not guarantee input order. Semantic search
 * callers pass IDs in Chroma relevance order, so hydration must explicitly
 * restore that order instead of falling back to timestamp sorting.
 */
export function preserveIdOrder<T extends { id: number }>(
  rows: T[],
  ids: number[],
  limit?: number
): T[] {
  const rankById = new Map(ids.map((id, index) => [id, index]));
  const sorted = [...rows].sort((a, b) => {
    const aRank = rankById.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bRank = rankById.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aRank - bRank;
  });

  return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
}
