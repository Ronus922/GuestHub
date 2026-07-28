// ============================================================
// PURE channel-sync helpers (no imports, no DB) — checkable by
// scripts/check-calendar.mjs.
// ============================================================

export type DateRange = { date_from: string; date_to: string }; // [from, to)

// THE outbound horizon, in property-local dates. The initial Full Sync publishes
// exactly this many dates starting today; a mutation with no natural end date (a
// room going out of order) marks exactly this window dirty, so the incremental
// pass can never address a date the baseline never covered. Lives here — a pure,
// import-free module — so a reservation/calendar save can reference it without
// pulling the channel HTTP client into its module graph.
//
// 720, NOT 730. Beds24 documents a 24-month calendar, and it enforces it by
// refusing a range WHOLESALE rather than clipping it. Measured live 2026-07-28
// (commit 57e9bfe, one room, one POST /inventory/rooms/calendar):
//
//   HTTP 201 · {"success":false, "warnings":[{"message":"invalid dates"}],
//               "modified":{ …every range through 2028-05-31… }}
//
// Eight ranges were applied; the single range that ran 2028-06-01 → 2029-10-31
// was dropped in silence and took the whole request down with it. So the true
// limit is unpinned — somewhere in [673, 1191] days forward — and one straddling
// range poisons everything sent with it. The 10-day margin under 24 months is
// deliberate: publishing on the exact edge would depend on Beds24's own rounding
// and timezone, and the failure mode of being one day over is not a clipped
// range, it is a rejected batch.
//
// OUTBOUND ONLY. This is how far we PUBLISH. The inbound booking pull keeps its
// own window (BEDS24_INBOUND_FORWARD_DAYS in beds24-booking-import.ts), which
// was derived from this constant and is now deliberately independent: the two
// shared a number, never a concern. Widening a pull is not widening coverage —
// D94 — it moves risk between paths: a pull that starts returning a new class of
// record changes which code actually runs, and invalidates the assumptions of
// every status-dependent gate, including gates whose own guards still pass. D94
// requires walking every such gate to confirm it sits on the path the new pull
// activates, and that walk has NOT been done for 720. So raising THIS number
// must never raise THAT one as a side effect. BEDS24_FULL_SYNC_DAYS does stay
// derived from here — publishing is the same concern.
export const ARI_HORIZON_DAYS = 720;

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
