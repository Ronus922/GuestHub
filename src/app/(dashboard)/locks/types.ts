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
};

export type LocksScreenView = {
  /** false → the screen sends the operator to /settings instead of showing an empty table */
  connectionConfigured: boolean;
  locks: LockView[];
  /** every ACTIVE room, for the picker — including ones already taken */
  rooms: LockRoomView[];
  /** last successful sync across this tenant's locks; null = never synced */
  lastSyncedAt: string | null;
};

export type SyncLocksSummary = {
  total: number;
  added: number;
  updated: number;
  missing: number;
};
