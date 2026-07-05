"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
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

type StatusMeta = { label: string; stripe: string; bg: string; fg: string; icon: IconName };

// exact reference colors (extracted from the rendered RoomsAndAreas bundle)
export const STATUS_META: Record<RoomDerivedStatus, StatusMeta> = {
  free: { label: "פנוי", stripe: "#16A34A", bg: "#E1F4E9", fg: "#0F6B3C", icon: "check-circle" },
  occupied: { label: "תפוס", stripe: "#2540C8", bg: "#EEF1FD", fg: "#1C2E9A", icon: "user" },
  dirty: { label: "מלוכלך", stripe: "#EA9314", bg: "#FDF2E1", fg: "#8A5207", icon: "droplets" },
  cleaning: { label: "בניקיון", stripe: "#D9A400", bg: "#FBF4D8", fg: "#7A6203", icon: "brush" },
  blocked: { label: "חסום", stripe: "#E5484D", bg: "#FDEBEC", fg: "#B4232D", icon: "room-blocks" },
  maintenance: { label: "תחזוקה", stripe: "#C81E3C", bg: "#FBE7EB", fg: "#A3123B", icon: "maintenance" },
};

export const AREA_STATUS_META: Record<OperationalArea["status"], StatusMeta> = {
  ok: { label: "תקין", stripe: "#16A34A", bg: "#E1F4E9", fg: "#0F6B3C", icon: "check-circle" },
  cleaning: { label: "בניקיון", stripe: "#D9A400", bg: "#FBF4D8", fg: "#7A6203", icon: "brush" },
  maintenance: { label: "תחזוקה", stripe: "#C81E3C", bg: "#FBE7EB", fg: "#A3123B", icon: "maintenance" },
  blocked: { label: "חסום", stripe: "#E5484D", bg: "#FDEBEC", fg: "#B4232D", icon: "room-blocks" },
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
    const x = Math.max(12, Math.min(rect.left, window.innerWidth - 276));
    const y = Math.min(rect.bottom + 6, window.innerHeight - 320);
    setPop({ ...p, x, y });
  };

  return (
    <div className="flex min-h-full flex-col" dir="rtl">
      {/* header (reference .hd) */}
      <div className="rm-hd">
        <h1 className="rm-hd-t">חדרים ואזורים</h1>
        <span className="rm-hd-count">
          {rooms.length} חדרים · {areas.length} אזורים
        </span>
        <span className="rm-hd-sp" />
        <div className="rm-search">
          <Icon name="search" size={20} />
          <input placeholder="חיפוש לפי מספר או שם…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {can.create && (
          <button type="button" className="rm-btn-primary" onClick={() => setWizard({ room: null })}>
            <Icon name="plus" size={17} />
            הוספת חדר
          </button>
        )}
        {can.edit && (
          <button type="button" className="rm-btn-secondary" onClick={() => setAreaPanel({ area: null })}>
            <Icon name="plus" size={17} />
            הוספת אזור
          </button>
        )}
      </div>

      {/* quick filters (reference .quick) */}
      <div className="rm-quick">
        <span className="rm-quick-l">סוג:</span>
        {(
          [
            { v: "all", label: "הכל", icon: "grid" },
            { v: "rooms", label: "חדרים", icon: "hotel" },
            { v: "areas", label: "אזורים", icon: "building" },
          ] as const
        ).map((o) => (
          <button key={o.v} type="button" onClick={() => setKind(o.v)} className={`rm-qchip${kind === o.v ? " on" : ""}`}>
            <Icon name={o.icon} size={17} />
            {o.label}
          </button>
        ))}
        <span className="rm-vsep" />
        <span className="rm-quick-l">סטטוס:</span>
        <button type="button" onClick={() => setStatus("all")} className={`rm-qchip${status === "all" ? " on" : ""}`}>
          הכל
        </button>
        {(Object.keys(STATUS_META) as RoomDerivedStatus[]).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)} className={`rm-qchip${status === s ? " on" : ""}`}>
            <span className="rm-d" style={{ background: STATUS_META[s].stripe }} />
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
      className="rm-bcard"
      title={`חדר ${room.room_number} · ${meta.label}${canEdit ? " · לחיצה לעדכון סטטוס" : ""}`}
      onClick={onOpen}
    >
      <span className="rm-strip" style={{ background: meta.stripe }} />
      <div className="rm-cr1">
        <span className="rm-num" dir="ltr">{room.room_number}</span>
        <span className="rm-kind room">חדר</span>
        <span className="rm-csp" />
        <span className="rm-stbadge" style={{ background: meta.bg, color: meta.fg }}>
          <Icon name={meta.icon} size={14} />
          {meta.label}
        </span>
      </div>
      <div className="rm-cr2">
        {room.room_type_name ?? room.name ?? "—"}
        <span className="rm-dotsep" />
        <span className="rm-cap">
          <Icon name="users-round" size={15} />
          {room.max_occupancy} אורחים
        </span>
      </div>
      <div className="rm-cr3">
        {line && (
          <>
            <Icon name={line.icon} size={14} />
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
      className="rm-bcard"
      title={`${area.name} · ${meta.label}${canEdit ? " · לחיצה לעדכון סטטוס" : ""}`}
      onClick={onOpen}
    >
      <span className="rm-strip" style={{ background: meta.stripe }} />
      <div className="rm-cr1">
        <span className="rm-num">{area.name}</span>
        <span className="rm-kind area">אזור</span>
        <span className="rm-csp" />
        <span className="rm-stbadge" style={{ background: meta.bg, color: meta.fg }}>
          <Icon name={meta.icon} size={14} />
          {meta.label}
        </span>
      </div>
      <div className="rm-cr2">{AREA_TYPE_LABEL[area.area_type] ?? area.area_type}</div>
      <div className="rm-cr3">
        {area.status !== "ok" && area.status_note ? (
          <>
            <Icon name={meta.icon} size={14} />
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
      <div className="rm-pop" style={{ left: pop.x, top: pop.y }} role="dialog" aria-label="עדכון סטטוס">
        <div className="rm-pop-h">
          <div>
            <div>{title}</div>
            <div className="rm-sub">{sub}</div>
          </div>
          <button type="button" className="rm-pop-x" onClick={onClose} aria-label="סגירה">
            <Icon name="close" size={16} />
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
                <Icon name="edit" size={15} />
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
      <span className="rm-d" style={{ background: meta.stripe }} />
      {meta.label}
      <span className="rm-chk">
        <Icon name="check" size={16} />
      </span>
    </button>
  );
}
