"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { GuestRow } from "@/components/shared/GuestRow";
import { StatusButton } from "@/components/shared/StatusButton";
import { setReservationStatusAction } from "@/app/(dashboard)/reservations/actions";
import type { StayRow } from "../data";
import { initialsOf, staySubline } from "./row-text";

// ============================================================
// arr — הגעות ועזיבות היום (DeshbordMain.md §4.1).
//
// ONE ROW PER ROOM, not per reservation. A three-room booking is three rooms to
// walk to, and the design's row anatomy ("חדר · סוג · N לילות") has no shape for
// a "101, 102, 103" aggregate — which is what every existing reservations query
// returns (audit contradiction 3).
//
// ONE StatusButton per row, three states — not two buttons (§4.1):
//   not arrived  → נכנס   (primary, login)
//   checked in   → יצא    (warn, logout)
//   checked out  → a chip, not a dead control
//
// No date guard on the check-out: a guest may leave before the stay ends
// (§4.1, and the panel has never had one either — audit §3.4).
// ============================================================

type Column = "arrivals" | "departures";

export function ArrivalsWindow({
  arrivals,
  departures,
}: {
  arrivals: StayRow[];
  departures: StayRow[];
}) {
  return (
    <div className="arr-cols">
      <ArrColumn title="הגעות" rows={arrivals} column="arrivals" />
      <ArrColumn title="עזיבות" rows={departures} column="departures" />
    </div>
  );
}

function ArrColumn({ title, rows, column }: { title: string; rows: StayRow[]; column: Column }) {
  return (
    <section className="arr-col" aria-label={title}>
      <header className="arr-col-hd">
        <span className="arr-col-t">{title}</span>
        <span className="arr-col-n ltr-num">{rows.length}</span>
      </header>
      {rows.length === 0 ? (
        <div className="empty-state empty-sm">
          <span className="empty-t">{column === "arrivals" ? "אין הגעות היום" : "אין עזיבות היום"}</span>
        </div>
      ) : (
        rows.map((r) => <ArrRow key={r.rrId} row={r} column={column} />)
      )}
    </section>
  );
}

function ArrRow({ row, column }: { row: StayRow; column: Column }) {
  // optimistic: the button answers the press, the server confirms on refresh
  const [status, setStatus] = useState(row.status);
  const [pending, start] = useTransition();

  const move = (next: "checked_in" | "checked_out", done: string) => {
    const previous = status;
    setStatus(next);
    start(async () => {
      const res = await setReservationStatusAction(row.reservationId, next);
      if (res.success) toast.success(done);
      else {
        setStatus(previous);
        toast.error(res.error);
      }
    });
  };

  return (
    <GuestRow
      initials={initialsOf(row.guestName)}
      name={row.guestName}
      vip={row.isVip}
      tone={column === "departures" ? "warn" : "brand"}
      subline={staySubline(row)}
      trailing={
        status === "checked_out" ? (
          <StatusButton
            state="done"
            icon="check-circle"
            label={column === "departures" ? "צ׳ק-אאוט בוצע" : "יצא"}
          />
        ) : status === "checked_in" || column === "departures" ? (
          <StatusButton
            state="warn"
            icon="logout"
            label="יצא"
            disabled={pending}
            onClick={() => move("checked_out", `${row.guestName} — צ׳ק-אאוט בוצע`)}
          />
        ) : (
          <StatusButton
            state="primary"
            icon="login"
            label="נכנס"
            disabled={pending}
            onClick={() => move("checked_in", `${row.guestName} — צ׳ק-אין בוצע`)}
          />
        )
      }
    />
  );
}
