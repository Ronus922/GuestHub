"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import {
  syncLocksAction, syncPasscodesAction, mapLockToRoomAction, unmapLockAction,
  rotateApartmentCodeAction,
} from "./actions";
import type { LocksScreenView, LockView, LockRoomView, PasscodeView } from "./types";

// ============================================================
// מנעולים וקודים (D123) — the lock board.
//
// THREE STATES, ALL VISIBLE. The screen exists to answer one question at a
// glance: which apartment doors are covered? So it shows
//   · locks bound to a room,
//   · locks with no room yet,
//   · and ACTIVE ROOMS WITH NO LOCK — the one the operator cannot see anywhere
//     else. This property has more rooms than locks, so that third list is not
//     an edge case, it is the normal state, and hiding it would turn "12 locks,
//     all mapped" into a false all-clear.
//
// The interaction is Beds24's room-mapping section (channels/Beds24Section.tsx),
// with the axis inverted: there the row is a local room picking a remote unit,
// here the row is a LOCK picking a room. The alias is how a human recognises a
// door — TTLock calls it "דירה 4 כניסה", not 402 — so the alias leads and the
// room is the thing being chosen.
//
// CODES (D124). Every mapped door shows the guest's current code, masked until
// the operator asks for it. Three rules the cell obeys:
//
//  · MASKED BY DEFAULT. A door code on a screen is a door code over the
//    shoulder of whoever walks past reception. Revealing is a deliberate act.
//  · THE OLD CODE'S FATE IS VISIBLE. When a rotation's delete has not landed,
//    the row says the previous code STILL OPENS THE DOOR, and keeps saying it
//    until the worker's retry succeeds. Silence there would mean an operator
//    believing a code was retired while it still works.
//  · THE MANAGER CODE IS SHOWN AND NEVER TOUCHED. It has no rotate button —
//    not a disabled one, none — because it is the code that gets a person in
//    when everything else has failed.
// ============================================================

const dtFormatter = new Intl.DateTimeFormat("he-IL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Jerusalem",
});

function fmt(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : dtFormatter.format(d);
}

function roomLabel(r: LockRoomView): string {
  return r.name ? `${r.roomNumber} · ${r.name}` : r.roomNumber;
}

// A battery TTLock did not report is "—", never 0: an unknown charge and a flat
// one are not the same fact, and showing 0 would send someone to a working door.
const LOW_BATTERY = 20;

// How long a freshly minted code stays on screen before it re-masks itself.
// Long enough to write down or read out; short enough that a walk-away does not
// leave a live door code facing the lobby.
const REVEAL_MS = 10_000;

export function LocksBoard({ initial }: { initial: LocksScreenView }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, startSync] = useTransition();
  // Which cells are currently showing their digits, keyed `${lockId}:${role}`.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [confirmRotate, setConfirmRotate] = useState<string | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // A pending re-mask must not fire into an unmounted tree, and a navigation
  // away is exactly when you least want a timer still holding a code visible.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  function setReveal(key: string, on: boolean, autoHideMs?: number) {
    const existing = timers.current.get(key);
    if (existing) {
      clearTimeout(existing);
      timers.current.delete(key);
    }
    setRevealed((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
    if (on && autoHideMs) {
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          setRevealed((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }, autoHideMs),
      );
    }
  }
  // Which mapped rows the operator has opened for editing. Unmapped locks are
  // always editing — same rule Beds24's table uses.
  const [editRows, setEditRows] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const { locks, rooms } = initial;
  const busy = syncing || busyId !== null;

  const mappedCount = locks.filter((l) => l.room).length;
  const takenRoomIds = useMemo(
    () => new Set(locks.map((l) => l.room?.roomId).filter(Boolean) as string[]),
    [locks],
  );
  const uncoveredRooms = useMemo(
    () => rooms.filter((r) => !takenRoomIds.has(r.roomId)),
    [rooms, takenRoomIds],
  );
  const missingCount = locks.filter((l) => l.missingSince).length;

  function draftOf(lock: LockView): string {
    return drafts[lock.id] ?? lock.room?.roomId ?? "";
  }

  function onSync() {
    startSync(async () => {
      // Two reads, one button. The lock list needs locks.map and the code list
      // needs only locks.view, so the second is attempted even when the first
      // was refused — a view-only operator can still refresh the codes.
      const locksRes = await syncLocksAction();
      const codesRes = await syncPasscodesAction();

      const parts: string[] = [];
      if (locksRes.success) {
        const s = locksRes.data!;
        parts.push(`נמצאו ${s.total} מנעולים`);
        if (s.added) parts.push(`${s.added} חדשים`);
        if (s.missing) parts.push(`${s.missing} לא הופיעו בסנכרון`);
      }
      if (codesRes.success) {
        const c = codesRes.data!;
        parts.push(`${c.added + c.updated} קודים`);
        if (c.missing) parts.push(`${c.missing} קודים נמחקו מחוץ למערכת`);
      }

      if (parts.length === 0) {
        toast.error(locksRes.success ? "" : locksRes.error || "הסנכרון נכשל");
        return;
      }
      toast.success(parts.join(" · "));
      router.refresh();
    });
  }

  async function onRotate(lock: LockView) {
    setConfirmRotate(null);
    setRotatingId(lock.id);
    const res = await rotateApartmentCodeAction(lock.id);
    setRotatingId(null);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    // Revealed on purpose, and only for as long as it takes to use it.
    setReveal(`${lock.id}:apartment`, true, REVEAL_MS);
    toast.success(
      res.data!.oldStillActive
        ? "נוצר קוד חדש — הקוד הישן עדיין פעיל על הדלת והמערכת תנסה למחוק אותו שוב"
        : "הקוד הוחלף",
    );
    router.refresh();
  }

  async function onMap(lock: LockView) {
    const roomId = draftOf(lock);
    if (!roomId) return;
    setBusyId(lock.id);
    const res = await mapLockToRoomAction(lock.id, roomId);
    setBusyId(null);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    setEditRows((prev) => {
      const next = new Set(prev);
      next.delete(lock.id);
      return next;
    });
    toast.success(`“${lock.alias}” שויך לחדר`);
    router.refresh();
  }

  async function onUnmap(lock: LockView) {
    setBusyId(lock.id);
    const res = await unmapLockAction(lock.id);
    setBusyId(null);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(`השיוך של “${lock.alias}” בוטל`);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5 p-[26px]" dir="rtl">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="h1">מנעולים</h1>
            <span className="chip chip-neutral">
              <bdi className="ltr-num">
                {mappedCount}/{locks.length}
              </bdi>{" "}
              ממופים
            </span>
            {uncoveredRooms.length > 0 && (
              <span className="chip chip-approval">
                <span className="dot" />
                <bdi className="ltr-num">{uncoveredRooms.length}</bdi> חדרים ללא מנעול
              </span>
            )}
            {missingCount > 0 && (
              <span className="chip chip-failed">
                <span className="dot" />
                <bdi className="ltr-num">{missingCount}</bdi> לא הופיעו בסנכרון
              </span>
            )}
          </div>
          <p className="t-secondary">
            המנעולים החכמים של הנכס, ושיוך כל מנעול לחדר. הסנכרון מושך את רשימת המנעולים
            מ-TTLock; השיוך לחדר נקבע כאן בלבד ואינו נדרס על ידי סנכרון.
          </p>
        </div>

        <button type="button" onClick={onSync} disabled={busy || !initial.connectionConfigured} className="btn btn-primary">
          <Icon name="refresh" size={20} />
          {syncing ? "מסנכרן…" : "סנכרון מנעולים"}
        </button>
      </div>

      {!initial.connectionConfigured ? (
        <NoConnection />
      ) : (
        <>
          {initial.lastSyncedAt && (
            <p className="t-label text-muted">
              סנכרון אחרון: <bdi className="ltr-num">{fmt(initial.lastSyncedAt)}</bdi>
            </p>
          )}

          {locks.length === 0 ? (
            <NeverSynced />
          ) : (
            <LocksTable
              locks={locks}
              rooms={rooms}
              takenRoomIds={takenRoomIds}
              busy={busy}
              busyId={busyId}
              revealed={revealed}
              onToggleReveal={(key) => setReveal(key, !revealed.has(key))}
              confirmRotate={confirmRotate}
              onConfirmRotate={setConfirmRotate}
              rotatingId={rotatingId}
              onRotate={onRotate}
              editRows={editRows}
              draftOf={draftOf}
              onDraft={(id, v) => setDrafts((p) => ({ ...p, [id]: v }))}
              onEdit={(id) => setEditRows((p) => new Set(p).add(id))}
              onCancelEdit={(id) =>
                setEditRows((p) => {
                  const next = new Set(p);
                  next.delete(id);
                  return next;
                })
              }
              onMap={onMap}
              onUnmap={onUnmap}
            />
          )}

          {/* The list nothing else in the product shows. */}
          <UncoveredRooms rooms={uncoveredRooms} total={rooms.length} />
        </>
      )}
    </div>
  );
}

function NoConnection() {
  return (
    <div className="card">
      <div className="empty-state">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-hover">
          <Icon name="lock" size={24} className="text-faint" />
        </div>
        <p className="empty-t">חיבור TTLock טרם הוגדר</p>
        <p className="empty-s max-w-md">
          כדי למשוך את רשימת המנעולים יש להגדיר תחילה את החיבור לחשבון TTLock של הנכס,
          במסך ההגדרות תחת &quot;מנעולים חכמים&quot;.
        </p>
        <Link href="/settings" className="btn btn-primary">
          <Icon name="settings" size={20} />
          למסך ההגדרות
        </Link>
      </div>
    </div>
  );
}

function NeverSynced() {
  return (
    <div className="card">
      <div className="empty-state">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-hover">
          <Icon name="lock" size={24} className="text-faint" />
        </div>
        <p className="empty-t">אין עדיין מנעולים</p>
        <p className="empty-s max-w-md">
          החיבור ל-TTLock מוגדר, אך רשימת המנעולים טרם נמשכה. לחצו על &quot;סנכרון מנעולים&quot;
          כדי למשוך אותה, ואז שייכו כל מנעול לחדר שלו.
        </p>
      </div>
    </div>
  );
}

function BatteryCell({ battery }: { battery: number | null }) {
  if (battery === null) return <span className="text-faint">—</span>;
  const low = battery <= LOW_BATTERY;
  return (
    <span className={low ? "text-status-danger" : "text-text2"}>
      <bdi className="ltr-num tabular-nums">{battery}%</bdi>
    </span>
  );
}

/**
 * One code cell: masked digits, an eye to reveal, and a click-to-copy once
 * revealed. Copying is only offered on the revealed form — a button that copies
 * something you cannot see is a button that puts a door code on the clipboard
 * by accident.
 */
function CodeCell({
  passcode,
  revealKey,
  revealed,
  onToggleReveal,
  label,
}: {
  passcode: PasscodeView;
  revealKey: string;
  revealed: boolean;
  onToggleReveal: (key: string) => void;
  label: string;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(passcode.code);
      toast.success("הקוד הועתק");
    } catch {
      // A clipboard the browser refused (permissions, insecure origin) is not
      // an error worth a red toast — the digits are on screen to be read.
      toast.error("ההעתקה נכשלה — ניתן להקליד את הקוד ידנית");
    }
  }

  return (
    <div className="flex items-center gap-2">
      {revealed ? (
        <button
          type="button"
          onClick={copy}
          className="rounded-lg px-2 py-0.5 hover:bg-hover"
          title="העתקת הקוד"
          aria-label={`${label} — העתקה`}
        >
          <bdi className="ltr-num font-mono tabular-nums font-bold text-ink">{passcode.code}</bdi>
        </button>
      ) : (
        <bdi className="ltr-num font-mono tabular-nums px-2 py-0.5 text-muted" aria-hidden="true">
          •••••
        </bdi>
      )}
      <button
        type="button"
        onClick={() => onToggleReveal(revealKey)}
        className="rounded-lg p-2 text-muted hover:bg-hover"
        aria-label={revealed ? `הסתרת ${label}` : `הצגת ${label}`}
      >
        <Icon name={revealed ? "eye-off" : "eye"} size={17} />
      </button>
    </div>
  );
}

/** The apartment-code cell in full: the code, its warnings, and the rotate control. */
function ApartmentCodeCell({
  lock,
  revealed,
  onToggleReveal,
  confirming,
  onConfirm,
  rotating,
  onRotate,
  busy,
}: {
  lock: LockView;
  revealed: Set<string>;
  onToggleReveal: (key: string) => void;
  confirming: boolean;
  onConfirm: (id: string | null) => void;
  rotating: boolean;
  onRotate: (l: LockView) => void;
  busy: boolean;
}) {
  // A door with no room has no apartment to name a code after, and mapping is
  // the operator's next step anyway.
  if (!lock.room) return <span className="t-label text-faint">שייך חדר תחילה</span>;

  const key = `${lock.id}:apartment`;
  const code = lock.apartmentCode;
  // Derived from the OTHER live rows, not from the displayed one. The displayed
  // code is the new one; the stale code is a different row, and keying the
  // warning off the displayed row's state made this warning unreachable in
  // exactly the case it exists for.
  const stale = lock.supersededCodes;

  return (
    <div className="flex flex-col gap-1.5">
      {code ? (
        <CodeCell
          passcode={code}
          revealKey={key}
          revealed={revealed.has(key)}
          onToggleReveal={onToggleReveal}
          label="קוד הדירה"
        />
      ) : (
        <span className="t-label text-faint">אין קוד</span>
      )}

      {/* The code was removed in the TTLock app, not here. Rotation is the fix:
          it puts a code back on the door. */}
      {code?.state === "missing" && (
        <span className="t-label flex items-center gap-1.5 text-status-danger">
          <Icon name="warning" size={13.5} />
          הקוד נמחק מחוץ למערכת
        </span>
      )}

      {/* Stays until the worker's retry lands. See the file header. */}
      {stale.map((last2) => (
        <span key={last2} className="t-label flex items-center gap-1.5 text-status-warning">
          <Icon name="warning" size={13.5} />
          הקוד הישן <bdi className="ltr-num">••{last2}</bdi> עדיין פעיל על הדלת — המערכת תנסה למחוק אותו שוב
        </span>
      ))}

      {!lock.canRotate ? (
        <span className="t-label text-muted">אין שער (Gateway) — לא ניתן להחליף קוד מרחוק</span>
      ) : confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="t-label text-text2">הקוד הנוכחי יפסיק לפעול. להחליף?</span>
          <button type="button" onClick={() => onRotate(lock)} disabled={busy} className="btn btn-sm btn-primary">
            החלפה
          </button>
          <button type="button" onClick={() => onConfirm(null)} disabled={busy} className="btn btn-sm btn-secondary">
            ביטול
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onConfirm(lock.id)}
          disabled={busy || rotating}
          className="btn btn-sm btn-secondary self-start"
        >
          <Icon name="refresh" size={17} />
          {rotating ? "מחליף…" : "החלפת קוד"}
        </button>
      )}
    </div>
  );
}

function LocksTable({
  locks,
  rooms,
  takenRoomIds,
  busy,
  busyId,
  revealed,
  onToggleReveal,
  confirmRotate,
  onConfirmRotate,
  rotatingId,
  onRotate,
  editRows,
  draftOf,
  onDraft,
  onEdit,
  onCancelEdit,
  onMap,
  onUnmap,
}: {
  locks: LockView[];
  rooms: LockRoomView[];
  takenRoomIds: Set<string>;
  busy: boolean;
  busyId: string | null;
  revealed: Set<string>;
  onToggleReveal: (key: string) => void;
  confirmRotate: string | null;
  onConfirmRotate: (id: string | null) => void;
  rotatingId: string | null;
  onRotate: (l: LockView) => void;
  editRows: Set<string>;
  draftOf: (l: LockView) => string;
  onDraft: (id: string, v: string) => void;
  onEdit: (id: string) => void;
  onCancelEdit: (id: string) => void;
  onMap: (l: LockView) => void;
  onUnmap: (l: LockView) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon name="lock" size={17} className="text-muted" />
        <h2 className="h3">מנעולים ושיוך לחדרים</h2>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[1080px] text-sm">
          <thead>
            <tr className="border-b border-line bg-hover/40">
              <th className="t-label px-4 py-3 text-start text-faint">מנעול</th>
              <th className="t-label px-4 py-3 text-start text-faint">מזהה TTLock</th>
              <th className="t-label px-4 py-3 text-start text-faint">סוללה</th>
              <th className="t-label px-4 py-3 text-start text-faint">חדר</th>
              <th className="t-label px-4 py-3 text-start text-faint">קוד דירה</th>
              <th className="t-label px-4 py-3 text-start text-faint">קוד מנהל</th>
              <th className="t-label px-4 py-3 text-start text-faint">סטטוס</th>
              <th className="t-label px-4 py-3 text-start text-faint">סונכרן</th>
              <th className="t-label px-4 py-3 text-start text-faint">פעולות</th>
            </tr>
          </thead>
          <tbody>
            {locks.map((lock) => {
              const editing = !lock.room || editRows.has(lock.id);
              const draft = draftOf(lock);
              const thisBusy = busyId === lock.id;
              const unchanged = (lock.room?.roomId ?? "") === draft;

              return (
                <tr key={lock.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className="font-bold text-ink">{lock.alias}</span>
                      {/* A lock the last sync did not return. It KEEPS its
                          mapping and its row — the warning is the whole point. */}
                      {lock.missingSince && (
                        <span className="t-label flex items-center gap-1.5 text-status-danger">
                          <Icon name="warning" size={13.5} />
                          לא הופיע בסנכרון מאז <bdi className="ltr-num">{fmt(lock.missingSince)}</bdi>
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <bdi className="ltr-num font-mono tabular-nums text-text2">{lock.ttlockLockId}</bdi>
                  </td>
                  <td className="px-4 py-3">
                    <BatteryCell battery={lock.battery} />
                  </td>
                  <td className="px-4 py-3">
                    {editing ? (
                      <select
                        className="field-input min-w-[200px]"
                        value={draft}
                        onChange={(e) => onDraft(lock.id, e.target.value)}
                        disabled={busy}
                        aria-label={`חדר עבור המנעול ${lock.alias}`}
                      >
                        <option value="">בחר חדר…</option>
                        {rooms.map((r) => {
                          // A room held by ANOTHER lock stays listed but is not
                          // selectable: one room, one lock (070). Hiding it
                          // would read as "that room does not exist".
                          const takenByOther = takenRoomIds.has(r.roomId) && r.roomId !== lock.room?.roomId;
                          return (
                            <option key={r.roomId} value={r.roomId} disabled={takenByOther}>
                              {roomLabel(r)}
                              {takenByOther ? " — משויך למנעול אחר" : ""}
                            </option>
                          );
                        })}
                      </select>
                    ) : (
                      <span className="text-ink">{lock.room ? roomLabel(lock.room) : "—"}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <ApartmentCodeCell
                      lock={lock}
                      revealed={revealed}
                      onToggleReveal={onToggleReveal}
                      confirming={confirmRotate === lock.id}
                      onConfirm={onConfirmRotate}
                      rotating={rotatingId === lock.id}
                      onRotate={onRotate}
                      busy={busy || rotatingId !== null}
                    />
                  </td>
                  <td className="px-4 py-3 align-top">
                    {/* Shown, never rotated: no button here, not even disabled. */}
                    {lock.managerCode ? (
                      <div className="flex flex-col gap-1.5">
                        <span className="chip chip-neutral self-start">
                          <Icon name="key" size={13.5} />
                          מנהל
                        </span>
                        <CodeCell
                          passcode={lock.managerCode}
                          revealKey={`${lock.id}:manager`}
                          revealed={revealed.has(`${lock.id}:manager`)}
                          onToggleReveal={onToggleReveal}
                          label="קוד המנהל"
                        />
                      </div>
                    ) : (
                      <span className="t-label text-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {lock.room ? (
                      <span className="chip chip-paid">
                        <span className="dot" />
                        משויך
                      </span>
                    ) : (
                      <span className="chip chip-neutral">
                        <span className="dot" />
                        ללא חדר
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <bdi className="ltr-num">{fmt(lock.syncedAt)}</bdi>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {editing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => onMap(lock)}
                            disabled={busy || !draft || unchanged}
                            className="btn btn-sm btn-primary"
                          >
                            {thisBusy ? "משייך…" : lock.room ? "עדכון שיוך" : "שיוך לחדר"}
                          </button>
                          {lock.room && (
                            <button
                              type="button"
                              onClick={() => onCancelEdit(lock.id)}
                              disabled={busy}
                              className="btn btn-sm btn-secondary"
                            >
                              ביטול עריכה
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => onEdit(lock.id)}
                            disabled={busy}
                            className="btn btn-sm btn-secondary"
                          >
                            שינוי
                          </button>
                          <button
                            type="button"
                            onClick={() => onUnmap(lock)}
                            disabled={busy}
                            className="btn btn-sm btn-secondary"
                          >
                            {thisBusy ? "מבטל…" : "ביטול שיוך"}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Active rooms no lock points at. This property has more rooms than locks, so
 * an empty locks-side view would still leave doors uncovered — and nothing else
 * in the product would say so.
 */
function UncoveredRooms({ rooms, total }: { rooms: LockRoomView[]; total: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon name="rooms" size={17} className="text-muted" />
        <h2 className="h3">חדרים ללא מנעול</h2>
        <span className={`chip ${rooms.length > 0 ? "chip-approval" : "chip-paid"}`}>
          <span className="dot" />
          <bdi className="ltr-num">
            {rooms.length}/{total}
          </bdi>
        </span>
      </div>

      <div className="card">
        <div className="card-bd">
          {rooms.length === 0 ? (
            <div className="flex items-center gap-3">
              <Icon name="shield-check" size={20} className="shrink-0 text-status-success" />
              <p className="t-secondary">לכל החדרים הפעילים משויך מנעול.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="t-secondary text-text2">
                לחדרים הבאים אין מנעול משויך. עד שישויך מנעול, לא ניתן יהיה להנפיק להם קוד כניסה.
              </p>
              <ul className="flex flex-wrap gap-2">
                {rooms.map((r) => (
                  <li key={r.roomId} className="rounded-lg border border-line bg-hover px-3 py-2">
                    <bdi className="ltr-num font-bold text-ink">{r.roomNumber}</bdi>
                    {r.name && <span className="t-label ms-2 text-muted">{r.name}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
