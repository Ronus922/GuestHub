"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import {
  syncLocksAction, syncPasscodesAction, mapLockToRoomAction, unmapLockAction,
  rotateApartmentCodeAction, bulkRotateApartmentCodesAction,
} from "./actions";
import type { LocksScreenView, LockView, LockRoomView, PasscodeView } from "./types";

// ============================================================
// מנעולים וקודים — V2 (D125), a one-to-one port of the owner's design
// reference (prompts/locks-design-ref.html).
//
// WHAT THE SCREEN IS FOR, unchanged from V1: answer "which apartment doors are
// covered, and what is the code on each" at a glance. V2 adds the search,
// quick-filters, sorting, multi-select and the bulk-rotate drawer, and moves
// the layout onto the reference's own column grid (src/app/styles/locks.css).
//
// FIVE ELEMENTS OF THE REFERENCE ARE DELIBERATELY ABSENT, per the owner's
// review — they demo capabilities that do not exist or were rejected:
// Google-Sheets export, "שליחת הקוד לאורחים" (messaging is off), "החלף גם את
// קוד המנהל" (a bulk manager rotation is a lockout hazard), "החלה מיידית"
// (rotation is always immediate) and the PDF button. Absent means ABSENT —
// not disabled, not "coming soon".
//
// THE CODE RULES CARRY OVER FROM D124 AND ARE NOT NEGOTIABLE HERE:
//  · masked by default; revealing is a deliberate act,
//  · the `#` suffix is PRESENTATION — display and clipboard only, never the
//    stored/transmitted/audited value,
//  · the manager code is shown and never rotated,
//  · a superseded code that still opens the door says so until the retry lands.
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

// The keypad terminates a code with #, so that is how it is read out and how it
// lands on the clipboard. Presentation only — see the header and guard rule 11.
const forDisplay = (code: string) => `${code}#`;

const REVEAL_MS = 10_000;

// The reference's battCls, verbatim: b>=60 ? hi : b>=30 ? mid : lo. The prompt
// quoted 70/40 in passing, but the HTML is the contract for look and this is
// what it does. The <40 LOW-BATTERY FILTER below is a different number in the
// reference too, and also kept as-is.
const battClass = (b: number) => (b >= 60 ? "b-hi" : b >= 30 ? "b-mid" : "b-lo");
const LOW_BATTERY = 40;

type FilterKey = "all" | "ok" | "err" | "nogw" | "lowbatt" | "noroom";
type SortKey = "lock" | "batt" | "room" | "status";
type RowStatus = "ok" | "err" | "none";

/**
 * A door is 'err' when something needs a human: the lock vanished from a sync,
 * its code was deleted upstream, a superseded code is still live, or a drain
 * gave up. 'none' is simply unmapped. Everything else is 'ok'.
 */
function statusOf(l: LockView): RowStatus {
  if (!l.room) return "none";
  if (l.missingSince) return "err";
  if (l.supersededCodes.length > 0) return "err";
  if (l.apartmentCode?.state === "missing") return "err";
  if (l.apartmentCode?.lastError) return "err";
  return "ok";
}

const STATUS_LABEL: Record<RowStatus, string> = {
  ok: "משויך",
  err: "שגיאת סנכרון",
  none: "לא משויך",
};
const STATUS_CLASS: Record<RowStatus, string> = { ok: "s-ok", err: "s-err", none: "s-none" };
const STATUS_ORDER: Record<RowStatus, number> = { err: 0, none: 1, ok: 2 };

function roomLabel(r: LockRoomView): string {
  return r.name ? r.name : `חדר ${r.roomNumber}`;
}

/**
 * Client-side code validation, for immediate feedback only.
 *
 * It deliberately does NOT know which codes are already live on a door — that
 * check needs the database and belongs to the server, which runs the identical
 * `codeRejection` for every code before it can reach the hardware. This
 * function exists so the operator sees "4–6 ספרות" while typing, not so the
 * browser decides what is safe.
 */
function clientCodeError(code: string): string | null {
  if (!/^\d{4,6}$/.test(code)) return "4–6 ספרות";
  if (code.startsWith("0")) return "לא להתחיל באפס";
  if (/^(\d)\1*$/.test(code)) return "לא ספרה חוזרת";
  const up = code.split("").every((c, i, a) => i === 0 || c.charCodeAt(0) - a[i - 1].charCodeAt(0) === 1);
  const down = code.split("").every((c, i, a) => i === 0 || c.charCodeAt(0) - a[i - 1].charCodeAt(0) === -1);
  if (up || down) return "לא רצף";
  return null;
}

/** A 5-digit seed, matching the server's own draw width. */
function draw(): string {
  return String(Math.floor(10000 + Math.random() * 90000));
}

type DrawerState = { lockIds: string[]; single: boolean } | null;

export function LocksBoard({ initial }: { initial: LocksScreenView }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, startSync] = useTransition();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sortKey, setSortKey] = useState<SortKey>("lock");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [revealAll, setRevealAll] = useState(false);
  const [rotatingId, setRotatingId] = useState<string | null>(null);

  const [drawer, setDrawer] = useState<DrawerState>(null);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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

  const [editRows, setEditRows] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const { locks, rooms } = initial;
  const busy = syncing || busyId !== null || rotatingId !== null;

  const mappedCount = locks.filter((l) => l.room).length;
  const takenRoomIds = useMemo(
    () => new Set(locks.map((l) => l.room?.roomId).filter(Boolean) as string[]),
    [locks],
  );
  const uncoveredRooms = useMemo(
    () => rooms.filter((r) => !takenRoomIds.has(r.roomId)),
    [rooms, takenRoomIds],
  );

  const counts = useMemo(() => {
    const c = { all: locks.length, ok: 0, err: 0, nogw: 0, lowbatt: 0, noroom: 0 };
    for (const l of locks) {
      const s = statusOf(l);
      if (s === "ok") c.ok += 1;
      if (s === "err") c.err += 1;
      if (!l.canRotate) c.nogw += 1;
      if (l.battery !== null && l.battery < LOW_BATTERY) c.lowbatt += 1;
      if (!l.room) c.noroom += 1;
    }
    return c;
  }, [locks]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = locks.filter((l) => {
      if (q) {
        const hay = `${l.room ? `${l.room.name ?? ""} ${l.room.roomNumber}` : ""} ${l.alias} ${l.ttlockLockId}`;
        if (!hay.toLowerCase().includes(q)) return false;
      }
      const s = statusOf(l);
      if (filter === "ok") return s === "ok";
      if (filter === "err") return s === "err";
      if (filter === "nogw") return !l.canRotate;
      if (filter === "lowbatt") return l.battery !== null && l.battery < LOW_BATTERY;
      if (filter === "noroom") return !l.room;
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return filtered.slice().sort((a, b) => {
      if (sortKey === "batt") return ((a.battery ?? -1) - (b.battery ?? -1)) * dir;
      if (sortKey === "status") return (STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)]) * dir;
      // Hebrew collation — an alphabetical sort that ignores it puts every
      // Hebrew room name in one undifferentiated block.
      const av = sortKey === "room" ? (a.room ? roomLabel(a.room) : "תתת") : a.alias;
      const bv = sortKey === "room" ? (b.room ? roomLabel(b.room) : "תתת") : b.alias;
      return av.localeCompare(bv, "he") * dir;
    });
  }, [locks, search, filter, sortKey, sortDir]);

  const allVisibleSelected = visible.length > 0 && visible.every((l) => selected.has(l.id));
  const someSelected = selected.size > 0;

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function draftOf(lock: LockView): string {
    return drafts[lock.id] ?? lock.room?.roomId ?? "";
  }

  function onSync(lockIds?: string[]) {
    startSync(async () => {
      const locksRes = lockIds ? { success: true as const, data: null } : await syncLocksAction();
      const codesRes = await syncPasscodesAction(lockIds);

      const parts: string[] = [];
      if (locksRes.success && locksRes.data) {
        const s = locksRes.data;
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
        toast.error(
          (!locksRes.success && locksRes.error) || (!codesRes.success && codesRes.error) || "הסנכרון נכשל",
        );
        return;
      }
      toast.success(parts.join(" · "));
      router.refresh();
    });
  }

  async function onRotate(lock: LockView) {
    setRotatingId(lock.id);
    const res = await rotateApartmentCodeAction(lock.id);
    setRotatingId(null);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    setReveal(`${lock.id}:apartment`, true, REVEAL_MS);
    toast.success(
      res.data!.oldStillActive
        ? "נוצר קוד חדש — הקוד הישן עדיין פעיל על הדלת והמערכת תנסה למחוק אותו שוב"
        : `הקוד הוחלף · ${forDisplay(res.data!.newCode)}`,
    );
    // Targeted refresh — one listKeyboardPwd call for THIS door — so the screen
    // verifies against the door what we ourselves just changed, without any
    // polling. Deliberately silent on failure: the rotation already succeeded
    // and is in the DB, the screen is right without it, and an error toast here
    // would bury the new code the operator has to read out.
    try {
      await syncPasscodesAction([lock.id]);
    } catch {
      /* soft-fail on purpose */
    }
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

  async function onBulkApply(items: { lockId: string; code: string }[]) {
    const res = await bulkRotateApartmentCodesAction(items);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    const { results, succeeded, total } = res.data!;
    setDrawer(null);

    for (const r of results) {
      if (r.ok) setReveal(`${r.lockId}:apartment`, true, REVEAL_MS);
      else toast.error(`${r.label}: ${r.error}`);
    }
    toast.success(`הקוד הוחלף ב-${succeeded} מתוך ${total} דירות`);
    // Same targeted post-rotate refresh as onRotate: ONE action call, one
    // upstream call per rotated door, silent on failure.
    const okIds = results.filter((r) => r.ok).map((r) => r.lockId);
    if (okIds.length > 0) {
      try {
        await syncPasscodesAction(okIds);
      } catch {
        /* soft-fail on purpose */
      }
    }
    router.refresh();
  }

  // The drawer's targets: the selection, or the ONE lock the bolt opened. Bolt
  // never touches the selection — opening it neither selects that row nor
  // clears an existing selection, and closing restores the screen exactly.
  const drawerLocks = useMemo(
    () => (drawer ? locks.filter((l) => drawer.lockIds.includes(l.id)) : []),
    [drawer, locks],
  );

  return (
    <div className="lk-screen">
      <div className="lk-hd">
        <h1 className="h1">מנעולים</h1>
        <div className="lk-hd-badges">
          <span className="lk-pill">
            <bdi className="ltr-num">
              {mappedCount}/{locks.length}
            </bdi>{" "}
            ממופים
          </span>
          {uncoveredRooms.length > 0 && (
            <span className="lk-pill warn">
              <span className="d" />
              <bdi className="ltr-num">{uncoveredRooms.length}</bdi> חדרים ללא מנעול
            </span>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {initial.lastSyncedAt && (
          <div className="lk-sync-t">
            סונכרן לאחרונה: <bdi className="ltr-num">{fmt(initial.lastSyncedAt)}</bdi>
          </div>
        )}
        <button
          type="button"
          onClick={() => onSync()}
          disabled={busy || !initial.connectionConfigured}
          className="btn btn-primary"
        >
          <Icon name={syncing ? "spinner" : "sync"} size={20} className={syncing ? "lk-spin" : undefined} />
          {syncing ? "מסנכרן…" : "סנכרון מנעולים"}
        </button>
      </div>

      <p className="lk-desc">
        המנעולים החכמים של הנכס, ושיוך כל מנעול לחדר. הנתונים מתעדכנים בלחיצה על
        סנכרון; שינויים שבוצעו באפליקציית TTLock ייראו כאן רק לאחר סנכרון. השיוך
        לחדר נקבע כאן בלבד ואינו נדרס על ידי סנכרון.
      </p>

      {initial.ttlockAlert && (
        <div className="lk-alert">
          <div className="lk-note">
            <Icon name="warning" size={20} />
            {initial.ttlockAlert === "quota"
              ? "מכסת הקריאות החודשית של TTLock מוצתה. סנכרון והחלפת קודים ייכשלו כנראה עד לאיפוס המכסה — נסו שוב מאוחר יותר. הנתונים במסך משקפים את הסנכרון האחרון שהצליח."
              : "קריאות אחרונות ל-TTLock נכשלו ברציפות. אפשר לנסות לסנכרן שוב — הצלחה תסיר הודעה זו."}
          </div>
        </div>
      )}

      {!initial.connectionConfigured ? (
        <NoConnection />
      ) : (
        <>
          <div className="lk-bar">
            <div className="lk-search">
              <Icon name="search" size={20} className="text-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="חיפוש לפי חדר, מזהה מנעול או TTLock…"
                aria-label="חיפוש מנעולים"
              />
            </div>
            <span className="lk-vsep" />
            {(
              [
                ["all", "הכל", counts.all],
                ["ok", "מסונכרן", counts.ok],
                ["err", "שגיאת סנכרון", counts.err],
                ["nogw", "ללא שער", counts.nogw],
                ["lowbatt", "סוללה חלשה", counts.lowbatt],
                ["noroom", "ללא שיוך", counts.noroom],
              ] as [FilterKey, string, number][]
            ).map(([key, label, n]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`lk-qchip${filter === key ? " on" : ""}`}
                aria-pressed={filter === key}
              >
                {label}
                <span className="n">
                  <bdi className="ltr-num">{n}</bdi>
                </span>
              </button>
            ))}
          </div>

          {someSelected && (
            <div className="lk-selbar">
              <span className="cnt">
                נבחרו <bdi className="ltr-num">{selected.size}</bdi> דירות
              </span>
              <button type="button" onClick={() => setSelected(new Set())} className="btn btn-sm btn-secondary">
                <Icon name="close" size={17} />
                ניקוי בחירה
              </button>
              <span className="sp" />
              <button
                type="button"
                onClick={() => onSync([...selected])}
                disabled={busy}
                className="btn btn-sm btn-secondary"
              >
                <Icon name="sync" size={17} />
                סנכרון מ-TTLock
              </button>
              <button
                type="button"
                onClick={() => setDrawer({ lockIds: [...selected], single: false })}
                disabled={busy}
                className="btn btn-sm btn-primary"
              >
                <Icon name="password" size={17} />
                החלפת קוד דירה
              </button>
            </div>
          )}

          <div className="lk-card">
            <div className="lk-card-hd">
              <Icon name="lock" size={20} className="text-muted" />
              <div className="lk-card-t">מנעולים ושיוך לחדרים</div>
              <div className="sp" />
              <button
                type="button"
                onClick={() => setRevealAll((v) => !v)}
                className="btn btn-sm btn-secondary"
              >
                <Icon name={revealAll ? "eye-off" : "eye"} size={17} />
                {revealAll ? "הסתרת כל הקודים" : "הצגת כל הקודים"}
              </button>
            </div>

            <div className="lk-scroll">
              {locks.length === 0 ? (
                <NeverSynced />
              ) : (
                <div className="lk-gt">
                  <div className="lk-head">
                    <div className="lk-th c">
                      <button
                        type="button"
                        className={`lk-cb${allVisibleSelected ? " on" : someSelected ? " some" : ""}`}
                        onClick={() =>
                          setSelected(allVisibleSelected ? new Set() : new Set(visible.map((l) => l.id)))
                        }
                        aria-label={allVisibleSelected ? "ניקוי בחירה" : "בחירת הכל"}
                      >
                        <Icon name={allVisibleSelected ? "check" : "minus"} size={13.5} />
                      </button>
                    </div>
                    <SortTh label="מנעול" k="lock" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <SortTh label="סוללה" k="batt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <SortTh label="חדר" k="room" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <div className="lk-th">קוד דירה</div>
                    <div className="lk-th">קוד מנהל</div>
                    <SortTh label="סטטוס וסנכרון" k="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <div className="lk-th c">פעולות</div>
                    <div className="lk-th" />
                  </div>

                  {visible.map((lock) => (
                    <LockRow
                      key={lock.id}
                      lock={lock}
                      rooms={rooms}
                      takenRoomIds={takenRoomIds}
                      selected={selected.has(lock.id)}
                      onToggleRow={toggleRow}
                      revealed={revealed}
                      revealAll={revealAll}
                      onToggleReveal={(key) => setReveal(key, !revealed.has(key))}
                      rotating={rotatingId === lock.id}
                      onRotate={onRotate}
                      onManualRotate={(l) => setDrawer({ lockIds: [l.id], single: true })}
                      busy={busy}
                      editing={!lock.room || editRows.has(lock.id)}
                      draft={draftOf(lock)}
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
                  ))}
                </div>
              )}

              {locks.length > 0 && visible.length === 0 && (
                <div className="lk-empty">לא נמצאו מנעולים התואמים לסינון.</div>
              )}
            </div>
          </div>

          <div className="lk-ft">
            <div className="lk-ft-c">
              מציג <b><bdi className="ltr-num">{visible.length}</bdi></b> מתוך{" "}
              <b><bdi className="ltr-num">{locks.length}</bdi></b> מנעולים · סוללה חלשה:{" "}
              <b><bdi className="ltr-num">{counts.lowbatt}</bdi></b>
            </div>
            {uncoveredRooms.length > 0 && (
              <>
                <span className="lk-vsep" />
                <div className="lk-ft-nolock">
                  חדרים ללא מנעול:
                  {uncoveredRooms.map((r) => (
                    <span key={r.roomId} className="rm">
                      {roomLabel(r)}
                    </span>
                  ))}
                  {/* Opens the mapping editor on the first unmapped LOCK rather
                      than scrolling to the room chips: a room cannot be given a
                      lock from the room's side — the binding is made on a lock
                      row, so sending the operator there is the shorter path. */}
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    disabled={counts.noroom === 0}
                    onClick={() => {
                      const target = locks.find((l) => !l.room);
                      if (!target) return;
                      setFilter("noroom");
                      setEditRows((p) => new Set(p).add(target.id));
                    }}
                  >
                    <Icon name="add-link" size={17} />
                    שיוך מנעול
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {drawer && (
        <RotateDrawer
          locks={drawerLocks}
          single={drawer.single}
          onClose={() => setDrawer(null)}
          onApply={onBulkApply}
        />
      )}
    </div>
  );
}

function SortTh({
  label, k, sortKey, sortDir, onSort,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <button type="button" className={`lk-th sortable${active ? " active" : ""}`} onClick={() => onSort(k)}>
      {label}
      <span className="sort-ar">
        <Icon name={sortDir === "asc" ? "arrow-up" : "arrow-down"} size={17} />
      </span>
    </button>
  );
}

function BatteryCell({ battery }: { battery: number | null }) {
  // Unknown is "—", never 0: an unreported charge and a flat one are different
  // facts, and showing 0 would send someone to a working door.
  if (battery === null) return <span className="lk-dash">—</span>;
  return (
    <span className={`lk-batt ${battClass(battery)}`}>
      <span className="bwrap">
        <span className="bfill" style={{ width: `${Math.max(0, Math.min(100, battery))}%` }} />
      </span>
      <span className="bp">
        <bdi className="ltr-num">{battery}%</bdi>
      </span>
    </span>
  );
}

/**
 * The code cell. Four buttons, right-to-left: rotate · manual rotate · reveal ·
 * copy. The manual (bolt) button is an approved addition to the reference: it
 * opens the same drawer scoped to this one door, for when the operator needs a
 * SPECIFIC code rather than a draw.
 */
function CodeCell({
  lock, revealed, revealAll, onToggleReveal, rotating, onRotate, onManualRotate, busy,
}: {
  lock: LockView;
  revealed: Set<string>;
  revealAll: boolean;
  onToggleReveal: (key: string) => void;
  rotating: boolean;
  onRotate: (l: LockView) => void;
  onManualRotate: (l: LockView) => void;
  busy: boolean;
}) {
  const key = `${lock.id}:apartment`;
  const shown = revealAll || revealed.has(key);
  const code = lock.apartmentCode;
  const stale = lock.supersededCodes;

  if (!lock.room) return <span className="lk-dash">—</span>;

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(forDisplay(code.code));
      toast.success(`קוד הדירה הועתק · ${forDisplay(code.code)}`);
    } catch {
      toast.error("ההעתקה נכשלה — ניתן להקליד את הקוד ידנית");
    }
  }

  return (
    <>
      <div className="lk-codebox">
        {code ? (
          <span className={`lk-code${shown ? "" : " hid"}`}>
            <bdi className="ltr-num">{shown ? forDisplay(code.code) : "•••••#"}</bdi>
          </span>
        ) : (
          <span className="lk-nocode">אין קוד</span>
        )}

        {lock.canRotate && (
          <>
            <button
              type="button"
              className="lk-eye"
              onClick={() => onRotate(lock)}
              disabled={busy}
              title="החלפת קוד"
              aria-label={`החלפת קוד ל${lock.alias}`}
            >
              <Icon name={rotating ? "spinner" : "autorenew"} size={17} className={rotating ? "lk-spin" : undefined} />
            </button>
            <button
              type="button"
              className="lk-eye"
              onClick={() => onManualRotate(lock)}
              disabled={busy}
              title="החלפה עם קוד ידני"
              aria-label={`החלפה עם קוד ידני ל${lock.alias}`}
            >
              <Icon name="automations" size={17} />
            </button>
          </>
        )}

        {code && (
          <button
            type="button"
            className="lk-eye"
            onClick={() => onToggleReveal(key)}
            aria-label={shown ? "הסתרת קוד הדירה" : "הצגת קוד הדירה"}
          >
            <Icon name={shown ? "eye-off" : "eye"} size={17} />
          </button>
        )}
        {code && lock.canRotate && (
          <button type="button" className="lk-eye" onClick={copy} title="העתקת קוד" aria-label="העתקת קוד הדירה">
            <Icon name="copy" size={17} />
          </button>
        )}
      </div>

      {!lock.canRotate && (
        <span className="lk-warnnote">
          <Icon name="warning" size={13.5} />
          אין שער — אין החלפה מרחוק
        </span>
      )}
      {code?.state === "missing" && (
        <span className="lk-warnnote">
          <Icon name="warning" size={13.5} />
          הקוד נמחק מחוץ למערכת
        </span>
      )}
      {stale.map((last2) => (
        <span key={last2} className="lk-warnnote">
          <Icon name="warning" size={13.5} />
          הקוד הישן <bdi className="ltr-num">••{last2}#</bdi> עדיין פעיל על הדלת — המערכת תנסה שוב
        </span>
      ))}
    </>
  );
}

function ManagerCell({
  lock, revealed, onToggleReveal,
}: {
  lock: LockView;
  revealed: Set<string>;
  onToggleReveal: (key: string) => void;
}) {
  const key = `${lock.id}:manager`;
  const shown = revealed.has(key);
  const mgr: PasscodeView | null = lock.managerCode;
  // No rotate, no copy — and not a disabled one, none. This is the code that
  // gets a person in when everything else has failed. `revealAll` deliberately
  // does not reach it: showing every manager code at once is a different act.
  if (!mgr) return <span className="lk-dash">—</span>;
  return (
    <div className="lk-codebox">
      <span className={`lk-code${shown ? "" : " hid"}`}>
        <bdi className="ltr-num">{shown ? forDisplay(mgr.code) : "•••••#"}</bdi>
      </span>
      <button
        type="button"
        className="lk-eye"
        onClick={() => onToggleReveal(key)}
        aria-label={shown ? "הסתרת קוד המנהל" : "הצגת קוד המנהל"}
      >
        <Icon name={shown ? "eye-off" : "eye"} size={17} />
      </button>
    </div>
  );
}

function LockRow({
  lock, rooms, takenRoomIds, selected, onToggleRow,
  revealed, revealAll, onToggleReveal, rotating, onRotate, onManualRotate, busy,
  editing, draft, onDraft, onEdit, onCancelEdit, onMap, onUnmap,
}: {
  lock: LockView;
  rooms: LockRoomView[];
  takenRoomIds: Set<string>;
  selected: boolean;
  onToggleRow: (id: string) => void;
  revealed: Set<string>;
  revealAll: boolean;
  onToggleReveal: (key: string) => void;
  rotating: boolean;
  onRotate: (l: LockView) => void;
  onManualRotate: (l: LockView) => void;
  busy: boolean;
  editing: boolean;
  draft: string;
  onDraft: (id: string, v: string) => void;
  onEdit: (id: string) => void;
  onCancelEdit: (id: string) => void;
  onMap: (l: LockView) => void;
  onUnmap: (l: LockView) => void;
}) {
  const status = statusOf(lock);
  const unchanged = (lock.room?.roomId ?? "") === draft;

  return (
    <div className={`lk-row${selected ? " sel" : ""}`}>
      <div className="lk-td c">
        <button
          type="button"
          className={`lk-cb${selected ? " on" : ""}`}
          onClick={() => onToggleRow(lock.id)}
          aria-label={`בחירת ${lock.alias}`}
          aria-pressed={selected}
        >
          <Icon name="check" size={13.5} />
        </button>
      </div>

      <div className="lk-td col">
        <span className="lk-lockid">{lock.alias}</span>
        <span className="lk-tt">
          <bdi className="ltr-num">{lock.ttlockLockId}</bdi>
        </span>
        {lock.missingSince && (
          <span className="lk-warnnote">
            <Icon name="warning" size={13.5} />
            לא הופיע בסנכרון מאז <bdi className="ltr-num">{fmt(lock.missingSince)}</bdi>
          </span>
        )}
      </div>

      <div className="lk-td">
        <BatteryCell battery={lock.battery} />
      </div>

      <div className="lk-td">
        {editing ? (
          <div style={{ display: "flex", gap: "8px", alignItems: "center", minWidth: 0, flexWrap: "wrap" }}>
            <select
              className="field-input"
              value={draft}
              onChange={(e) => onDraft(lock.id, e.target.value)}
              disabled={busy}
              aria-label={`חדר עבור המנעול ${lock.alias}`}
            >
              <option value="">בחר חדר…</option>
              {rooms.map((r) => {
                const takenByOther = takenRoomIds.has(r.roomId) && r.roomId !== lock.room?.roomId;
                return (
                  <option key={r.roomId} value={r.roomId} disabled={takenByOther}>
                    {r.roomNumber}
                    {r.name ? ` · ${r.name}` : ""}
                    {takenByOther ? " — משויך למנעול אחר" : ""}
                  </option>
                );
              })}
            </select>
            <button
              type="button"
              onClick={() => onMap(lock)}
              disabled={busy || !draft || unchanged}
              className="btn btn-sm btn-primary"
            >
              שמירה
            </button>
            {lock.room && (
              <button
                type="button"
                onClick={() => onCancelEdit(lock.id)}
                disabled={busy}
                className="btn btn-sm btn-secondary"
              >
                ביטול
              </button>
            )}
          </div>
        ) : lock.room ? (
          <div style={{ minWidth: 0 }}>
            <div className="lk-room">{roomLabel(lock.room)}</div>
            <div className="lk-room-sub">
              חדר <bdi className="ltr-num">{lock.room.roomNumber}</bdi>
            </div>
          </div>
        ) : (
          <span className="lk-unassigned">לא משויך לחדר</span>
        )}
      </div>

      <div className="lk-td col">
        <CodeCell
          lock={lock}
          revealed={revealed}
          revealAll={revealAll}
          onToggleReveal={onToggleReveal}
          rotating={rotating}
          onRotate={onRotate}
          onManualRotate={onManualRotate}
          busy={busy}
        />
      </div>

      <div className="lk-td col">
        <ManagerCell lock={lock} revealed={revealed} onToggleReveal={onToggleReveal} />
      </div>

      <div className="lk-td col" style={{ gap: "2px" }}>
        <span className={`lk-badge ${STATUS_CLASS[status]}`}>
          <span className="d" />
          {STATUS_LABEL[status]}
        </span>
        {lock.syncedAt && (
          <span className="lk-date">
            <bdi className="ltr-num">{fmt(lock.syncedAt)}</bdi>
          </span>
        )}
      </div>

      <div className="lk-td c">
        <div className="lk-acts">
          {lock.room && !editing && (
            <button
              type="button"
              className="btn btn-sm btn-secondary lk-ico"
              onClick={() => onEdit(lock.id)}
              disabled={busy}
              title="שינוי שיוך"
              aria-label={`שינוי שיוך ל${lock.alias}`}
            >
              <Icon name="filter" size={17} />
            </button>
          )}
          {lock.room && (
            <button
              type="button"
              className="btn btn-sm btn-secondary lk-ico"
              onClick={() => onUnmap(lock)}
              disabled={busy}
              title="ביטול שיוך"
              aria-label={`ביטול שיוך ל${lock.alias}`}
            >
              <Icon name="link-off" size={17} />
            </button>
          )}
        </div>
      </div>
      <div className="lk-td" />
    </div>
  );
}

/**
 * The rotate drawer. Two shapes, one component:
 *  · SELECTION (N locks) — mode segment, uniform or per-door codes;
 *  · SINGLE (the bolt button) — one input, no mode segment, because "uniform
 *    vs per" is meaningless for one door.
 *
 * IT IS THE APP'S SidePanel, not a second drawer shell. The design reference
 * ships its own overlay/panel/blue-header CSS, and porting that verbatim gave
 * this screen a drawer that opened from the opposite side to every other one in
 * the product — and that lacked Esc-to-close, the focus trap, the portal and
 * the body scroll lock that §7 has had all along. A screen-specific drawer is
 * not a visual choice, it is a second implementation of a solved problem.
 * Everything below is BODY CONTENT; the shell is canonical.
 */
function RotateDrawer({
  locks, single, onClose, onApply,
}: {
  locks: LockView[];
  single: boolean;
  onClose: () => void;
  onApply: (items: { lockId: string; code: string }[]) => Promise<void>;
}) {
  const [mode, setMode] = useState<"uniform" | "per">("per");
  const [uniCode, setUniCode] = useState(draw);
  const [perCodes, setPerCodes] = useState<Record<string, string>>(() =>
    Object.fromEntries(locks.map((l) => [l.id, draw()])),
  );
  const [applying, setApplying] = useState(false);

  // Locks with no gateway cannot receive a code we chose. They are EXCLUDED
  // from the apply rather than queued into a fiction that fails upstream.
  const eligible = locks.filter((l) => l.canRotate);
  const skipped = locks.length - eligible.length;

  const items = useMemo(
    () =>
      eligible.map((l) => ({
        lockId: l.id,
        code: single || mode === "uniform" ? uniCode : (perCodes[l.id] ?? ""),
        lock: l,
      })),
    [eligible, single, mode, uniCode, perCodes],
  );

  const errors = items.map((i) => clientCodeError(i.code));
  const canApply = eligible.length > 0 && errors.every((e) => e === null) && !applying;

  const subtitle = single || locks.length === 1
    ? (locks[0]?.room ? roomLabel(locks[0].room) : (locks[0]?.alias ?? ""))
    : `${locks.length} דירות נבחרו`;

  const applyLabel = single || eligible.length === 1
    ? "החלף קוד לדירה"
    : `החלף קוד ל-${eligible.length} דירות`;

  async function submit() {
    if (!canApply) return;
    setApplying(true);
    await onApply(items.map(({ lockId, code }) => ({ lockId, code })));
    setApplying(false);
  }

  return (
    <SidePanel
      open
      onClose={onClose}
      title="החלפת קוד דירה"
      subtitle={subtitle}
      icon="password"
      footer={
        <>
          {/* PRIMARY FIRST in the DOM — .dw-ft is row-reverse, so this hugs the
              left edge and ביטול sits to its right (§7). */}
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!canApply}>
            <Icon name="check" size={20} />
            {applying ? "מחליף…" : applyLabel}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            ביטול
          </button>
        </>
      }
    >
      <div className="lk-dw-stack">
        {/* One door: "uniform vs per" has nothing to choose between. */}
        {!single && (
          <div className="card">
            <div className="card-bd">
              <div className="lk-sec-t" style={{ marginBottom: "8px" }}>
                אופן ההחלפה
              </div>
              <div className="lk-seg">
                <button
                  type="button"
                  className={mode === "uniform" ? "on" : ""}
                  onClick={() => setMode("uniform")}
                >
                  <Icon name="copy" size={20} />
                  קוד אחיד לכל הדירות
                </button>
                <button type="button" className={mode === "per" ? "on" : ""} onClick={() => setMode("per")}>
                  <Icon name="list" size={20} />
                  קוד נפרד לכל דירה
                </button>
              </div>
            </div>
          </div>
        )}

        {(single || mode === "uniform") && (
          <div className="card">
            <div className="card-bd">
              <div className="lk-sec-t">הקוד החדש</div>
              <div className="lk-sec-s">
                {single
                  ? "4–6 ספרות. הקוד הישן יפסיק לפעול ברגע שהחדש יגיע לדלת."
                  : `4–6 ספרות. הקוד יוחל על כל ${eligible.length} הדירות שנבחרו.`}
              </div>
              <div className="lk-row2">
                <div style={{ flex: 1 }}>
                  <input
                    className={`lk-inp big${clientCodeError(uniCode) ? " err" : ""}`}
                    maxLength={6}
                    inputMode="numeric"
                    value={uniCode}
                    onChange={(e) => setUniCode(e.target.value.replace(/\D/g, ""))}
                    aria-label="הקוד החדש"
                  />
                  {clientCodeError(uniCode) && <div className="lk-fielderr">{clientCodeError(uniCode)}</div>}
                </div>
                <button type="button" className="btn btn-secondary" onClick={() => setUniCode(draw())}>
                  <Icon name="dice" size={20} />
                  הגרלת קוד
                </button>
              </div>
            </div>
          </div>
        )}

        {!single && mode === "per" && (
          <div className="card">
            <div className="card-bd">
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                <div className="lk-sec-t">קוד לכל דירה</div>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => setPerCodes(Object.fromEntries(locks.map((l) => [l.id, draw()])))}
                >
                  <Icon name="dice" size={17} />
                  הגרלה לכולם
                </button>
              </div>
              <div className="lk-aplist">
                {eligible.map((l) => {
                  const v = perCodes[l.id] ?? "";
                  const err = clientCodeError(v);
                  return (
                    <div key={l.id} className="lk-aprow">
                      <div style={{ minWidth: 0 }}>
                        <div className="nm">{l.room ? roomLabel(l.room) : l.alias}</div>
                        <div className="no">
                          מנעול {l.alias} · <bdi className="ltr-num">{l.ttlockLockId}</bdi>
                        </div>
                      </div>
                      <div>
                        <input
                          className={`lk-inp${err ? " err" : ""}`}
                          maxLength={6}
                          inputMode="numeric"
                          value={v}
                          onChange={(e) =>
                            setPerCodes((p) => ({ ...p, [l.id]: e.target.value.replace(/\D/g, "") }))
                          }
                          aria-label={`קוד עבור ${l.room ? roomLabel(l.room) : l.alias}`}
                        />
                        {err && <div className="lk-fielderr">{err}</div>}
                      </div>
                      <button
                        type="button"
                        className="lk-icobtn"
                        onClick={() => setPerCodes((p) => ({ ...p, [l.id]: draw() }))}
                        aria-label="הגרלת קוד"
                      >
                        <Icon name="dice" size={20} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {skipped > 0 && (
          <div className="lk-note">
            <Icon name="warning" size={20} />
            <bdi className="ltr-num">{skipped}</bdi> מהדירות שנבחרו ללא שער (Gateway) — לא ניתן להחליף
            להן קוד מרחוק והן ידולגו.
          </div>
        )}
      </div>
    </SidePanel>
  );
}

function NoConnection() {
  return (
    <div className="lk-card" style={{ flex: "none" }}>
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
  );
}
