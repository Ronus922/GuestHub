// ============================================================
// Full Sync progress model (D69) — PURE: no imports, no DB, no HTTP, no clock.
// Standalone-compilable, asserted by scripts/check-channex-ari.mjs.
//
// The percentage is a function of REAL MILESTONES ONLY — a phase and, inside a
// phase, how many rooms / (room × rate plan) combinations have actually been
// processed. Elapsed time is never an input: `phasePercent` cannot even observe
// a clock. A stalled run therefore stops advancing, which is the whole point.
//
// A phase is only ever reported once it has genuinely begun, and `completed`
// (100%) is reachable only from a clean, warning-free run.
// ============================================================

export type FullSyncPhase =
  | "validating"
  | "projecting_availability"
  | "submitting_availability"
  | "projecting_rates"
  | "submitting_rates"
  | "checking_warnings"
  | "activating_incremental_sync"
  | "completed"
  | "failed";

export const PHASE_LABELS: Record<FullSyncPhase, string> = {
  validating: "בודק מיפויים ונתונים",
  projecting_availability: "מחשב זמינות",
  submitting_availability: "שולח זמינות ל-Channex",
  projecting_rates: "מחשב מחירים והגבלות",
  submitting_rates: "שולח מחירים והגבלות ל-Channex",
  checking_warnings: "בודק אזהרות ותוצאות",
  activating_incremental_sync: "מפעיל סנכרון אוטומטי",
  completed: "הסנכרון הושלם",
  failed: "הסנכרון נכשל",
};

// [start, end] of the bar each phase owns. Progress inside a phase interpolates
// between them from real processed counts; a phase never reports its end value
// until its last unit of work is done.
const PHASE_RANGE: Record<FullSyncPhase, readonly [number, number]> = {
  validating: [0, 10],
  projecting_availability: [10, 30],
  submitting_availability: [30, 45],
  projecting_rates: [45, 75],
  submitting_rates: [75, 90],
  checking_warnings: [90, 97],
  // 99, not 100: activation is the LAST thing before completion, and 100% must be
  // reachable only by actually completing. No non-terminal phase may show 100.
  activating_incremental_sync: [97, 99],
  completed: [100, 100],
  // a failed run FREEZES at the percentage it had reached — it never shows 100
  failed: [0, 0],
};

export const TERMINAL_PHASES: readonly FullSyncPhase[] = ["completed", "failed"];
export const isTerminalPhase = (p: FullSyncPhase): boolean => TERMINAL_PHASES.includes(p);

/** The bar position at the START of a phase — i.e. nothing in it is done yet. */
export function phaseFloor(phase: FullSyncPhase): number {
  return PHASE_RANGE[phase][0];
}

// Milestone-based percentage. `done`/`total` are REAL processed counts (rooms,
// (room × plan) combinations, or sent batches). With no countable work the phase
// reports its floor — never its ceiling, and never a time-based guess.
export function phasePercent(phase: FullSyncPhase, done = 0, total = 0): number {
  const [lo, hi] = PHASE_RANGE[phase];
  if (phase === "completed") return 100;
  if (phase === "failed") return 0; // caller preserves the last real percentage
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done <= 0) return lo;
  const ratio = Math.min(1, done / total);
  return Math.min(hi, Math.floor(lo + (hi - lo) * ratio));
}

// ---- the persisted, SAFE progress record ----
// Stored under channel_sync_jobs.payload.progress. It carries no api-key, no
// request headers, no ARI payload and no upstream response body — only counts,
// phase, safe error categories and Channex task UUIDs.
export type FullSyncProgress = {
  /** the channel_sync_jobs row id — the run id */
  runId: string;
  phase: FullSyncPhase;
  percent: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  failedAt: string | null;

  dateFrom: string | null;
  dateTo: string | null;
  days: number;

  roomsTotal: number;
  roomsProjected: number;
  availabilitySubmitted: boolean;
  availabilityValues: number;

  ratePlansTotal: number;
  ratePlansProjected: number;
  restrictionsSubmitted: boolean;
  restrictionValues: number;

  blocked: number;
  warnings: number;
  /** safe category only ('validation', 'timeout', 'partial_warnings', …) */
  errorCategory: string | null;
  /** safe Channex task/request references */
  taskIds: string[];
};

export function initialProgress(runId: string, startedAt: string): FullSyncProgress {
  return {
    runId,
    phase: "validating",
    percent: 0,
    message: PHASE_LABELS.validating,
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    failedAt: null,
    dateFrom: null,
    dateTo: null,
    days: 0,
    roomsTotal: 0,
    roomsProjected: 0,
    availabilitySubmitted: false,
    availabilityValues: 0,
    ratePlansTotal: 0,
    ratePlansProjected: 0,
    restrictionsSubmitted: false,
    restrictionValues: 0,
    blocked: 0,
    warnings: 0,
    errorCategory: null,
    taskIds: [],
  };
}

/** How a finished run should be read. Warnings are NEVER a full success (§8). */
export type FullSyncOutcome = "running" | "success" | "warnings" | "partial_failure" | "failed";

export function outcomeOf(p: FullSyncProgress | null): FullSyncOutcome {
  if (!p) return "running";
  if (p.phase === "completed") return "success";
  if (p.phase !== "failed") return "running";
  if (p.warnings > 0) return "warnings";
  // availability landed but rates/restrictions did not
  if (p.availabilitySubmitted && !p.restrictionsSubmitted) return "partial_failure";
  return "failed";
}

// ---- defensive re-shape of whatever sits in the jsonb column ----
// A record written by an older build (or hand-edited) can never leak an
// unexpected key: every field is copied by name, with its own type check.
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const nstr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown): boolean => v === true;

export function sanitizeProgress(raw: unknown): FullSyncProgress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.runId !== "string") return null;
  if (typeof o.phase !== "string" || !(o.phase in PHASE_RANGE)) return null;
  const phase = o.phase as FullSyncPhase;
  return {
    runId: o.runId,
    phase,
    percent: Math.max(0, Math.min(100, num(o.percent))),
    message: str(o.message, PHASE_LABELS[phase]),
    startedAt: str(o.startedAt, ""),
    updatedAt: str(o.updatedAt, ""),
    completedAt: nstr(o.completedAt),
    failedAt: nstr(o.failedAt),
    dateFrom: nstr(o.dateFrom),
    dateTo: nstr(o.dateTo),
    days: num(o.days),
    roomsTotal: num(o.roomsTotal),
    roomsProjected: num(o.roomsProjected),
    availabilitySubmitted: bool(o.availabilitySubmitted),
    availabilityValues: num(o.availabilityValues),
    ratePlansTotal: num(o.ratePlansTotal),
    ratePlansProjected: num(o.ratePlansProjected),
    restrictionsSubmitted: bool(o.restrictionsSubmitted),
    restrictionValues: num(o.restrictionValues),
    blocked: num(o.blocked),
    warnings: num(o.warnings),
    errorCategory: nstr(o.errorCategory),
    taskIds: Array.isArray(o.taskIds) ? o.taskIds.filter((x): x is string => typeof x === "string") : [],
  };
}
