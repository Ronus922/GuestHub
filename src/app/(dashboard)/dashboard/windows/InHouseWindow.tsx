import { GuestRow } from "@/components/shared/GuestRow";
import type { StayRow } from "../data";
import { initialsOf, leavesOn, staySubline } from "./row-text";

// ============================================================
// inh — בבית הלילה (DeshbordMain.md §5.7).
//
// The set is `check_in <= today < check_out` — a DATE predicate. NOT
// `status = 'checked_in'`, which is what the reservations screen's in-house tab
// uses: that answers "who did reception process", and zero rows carried that
// status when this was built, so the window would have rendered permanently
// empty (audit contradiction 1). Who is sleeping here tonight is a question the
// dates answer.
//
// Read-only by design — the check-in/out controls belong to arr, where the
// operator is already working the day's list.
// ============================================================
export function InHouseWindow({ rows }: { rows: StayRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין אורחים בבית הלילה</span>
      </div>
    );
  }
  return (
    <>
      {rows.map((r) => (
        <GuestRow
          key={r.rrId}
          initials={initialsOf(r.guestName)}
          name={r.guestName}
          vip={r.isVip}
          subline={staySubline(r)}
          // the approved NEUTRAL §3.1 family — a departure date is information,
          // not a state to be alarmed by, and the system has no other grey chip
          trailing={<span className="chip chip-cancelled">{leavesOn(r)}</span>}
        />
      ))}
    </>
  );
}
