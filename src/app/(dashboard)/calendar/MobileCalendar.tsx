"use client";

import { useMemo } from "react";
import { Icon } from "@/components/shared/Icon";
import { addDays, dayOfWeek, HEBREW_DAY_LETTERS, type DateOnly } from "@/lib/dates";
import { barGeometry } from "@/lib/calendar-interactions";
import { resolveChannelBadge } from "@/lib/colors";
import { NEUTRAL_STATUS } from "@/lib/status-colors";
import { ChannelBadge } from "@/components/shared/ChannelBadge";
import type { CalendarData, CalendarRoom, CalendarStay, CalendarClosure } from "./types";
import { stayPalette } from "./CalendarGrid";

// Mobile "ציר זמן" board (reference GuesthubCalandrMobile). Rooms are grouped
// under "קומה N" headers; each row shows a fixed 56px label column + a `days`-day
// timeline. Bars reuse barGeometry (mid-cell fractions) so they line up exactly
// with the desktop math. No prices, no drag — tap a bar to open its card, tap an
// empty cell to start a booking.
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

  const staysByRoom = useMemo(() => groupBy(data.stays, (s) => s.room_id), [data.stays]);
  const closuresByRoom = useMemo(
    () => groupBy(data.closures, (c) => c.room_id),
    [data.closures],
  );

  return (
    <div className="thin-scroll min-h-0 flex-1 overflow-auto">
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
            {floor.rooms.map((room) => (
              <div key={room.id} className="cb-m-row">
                <div className="cb-m-rlabel">
                  <span className="cb-m-rnum ltr-num">{room.room_number}</span>
                  <span className="cb-m-rtype">{room.room_type_name ?? room.name ?? "—"}</span>
                </div>
                <div className="cb-m-strip">
                  {/* empty cells — tap target for a new booking */}
                  {dates.map((d) => {
                    const dow = dayOfWeek(d);
                    const cls = d === data.today ? "td" : dow === 5 || dow === 6 ? "we" : "";
                    return (
                      <div
                        key={d}
                        className={`cb-m-cell ${cls}`}
                        onClick={canCreate ? () => onEmptyTap(room.id, d) : undefined}
                      />
                    );
                  })}
                  {/* closures — dashed neutral block (non-interactive) */}
                  {(closuresByRoom.get(room.id) ?? []).map((c) => (
                    <ClosureBlock key={c.id} closure={c} from={data.from} days={days} />
                  ))}
                  {/* reservation bars */}
                  {(staysByRoom.get(room.id) ?? []).map((stay) => (
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
            ))}
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
