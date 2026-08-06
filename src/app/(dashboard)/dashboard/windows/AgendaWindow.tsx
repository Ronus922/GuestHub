import Link from "next/link";
import type { AgendaItem } from "../data";

// ============================================================
// agd — יומן היום (DeshbordMain.md §4.4). READ-ONLY: a timeline has no
// buttons; the row navigates to its reservation and the acting happens there.
//
// The set is assembled in data.ts from rows the screen already fetched:
// departures at the booking's check_out_time, arrivals at
// expected_arrival_time (falling back to check_in_time). The design also
// lists "חיוב" and "משימה" rows — the charge-stage engine was dropped with
// migration 078 and tasks carry no target hour, so both sets are empty by
// construction and honesty renders nothing rather than a fabricated row.
//
// PAST EVENTS DIM. `now` is computed by the SERVER in the property's
// timezone and re-derives on every SSE refresh — a client clock would SSR in
// UTC, hydrate in browser time, and the two renders would disagree.
// ============================================================

const KIND_LABEL: Record<AgendaItem["kind"], string> = {
  departure: "עזיבה",
  arrival: "הגעה",
};

export function AgendaWindow({ items, now }: { items: AgendaItem[]; now: string }) {
  if (items.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין אירועים ביומן היום</span>
      </div>
    );
  }
  return (
    <>
      {items.map((it) => {
        const past = it.time < now;
        return (
          <Link
            key={it.key}
            href={`/reservations?open=${it.reservationId}`}
            className={`agd-row${past ? " agd-past" : ""}`}
          >
            <span className="agd-time ltr-num">{it.time}</span>
            <span className={`agd-dot agd-dot-${it.kind}`} aria-hidden />
            <span className="agd-body">
              <span className="agd-title">{it.title}</span>
              {it.sub && <span className="agd-sub">{it.sub}</span>}
            </span>
            <span className={`chip agd-tag-${it.kind}`}>{KIND_LABEL[it.kind]}</span>
          </Link>
        );
      })}
    </>
  );
}
