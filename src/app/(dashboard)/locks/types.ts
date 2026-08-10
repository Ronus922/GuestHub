// Client-safe view types for /locks (D123). Declared here, structurally, rather
// than imported from src/lib/ttlock/* — that graph is server-side and reaching
// into it from a "use client" component is exactly what
// scripts/check-ttlock-secrets.mjs rule 5 forbids.
//
// NOTHING in this file may ever grow a credential, a token or an upstream body.
// The screen shows a door's name, its battery and which room it opens.

export type LockRoomView = {
  roomId: string;
  roomNumber: string;
  name: string | null;
  floor: string | null;
};

/**
 * One keypad code, as the screen sees it (D124).
 *
 * `code` IS the digits — this type is the one place a full code legitimately
 * crosses to the browser, because the authorized operator is the person who has
 * to read it out. It must never be logged, audited or put in an error message;
 * `maskCode` in src/lib/ttlock/passcodes.ts is the form used everywhere else.
 */
export type PasscodeView = {
  code: string;
  /** active | rotating | revoking | revoked | missing */
  state: string;
  updatedAt: string | null;
  /** a safe category (never an upstream body), or null */
  lastError: string | null;
};

export type LockView = {
  id: string;
  /** TTLock's numeric device id — rendered LTR/monospace, never used as a key upstream by the client */
  ttlockLockId: string;
  alias: string;
  battery: number | null;
  /** the mapped room, or null when this lock has no room yet */
  room: LockRoomView | null;
  syncedAt: string | null;
  /** ISO date of the FIRST sync that did not see this lock; null = present */
  missingSince: string | null;
  /** the guest's code for this door; null = never synced or never issued */
  apartmentCode: PasscodeView | null;
  /** the door's manager code — shown, never rotated by this feature */
  managerCode: PasscodeView | null;
  /**
   * Last two digits of every OTHER apartment code that still opens this door —
   * a rotation whose delete has not landed yet, or one the worker gave up on.
   * Two digits, not the code: this names the stale code, it does not re-issue it.
   */
  supersededCodes: string[];
  /**
   * false = no gateway on this lock, so a code we choose cannot be pushed to it
   * and rotation is impossible. Two of the twelve production locks are in this
   * state, which is why the screen says so instead of letting the button fail.
   */
  canRotate: boolean;
};

export type LocksScreenView = {
  /** false → the screen sends the operator to /settings instead of showing an empty table */
  connectionConfigured: boolean;
  locks: LockView[];
  /** every ACTIVE room, for the picker — including ones already taken */
  rooms: LockRoomView[];
  /** last successful sync across this tenant's locks; null = never synced */
  lastSyncedAt: string | null;
  /**
   * The TTLock circuit breaker is open right now: "quota" = the monthly API
   * quota is exhausted, "errors" = repeated upstream failures of another kind,
   * null = healthy. Drives the amber banner; carries no upstream body.
   */
  ttlockAlert: "quota" | "errors" | null;
};

export type SyncLocksSummary = {
  total: number;
  added: number;
  updated: number;
  missing: number;
};

export type SyncPasscodesSummary = {
  locks: number;
  added: number;
  updated: number;
  missing: number;
};

export type BulkRotateItemResult = {
  lockId: string;
  /** room label for the failure toast — never a code */
  label: string;
  ok: boolean;
  /** present only on success; the operator asked for this door's code */
  newCode?: string;
  oldStillActive?: boolean;
  error?: string;
};

export type BulkRotateResult = {
  results: BulkRotateItemResult[];
  succeeded: number;
  total: number;
};

export type RotateCodeResult = {
  /** the new code, for the operator who pressed the button — never logged */
  newCode: string;
  /** true = the superseded code is still on the door; the worker keeps trying */
  oldStillActive: boolean;
};
