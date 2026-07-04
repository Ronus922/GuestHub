// ============================================================
// PURE channel-sync helpers (no imports, no DB) — checkable by
// scripts/check-calendar.mjs.
// ============================================================

export type DateRange = { date_from: string; date_to: string }; // [from, to)

// Coalesce a new dirty range into existing PENDING ranges of the same
// (connection, room_type, kind): overlapping OR adjacent ranges merge into
// one — duplicate changes never produce duplicate outbound work (§S).
export function coalesceRange<T extends DateRange & { id: string }>(
  existing: T[],
  next: DateRange,
): { merged: DateRange; absorbedIds: string[] } {
  let from = next.date_from;
  let to = next.date_to;
  const absorbedIds: string[] = [];
  // iterate until fixpoint — merging can make previously-distant ranges adjacent
  let changed = true;
  const pool = [...existing];
  while (changed) {
    changed = false;
    for (let i = pool.length - 1; i >= 0; i--) {
      const r = pool[i];
      // adjacency counts: [a,b) + [b,c) → [a,c)
      if (r.date_from <= to && r.date_to >= from) {
        if (r.date_from < from) from = r.date_from;
        if (r.date_to > to) to = r.date_to;
        absorbedIds.push(r.id);
        pool.splice(i, 1);
        changed = true;
      }
    }
  }
  return { merged: { date_from: from, date_to: to }, absorbedIds };
}

// Exponential backoff with full jitter for transient sync failures (§U).
// attempt is 1-based; caps at ~1h. `rand` is injectable for tests.
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(60 * 60 * 1000, 5000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base / 2 + rand() * (base / 2));
}

// Error classification: permanent validation/mapping errors must not retry
// endlessly (§U) — they go straight to dead_letter.
export function isPermanentError(code: string | null | undefined): boolean {
  if (!code) return false;
  return ["validation_error", "mapping_error", "unauthorized", "not_found"].includes(code);
}
