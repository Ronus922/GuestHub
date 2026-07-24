"use client";

import { useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { STATUS_COLORS, type StatusTriplet } from "@/lib/status-colors";
import type {
  AmenityOption,
  BoardRoom,
  BuildingOption,
  OperationalArea,
  RoomDerivedStatus,
  RoomTypeOption,
} from "@/lib/rooms/service";
import type { ExtraGuestDefaults } from "@/lib/commercial/extra-guest";
import { RoomWizard } from "./RoomWizard";
import { AreaPanel } from "./AreaPanel";
import { updateAreaStatusAction, updateRoomBoardStatusAction } from "./actions";

// ============================================================
// Rooms & Areas board — ported 1:1 from ref/html/RoomsAndAreas.html +
// ref/screens/RoomsAndAreas.png (D49): header with count chip, quick filters
// (kind + status dots), floor sections, reference cards (strip / kind chip /
// icon status badge / capacity row / contextual line), and the card-click
// status popover. Editing opens the room/area window from the popover.
// ============================================================

type Property = ExtraGuestDefaults & { adult_min_age: number };
export type Can = { create: boolean; edit: boolean; del: boolean };

export type StatusMeta = { label: string; icon: IconName; triplet: StatusTriplet };

// GUIDELINES §1/§3.1: an operational status wears an APPROVED triplet — never a
// hand-typed hex. Six of the seven map onto the §3.1 families; "תפוס" wears the
// brand family (§1 tokens) through the .chip-brand variant, because §3.1 has no
// blue triplet. The dot of the triplet paints the card's status strip.
const BRAND_TRIPLET: StatusTriplet = {
  bg: "var(--brand-soft)",
  bd: "var(--brand-line)",
  tx: "var(--brand-hover)",
  dot: "var(--brand)",
  chip: "chip-brand",
};

export const STATUS_META: Record<RoomDerivedStatus, StatusMeta> = {
  free: { label: "פנוי", icon: "check-circle", triplet: STATUS_COLORS.paid },
  occupied: { label: "תפוס", icon: "user", triplet: BRAND_TRIPLET },
  dirty: { label: "מלוכלך", icon: "droplets", triplet: STATUS_COLORS.approval },
  cleaning: { label: "בניקיון", icon: "brush", triplet: STATUS_COLORS.transfer },
  blocked: { label: "חסום", icon: "room-blocks", triplet: STATUS_COLORS.unpaid },
  maintenance: { label: "תחזוקה", icon: "maintenance", triplet: STATUS_COLORS.failed },
  // "סגור" = commercially closed to sale for the board's date (stop_sell), not a
  // physical block. It wears the approved neutral §3.1 family STATUS_COLORS.cancelled
  // ("בוטל", .chip-cancelled) — the two reddish families are already spoken for by
  // חסום (unpaid) and תחזוקה (failed), and closed-to-sale is a withdrawn-from-offer
  // state, not a fault. No new token is introduced.
  closed: { label: "סגור", icon: "lock", triplet: STATUS_COLORS.cancelled },
};

export const AREA_STATUS_META: Record<OperationalArea["status"], StatusMeta> = {
  ok: { label: "תקין", icon: "check-circle", triplet: STATUS_COLORS.paid },
  cleaning: { label: "בניקיון", icon: "brush", triplet: STATUS_COLORS.transfer },
  maintenance: { label: "תחזוקה", icon: "maintenance", triplet: STATUS_COLORS.failed },
  blocked: { label: "חסום", icon: "room-blocks", triplet: STATUS_COLORS.unpaid },
};

export const AREA_TYPE_LABEL: Record<string, string> = {
  lobby: "לובי",
  elevator: "מעלית",
  corridor: "מסדרון",
  gym: "חדר כושר",
  pool: "בריכה",
  parking: "חניון",
  storage: "מחסן",
  other: "אחר",
};

function floorLabel(floor: string | null): string {
  if (floor === null || floor === "") return "ללא קומה";
  if (floor === "0") return "קרקע";
  return `קומה ${floor}`;
}

function fmtDM(date: string, today: string): string {
  if (date === today) return "היום";
  const [, m, d] = date.split("-");
  return `${Number(d)}/${Number(m)}`;
}

type PopoverSeed = { kind: "room"; room: BoardRoom } | { kind: "area"; area: OperationalArea };
type Popover = PopoverSeed & { x: number; y: number };

export function RoomsScreen({
  rooms,
  areas,
  buildings,
  roomTypes,
  amenities,
  property,
  currency,
  today,
  can,
}: {
  rooms: BoardRoom[];
  areas: OperationalArea[];
  buildings: BuildingOption[];
  roomTypes: RoomTypeOption[];
  amenities: AmenityOption[];
  property: Property;
  currency: string;
  today: string;
  can: Can;
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "rooms" | "areas">("all");
  const [status, setStatus] = useState<"all" | RoomDerivedStatus>("all");
  const [wizard, setWizard] = useState<{ room: BoardRoom | null } | null>(null);
  const [areaPanel, setAreaPanel] = useState<{ area: OperationalArea | null } | null>(null);
  const [pop, setPop] = useState<Popover | null>(null);

  const needle = q.trim().toLowerCase();
  const filteredRooms = useMemo(
    () =>
      kind === "areas"
        ? []
        : rooms.filter((r) => {
            if (needle) {
              const hay = [r.room_number, r.name, ...r.translations.map((t) => t.name ?? "")].join(" ").toLowerCase();
              if (!hay.includes(needle)) return false;
            }
            if (status !== "all" && r.derived_status !== status) return false;
            return true;
          }),
    [rooms, kind, needle, status],
  );

  const filteredAreas = useMemo(
    () =>
      kind === "rooms"
        ? []
        : areas.filter((a) => {
            if (needle && !`${a.name} ${a.code ?? ""}`.toLowerCase().includes(needle)) return false;
            if (status !== "all") {
              const map: Partial<Record<RoomDerivedStatus, OperationalArea["status"]>> = {
                blocked: "blocked",
                maintenance: "maintenance",
                cleaning: "cleaning",
                free: "ok",
              };
              if (map[status] !== a.status) return false;
            }
            return true;
          }),
    [areas, kind, needle, status],
  );

  const groups = useMemo(() => {
    const byFloor = new Map<string, BoardRoom[]>();
    for (const r of filteredRooms) {
      const key = r.floor ?? "";
      const arr = byFloor.get(key) ?? [];
      arr.push(r);
      byFloor.set(key, arr);
    }
    return [...byFloor.entries()].sort(([a], [b]) => {
      if (a === "") return 1;
      if (b === "") return -1;
      return Number(a) - Number(b);
    });
  }, [filteredRooms]);

  const openPopover = (e: React.MouseEvent, p: PopoverSeed) => {
    if (!can.edit) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // §8: 316px popover, clamped to the viewport with a 12px margin. X clamps
    // against the KNOWN .popover width; Y is clamped inside StatusPopover
    // against the popover's MEASURED height — the room menu (7 rows) and the
    // area menu (5 rows) differ, and a hardcoded height constant went stale
    // here once and pushed the last row off-screen.
    const x = Math.max(12, Math.min(rect.left, window.innerWidth - 328));
    setPop({ ...p, x, y: rect.bottom + 6 });
  };

  return (
    <div className="flex min-h-full flex-col" dir="rtl">
      {/* header */}
      <div className="rm-hd">
        <h1 className="h1">חדרים ואזורים</h1>
        <span className="chip chip-neutral">
          {/* ONE flex item: .chip is a 6px-gap flex row, so bare <bdi> siblings
              would each become items and pick up double word-spacing */}
          <span>
            <bdi className="ltr-num">{rooms.length}</bdi> חדרים · <bdi className="ltr-num">{areas.length}</bdi> אזורים
          </span>
        </span>
        <span className="rm-hd-sp" />
        <div className="field-input rm-search">
          <Icon name="search" size={20} />
          <input placeholder="חיפוש לפי מספר או שם…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {can.create && (
          <button type="button" className="btn btn-primary" onClick={() => setWizard({ room: null })}>
            <Icon name="plus" size={20} />
            הוספת חדר
          </button>
        )}
        {can.edit && (
          <button type="button" className="btn btn-secondary" onClick={() => setAreaPanel({ area: null })}>
            <Icon name="plus" size={20} />
            הוספת אזור
          </button>
        )}
      </div>

      {/* quick filters — canonical .chip.clickable (§3) */}
      <div className="rm-quick">
        <span className="rm-quick-l">סוג:</span>
        {(
          [
            { v: "all", label: "הכל", icon: "grid" },
            { v: "rooms", label: "חדרים", icon: "hotel" },
            { v: "areas", label: "אזורים", icon: "building" },
          ] as const
        ).map((o) => (
          <button key={o.v} type="button" onClick={() => setKind(o.v)} className={`chip clickable${kind === o.v ? " on" : ""}`}>
            <Icon name={o.icon} size={13.5} />
            {o.label}
          </button>
        ))}
        <span className="rm-vsep" />
        <span className="rm-quick-l">סטטוס:</span>
        <button type="button" onClick={() => setStatus("all")} className={`chip clickable${status === "all" ? " on" : ""}`}>
          הכל
        </button>
        {(Object.keys(STATUS_META) as RoomDerivedStatus[]).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)} className={`chip clickable${status === s ? " on" : ""}`}>
            <span className="dot" style={{ background: STATUS_META[s].triplet.dot }} />
            {STATUS_META[s].label}
          </button>
        ))}
      </div>

      <div className="rm-body">
        {/* floor sections */}
        {groups.map(([floorKey, floorRooms]) => {
          const freeCount = floorRooms.filter((r) => r.derived_status === "free").length;
          return (
            <section key={floorKey || "none"}>
              <div className="rm-sech">
                <Icon name="layers" size={19} />
                <span className="rm-t">{floorLabel(floorKey || null)}</span>
                <span className="rm-c">
                  {floorRooms.length} חדרים · {freeCount} פנויים
                </span>
              </div>
              <div className="rm-grid">
                {floorRooms.map((r) => (
                  <RoomCard key={r.id} room={r} today={today} canEdit={can.edit} onOpen={(e) => openPopover(e, { kind: "room", room: r })} />
                ))}
              </div>
            </section>
          );
        })}
        {filteredRooms.length === 0 && kind !== "areas" && (
          <div className="rm-empty">לא נמצאו חדרים תואמים</div>
        )}

        {/* areas section */}
        {filteredAreas.length > 0 && (
          <section>
            <div className="rm-sech">
              <Icon name="building" size={19} />
              <span className="rm-t">אזורים</span>
              <span className="rm-c">{filteredAreas.length} אזורים · ללא קומה</span>
            </div>
            <div className="rm-grid">
              {filteredAreas.map((a) => (
                <AreaCard key={a.id} area={a} canEdit={can.edit} onOpen={(e) => openPopover(e, { kind: "area", area: a })} />
              ))}
            </div>
          </section>
        )}
        {filteredAreas.length === 0 && kind === "areas" && (
          <div className="rm-empty">לא נמצאו אזורים תואמים</div>
        )}
      </div>

      {pop && (
        <StatusPopover
          pop={pop}
          can={can}
          onClose={() => setPop(null)}
          onEdit={() => {
            if (pop.kind === "room") setWizard({ room: pop.room });
            else setAreaPanel({ area: pop.area });
            setPop(null);
          }}
        />
      )}

      {wizard && (
        <RoomWizard
          room={wizard.room}
          buildings={buildings}
          roomTypes={roomTypes}
          amenities={amenities}
          property={property}
          currency={currency}
          can={can}
          onClose={() => setWizard(null)}
        />
      )}
      {areaPanel && (
        <AreaPanel area={areaPanel.area} buildings={buildings} can={can} onClose={() => setAreaPanel(null)} />
      )}
    </div>
  );
}

// ---------- cards (reference .card anatomy) ----------

function RoomCard({
  room,
  today,
  canEdit,
  onOpen,
}: {
  room: BoardRoom;
  today: string;
  canEdit: boolean;
  onOpen: (e: React.MouseEvent) => void;
}) {
  const meta = STATUS_META[room.derived_status];
  const line: { icon: IconName; text: string } | null =
    room.derived_status === "occupied" && room.current_guest
      ? { icon: "user", text: `${room.current_guest} · עד ${fmtDM(room.current_until!, today)}` }
      : room.next_arrival
        ? { icon: "login", text: `הגעה קרובה: ${fmtDM(room.next_arrival, today)} · ${room.next_guest ?? ""}` }
        : null;

  return (
    <button
      type="button"
      className="card rm-bcard"
      title={`חדר ${room.room_number} · ${meta.label}${canEdit ? " · לחיצה לעדכון סטטוס" : ""}`}
      onClick={onOpen}
    >
      <span className="rm-strip" style={{ background: meta.triplet.dot }} />
      <div className="rm-cr1">
        <span className="rm-num ltr-num">{room.room_number}</span>
        {/* KIND tag — a type label, not a status: .chip-neutral, so it can never
            collide with the status chip beside it (occupied wears chip-brand) */}
        <span className="chip chip-neutral">חדר</span>
        <span className="rm-csp" />
        <span className={`chip ${meta.triplet.chip}`}>
          <Icon name={meta.icon} size={13.5} />
          {meta.label}
        </span>
      </div>
      <div className="rm-cr2">
        {room.room_type_name ?? room.name ?? "—"}
        <span className="rm-dotsep" />
        <span className="rm-cap">
          <Icon name="users-round" size={17} />
          <bdi className="ltr-num">{room.max_occupancy}</bdi> אורחים
        </span>
      </div>
      <div className="rm-cr3">
        {line && (
          <>
            <Icon name={line.icon} size={13.5} />
            {line.text}
          </>
        )}
      </div>
    </button>
  );
}

function AreaCard({
  area,
  canEdit,
  onOpen,
}: {
  area: OperationalArea;
  canEdit: boolean;
  onOpen: (e: React.MouseEvent) => void;
}) {
  const meta = AREA_STATUS_META[area.status];
  return (
    <button
      type="button"
      className="card rm-bcard"
      title={`${area.name} · ${meta.label}${canEdit ? " · לחיצה לעדכון סטטוס" : ""}`}
      onClick={onOpen}
    >
      <span className="rm-strip" style={{ background: meta.triplet.dot }} />
      <div className="rm-cr1">
        <span className="rm-num">{area.name}</span>
        {/* KIND tag — type label, not a status: .chip-neutral (an area in
            "בניקיון" wears chip-transfer; the tag must never mirror it) */}
        <span className="chip chip-neutral">אזור</span>
        <span className="rm-csp" />
        <span className={`chip ${meta.triplet.chip}`}>
          <Icon name={meta.icon} size={13.5} />
          {meta.label}
        </span>
      </div>
      <div className="rm-cr2">{AREA_TYPE_LABEL[area.area_type] ?? area.area_type}</div>
      <div className="rm-cr3">
        {area.status !== "ok" && area.status_note ? (
          <>
            <Icon name={meta.icon} size={13.5} />
            {area.status_note}
          </>
        ) : area.building_name ? (
          area.building_name
        ) : null}
      </div>
    </button>
  );
}

// ---------- status popover (reference .pop) ----------

const ROOM_TARGETS: { target: "free" | "dirty" | "cleaning" | "blocked" | "maintenance"; status: RoomDerivedStatus }[] = [
  { target: "free", status: "free" },
  { target: "dirty", status: "dirty" },
  { target: "cleaning", status: "cleaning" },
  { target: "blocked", status: "blocked" },
  { target: "maintenance", status: "maintenance" },
];

function StatusPopover({
  pop,
  can,
  onClose,
  onEdit,
}: {
  pop: Popover;
  can: Can;
  onClose: () => void;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const busy = useRef(false);

  // §8: clamp Y against the popover's REAL rendered height (room menu = 7 rows,
  // area menu = 5 rows) with the 12px viewport margin — measured, not a
  // constant, so the last row ("עריכת פרטי החדר") can never clip off-screen.
  // useLayoutEffect runs before paint, so the clamped position never flashes.
  const boxRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(pop.y);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    setTop(Math.max(12, Math.min(pop.y, window.innerHeight - el.offsetHeight - 12)));
  }, [pop]);

  const apply = (fn: () => Promise<{ success: boolean; error?: string }>) =>
    startSaving(async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const res = await fn();
        if (!res.success) return void toast.error(res.error ?? "שגיאה");
        toast.success("הסטטוס עודכן");
        router.refresh();
        onClose();
      } finally {
        busy.current = false;
      }
    });

  const title =
    pop.kind === "room" ? (
      <>עדכון סטטוס — חדר {pop.room.room_number}</>
    ) : (
      <>עדכון סטטוס — {pop.area.name}</>
    );
  const sub =
    pop.kind === "room"
      ? [pop.room.room_type_name, floorLabel(pop.room.floor)].filter(Boolean).join(" · ")
      : [AREA_TYPE_LABEL[pop.area.area_type], pop.area.building_name].filter(Boolean).join(" · ");

  return (
    <>
      <div className="rm-pov" onClick={onClose} aria-hidden="true" />
      {/* left/top are a CALCULATED anchor to the click point (§11 allows computed
          geometry); the popover shell itself is the canonical .popover (§8) */}
      <div ref={boxRef} className="popover" style={{ left: pop.x, top }} role="dialog" aria-label="עדכון סטטוס">
        <div className="rm-pop-h">
          <div>
            <div>{title}</div>
            <div className="rm-sub">{sub}</div>
          </div>
          <button type="button" className="icon-btn ms-auto" onClick={onClose}>
            <Icon name="close" size={20} label="סגירה" />
          </button>
        </div>
        <div className="rm-pop-b">
          {pop.kind === "room" ? (
            <>
              {/* free / occupied / dirty / cleaning / blocked / maintenance — reference order */}
              <StOpt
                meta={STATUS_META.free}
                cur={pop.room.derived_status === "free"}
                disabled={saving}
                onClick={() => apply(() => updateRoomBoardStatusAction({ room_id: pop.room.id, target: "free" }))}
              />
              <StOpt
                meta={STATUS_META.occupied}
                cur={pop.room.derived_status === "occupied"}
                disabled
                title="נקבע אוטומטית לפי ההזמנות"
              />
              {ROOM_TARGETS.slice(1).map(({ target, status }) => (
                <StOpt
                  key={target}
                  meta={STATUS_META[status]}
                  cur={pop.room.derived_status === status}
                  disabled={saving}
                  onClick={() => apply(() => updateRoomBoardStatusAction({ room_id: pop.room.id, target }))}
                />
              ))}
            </>
          ) : (
            (Object.keys(AREA_STATUS_META) as OperationalArea["status"][]).map((s) => (
              <StOpt
                key={s}
                meta={AREA_STATUS_META[s]}
                cur={pop.area.status === s}
                disabled={saving}
                onClick={() => apply(() => updateAreaStatusAction({ area_id: pop.area.id, status: s }))}
              />
            ))
          )}
          {can.edit && (
            <div className="rm-pop-edit">
              <button type="button" className="rm-stopt" onClick={onEdit}>
                <Icon name="edit" size={17} />
                {pop.kind === "room" ? "עריכת פרטי החדר" : "עריכת פרטי האזור"}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function StOpt({
  meta,
  cur,
  disabled,
  title,
  onClick,
}: {
  meta: StatusMeta;
  cur: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button type="button" className={`rm-stopt${cur ? " cur" : ""}`} disabled={disabled} title={title} onClick={onClick}>
      <span className="dot" style={{ background: meta.triplet.dot }} />
      {meta.label}
      <span className="rm-chk">
        <Icon name="check" size={17} />
      </span>
    </button>
  );
}
