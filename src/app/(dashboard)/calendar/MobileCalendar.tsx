"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { addDays, dayOfWeek, HEBREW_DAY_LETTERS, type DateOnly } from "@/lib/dates";
import { barGeometry } from "@/lib/calendar-interactions";
import { resolveChannelBadge } from "@/lib/colors";
import { stayViolationMessage } from "@/lib/rates/rules";
import { closureBlockMessage } from "@/lib/closures/categories";
import { NEUTRAL_STATUS } from "@/lib/status-colors";
import { ChannelBadge } from "@/components/shared/ChannelBadge";
import type { RateRow } from "@/lib/inventory-rules";
import type { CalendarData, CalendarRoom, CalendarStay, CalendarClosure } from "./types";
import { cellMark, roomLabel, sellable } from "./cell-state";
import { stayPalette } from "./CalendarGrid";

// Mobile "ציר זמן" board (reference GuesthubCalandrMobile). Rooms are grouped
// under "קומה N" headers; each row shows a fixed 56px label column + a `days`-day
// timeline. Bars reuse barGeometry (mid-cell fractions) so they line up exactly
// with the desktop math. No prices, no drag — tap a bar to open its card, tap an
// empty cell to start a booking (unless that night is closed for sale — see the
// two axes at the cell below).
export function MobileCalendar({
  data,
  days,
  canCreate,
  flashId,
  onBarTap,
  onEmptyTap,
}: {
  data: CalendarData;
  days: number;
  canCreate: boolean;
  /** reservation_id of a just-created booking — its bar(s) pulse ~3s */
  flashId?: string | null;
  onBarTap: (rrId: string) => void;
  onEmptyTap: (roomId: string, checkIn: DateOnly) => void;
}) {
  const dates = useMemo(
    () => Array.from({ length: days }, (_, i) => addDays(data.from, i)),
    [data.from, days],
  );

  // …and the WHOLE window the loader fetched (data.days, 21 — see CALENDAR_DAYS),
  // of which `dates` above is only the 3/5/7-day slice this board draws. The row
  // LABEL judges this one, never the slice: it describes a ROOM, and a room does
  // not become unsellable because the user tapped "3 ימים". Judging the slice let
  // the two boards disagree about the same room at the same moment — desktop
  // "פנוי", mobile "סגור למכירה" — which is the same self-contradiction the label
  // was fixed to stop, moved one screen over. Rendering is untouched: every cell,
  // bar and closure below still comes from `dates`.
  const windowDates = useMemo(
    () => Array.from({ length: data.days }, (_, i) => addDays(data.from, i)),
    [data.from, data.days],
  );

  // The loader fetches a whole window (3 weeks / a month); the mobile timeline
  // only SLICES 3/5/7 days out of it (§4). Bars were rendered for the entire
  // fetched set regardless, and barGeometry happily returned a start of 370% for
  // a stay three weeks out — so those buttons were laid out several hundred px
  // outside the card and were invisible only because .cb-m-card clips. They were
  // still real, focusable controls: Tab walked onto reservations nobody could
  // see, and they inflated the card's scroll width by ~660px at 390px wide.
  // Rendering only what the slice actually shows fixes both.
  const lastVisible = dates[dates.length - 1] ?? data.from;
  const inWindow = (start: DateOnly, end: DateOnly) => start <= lastVisible && end >= data.from;

  // group rooms by floor, preserving the number-sorted order within each floor
  const floors = useMemo(() => {
    const groups: { key: string; label: string; rooms: CalendarRoom[] }[] = [];
    const index = new Map<string, number>();
    for (const room of data.rooms) {
      const key = room.floor ?? "—";
      let gi = index.get(key);
      if (gi === undefined) {
        gi = groups.length;
        index.set(key, gi);
        groups.push({ key, label: room.floor ? `קומה ${room.floor}` : "ללא קומה", rooms: [] });
      }
      groups[gi].rooms.push(room);
    }
    return groups;
  }, [data.rooms]);

  // O(1) rate lookup per cell, with the SAME priority the desktop board uses
  // (a room's own row wins over its type's row — see rateIdx/cellRate in
  // CalendarGrid.tsx). The mobile board needs it for AXIS B only.
  const rateIdx = useMemo(() => {
    const room = new Map<string, RateRow>();
    const type = new Map<string, RateRow>();
    for (const r of data.rates) {
      if (r.room_id) room.set(`${r.room_id}|${r.date}`, r);
      else if (r.room_type_id) type.set(`${r.room_type_id}|${r.date}`, r);
    }
    return { room, type };
  }, [data.rates]);

  const cellRate = useCallback(
    (roomItem: CalendarRoom, date: DateOnly): RateRow | undefined =>
      rateIdx.room.get(`${roomItem.id}|${date}`) ??
      (roomItem.room_type_id ? rateIdx.type.get(`${roomItem.room_type_id}|${date}`) : undefined),
    [rateIdx],
  );

  const staysByRoom = useMemo(() => groupBy(data.stays, (s) => s.room_id), [data.stays]);
  const closuresByRoom = useMemo(
    () => groupBy(data.closures, (c) => c.room_id),
    [data.closures],
  );

  // THE dated-closure question, asked once and answered the same way for the row
  // label and for the cell beneath it. Half-open [start, end) — the same reading
  // the desktop board, rangeInvalid() and the closed_today KPI use.
  const coverOn = useCallback(
    (roomId: string, date: DateOnly): CalendarClosure | undefined =>
      (closuresByRoom.get(roomId) ?? []).find((c) => c.start_date <= date && c.end_date > date),
    [closuresByRoom],
  );

  return (
    // dir pinned like the desktop board (.cb-calwrap): the bars' insetInlineStart
    // and the header/cell flex order are GEOMETRY — they must never depend on the
    // ambient direction of whatever mounts this tree.
    <div className="thin-scroll min-h-0 flex-1 overflow-auto" dir="rtl">
      <div className="cb-m-card">
        {/* day header */}
        <div className="cb-m-hdr">
          <div className="cb-m-hdr-room">חדר</div>
          {dates.map((d) => {
            const dow = dayOfWeek(d);
            const cls = d === data.today ? "td" : dow === 5 || dow === 6 ? "we" : "";
            return (
              <div key={d} className={`cb-m-hdr-day ${cls}`}>
                <span className="cb-m-dw">{HEBREW_DAY_LETTERS[dow]}</span>
                <span className="cb-m-dn ltr-num">{Number(d.slice(8, 10))}</span>
              </div>
            );
          })}
        </div>

        {floors.map((floor) => (
          <div key={floor.key}>
            <div className="cb-m-floor">{floor.label}</div>
            {floor.rooms.map((room) => {
              // AXIS A — PHYSICAL, row-level and rate-independent: an inactive or
              // out-of-order room cannot be sold on ANY date, so the whole row is
              // hatched, dead to the tap, and shows no commercial sign at all.
              // The label only DIMS: .cb-m-rlabel is a 50px two-line box with no
              // vertical room for a third line, so the word lives on the desktop
              // board (.cb-rst) and mobile carries the state as tone.
              const roomSellable = sellable(room);
              // …and AXIS B at ROW level: a room whose every night in the FETCHED
              // WINDOW is stop-sold is not on the market either, and the label may
              // not keep saying it is. The decision is roomLabel()'s, the same
              // function the desktop row calls, fed the same window — so the two
              // boards give one room one answer. Mobile takes only the TONE from
              // it, because the 50px box still has no room for a word.
              const { tone } = roomLabel(
                room,
                windowDates.map((d) => {
                  const cover = coverOn(room.id, d);
                  return { rate: cellRate(room, d), closure: cover !== undefined, closureCategory: cover?.category ?? null };
                }),
              );
              return (
                <div key={room.id} className="cb-m-row">
                  <div className={`cb-m-rlabel ${tone === "free" ? "" : tone}`}>
                    <span className="cb-m-rnum ltr-num">{room.room_number}</span>
                    <span className="cb-m-rtype">{room.room_type_name ?? room.name ?? "—"}</span>
                  </div>
                  <div className="cb-m-strip">
                    {/* empty cells — tap target for a new booking */}
                    {dates.map((d) => {
                      const dow = dayOfWeek(d);
                      const cls = d === data.today ? "td" : dow === 5 || dow === 6 ? "we" : "";
                      // AXIS B — COMMERCIAL, per-cell: this room-night is closed for
                      // sale. It is asked ONLY where AXIS A already allows selling —
                      // a room that cannot be sold at all is not "closed for sale
                      // today", and drawing both signs would restate the exact
                      // conflation this split removes. Physical wins outright.
                      const closed =
                        roomSellable && cellMark(cellRate(room, d))?.mark === "stop_sell";
                      // AXIS A, DATED: a room_closures row covering this night.
                      // It is the physical axis with a date on it, so it wears
                      // the physical hatch — the same .blocked the row-level
                      // reading uses — and it SUPPRESSES the commercial tag
                      // beside it. A flat somebody lives in is not "closed for
                      // sale today"; drawing both signs is the exact conflation
                      // the two axes exist to prevent, and after the year-lets
                      // move off stop_sell (scripts/migrate-longterm-closures)
                      // the second sign is not even true any more.
                      const cover = roomSellable ? coverOn(room.id, d) : undefined;
                      return (
                        <div
                          key={d}
                          className={`cb-m-cell ${cls} ${roomSellable && !cover ? "" : "blocked"} ${closed && !cover ? "cx" : ""}`}
                          // The two axes ANSWER A TAP DIFFERENTLY, on purpose:
                          //
                          //   PHYSICAL, ROW-LEVEL (not sellable) — no handler at all.
                          //     There is nothing to say: the whole row is hatched, the
                          //     label is dimmed, and the state is a fact about the room,
                          //     not about this date. Silence.
                          //   PHYSICAL, DATED (a room closure) — a toast naming WHAT
                          //     closed it and until when ("שכירות ארוכה עד 31.12"), and
                          //     nothing else. Unlike the row-level case this one IS
                          //     about this date, and unlike the commercial case below
                          //     there is no override anywhere: no dialog, no button, no
                          //     "המשך בכל זאת" for anybody, manager included. Nobody
                          //     sells a bed somebody else sleeps in.
                          //   COMMERCIAL (closed) — a short toast and nothing else.
                          //     The cell LOOKS tappable (it is a plain open cell wearing
                          //     a "סגור" tag), so silence would read as a dead board;
                          //     the tap must say why it did not open a booking. The
                          //     owner's ruling for mobile is feedback, not a window:
                          //     no dialog, no "המשך בכל זאת" — the desktop board keeps
                          //     the override path (CalendarGrid §7), a 390px screen
                          //     does not get a modal to dismiss.
                          //   OPEN — opens the booking form, unchanged.
                          //
                          // Neither sentence is typed here: the commercial one comes
                          // from stayViolationMessage (lib/rates/rules.ts) and the
                          // closure one from closureBlockMessage
                          // (lib/closures/categories.ts) — the two places blocked-date
                          // wording lives — so this toast cannot drift from what the
                          // desktop gate and the server say.
                          onClick={
                            !roomSellable || !canCreate
                              ? undefined
                              : cover
                                ? () => toast.error(closureBlockMessage(cover.category, cover.end_date))
                                : closed
                                  ? () => toast.error(stayViolationMessage({ code: "STOP_SELL", date: d }))
                                  : () => onEmptyTap(room.id, d)
                          }
                        >
                          {closed && !cover && <span className="cb-m-cx">סגור</span>}
                        </div>
                      );
                    })}
                    {/* closures — dashed neutral block (non-interactive) */}
                    {(closuresByRoom.get(room.id) ?? [])
                      .filter((c) => inWindow(c.start_date, c.end_date))
                      .map((c) => (
                      <ClosureBlock key={c.id} closure={c} from={data.from} days={days} />
                    ))}
                    {/* reservation bars */}
                    {(staysByRoom.get(room.id) ?? [])
                      .filter((stay) => inWindow(stay.check_in, stay.check_out))
                      .map((stay) => (
                      <StayBarMobile
                        key={stay.rr_id}
                        stay={stay}
                        from={data.from}
                        days={days}
                        flash={flashId != null && stay.reservation_id === flashId}
                        onTap={onBarTap}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function StayBarMobile({
  stay,
  from,
  days,
  flash,
  onTap,
}: {
  stay: CalendarStay;
  from: DateOnly;
  days: number;
  flash: boolean;
  onTap: (rrId: string) => void;
}) {
  const geo = barGeometry(from, days, stay.check_in, stay.check_out);
  const pal = stayPalette(stay);
  const badge = resolveChannelBadge(stay.source_key);
  const firstName = stay.guest_name.replace("משפחת ", "").split(" ")[0];
  return (
    <button
      type="button"
      title={stay.guest_name}
      aria-label={`הזמנה ${stay.reservation_number} · ${stay.guest_name}`}
      className={`cb-m-bar ${geo.clippedStart ? "cutR" : ""} ${geo.clippedEnd ? "cutL" : ""} ${flash ? "flash" : ""}`}
      style={{
        // physical fallback FIRST, logical second: a browser that knows
        // inset-inline-start takes the later declaration (identical value —
        // the tree above is pinned dir="rtl", so inline-start IS right); an
        // old WebView that drops the logical property falls back to `right`
        // instead of collapsing to its static position at the inline end.
        right: `${geo.start * 100}%`,
        insetInlineStart: `${geo.start * 100}%`,
        width: `${geo.width * 100}%`,
        background: pal.bg,
        borderColor: pal.bd,
        color: pal.tx,
      }}
      onClick={() => onTap(stay.rr_id)}
    >
      <ChannelBadge channel={badge} size="sm" />
      <span className="cb-m-bar-nm">{firstName}</span>
    </button>
  );
}

function ClosureBlock({
  closure,
  from,
  days,
}: {
  closure: CalendarClosure;
  from: DateOnly;
  days: number;
}) {
  const geo = barGeometry(from, days, closure.start_date, closure.end_date);
  return (
    <div
      className="cb-m-block"
      title={closure.reason || "סגור"}
      style={{
        // same physical-first fallback as StayBarMobile above
        right: `${geo.start * 100}%`,
        insetInlineStart: `${geo.start * 100}%`,
        width: `${geo.width * 100}%`,
        background: NEUTRAL_STATUS.bg,
        borderColor: NEUTRAL_STATUS.bd,
        color: NEUTRAL_STATUS.tx,
      }}
    >
      <Icon name="circle-slash" size={13.5} />
    </div>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = m.get(k);
    if (bucket) bucket.push(item);
    else m.set(k, [item]);
  }
  return m;
}
