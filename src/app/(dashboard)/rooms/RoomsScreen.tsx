"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/shared/Icon";
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

type Property = ExtraGuestDefaults & { adult_min_age: number };
export type Can = { create: boolean; edit: boolean; del: boolean };

const STATUS_META: Record<RoomDerivedStatus, { label: string; dot: string; chip: string; stripe: string }> = {
  free: { label: "פנוי", dot: "bg-status-success", chip: "bg-status-success-050 text-status-success", stripe: "var(--color-status-success)" },
  occupied: { label: "תפוס", dot: "bg-status-info", chip: "bg-primary-050 text-primary", stripe: "var(--color-status-info)" },
  dirty: { label: "מלוכלך", dot: "bg-status-warning", chip: "bg-status-warning-050 text-status-warning", stripe: "var(--color-status-warning)" },
  cleaning: { label: "בניקיון", dot: "bg-status-warning", chip: "bg-status-warning-050 text-status-warning", stripe: "var(--color-status-warning)" },
  blocked: { label: "חסום", dot: "bg-status-danger", chip: "bg-status-danger-050 text-status-danger", stripe: "var(--color-status-danger)" },
  maintenance: { label: "תחזוקה", dot: "bg-status-danger", chip: "bg-status-danger-050 text-status-danger", stripe: "var(--color-status-purple)" },
};

const AREA_STATUS_META: Record<OperationalArea["status"], { label: string; chip: string }> = {
  ok: { label: "תקין", chip: "bg-status-success-050 text-status-success" },
  maintenance: { label: "תחזוקה", chip: "bg-status-danger-050 text-status-danger" },
  cleaning: { label: "בניקיון", chip: "bg-status-warning-050 text-status-warning" },
  blocked: { label: "חסום", chip: "bg-status-danger-050 text-status-danger" },
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
  const [building, setBuilding] = useState<string>("all");
  const [floor, setFloor] = useState<string>("all");
  const [wizard, setWizard] = useState<{ room: BoardRoom | null } | null>(null);
  const [areaPanel, setAreaPanel] = useState<{ area: OperationalArea | null } | null>(null);

  const floors = useMemo(
    () => [...new Set(rooms.map((r) => r.floor ?? ""))].sort((a, b) => Number(a) - Number(b)),
    [rooms],
  );

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
            if (building !== "all" && r.area_id !== building) return false;
            if (floor !== "all" && (r.floor ?? "") !== floor) return false;
            return true;
          }),
    [rooms, kind, needle, status, building, floor],
  );

  const filteredAreas = useMemo(
    () =>
      kind === "rooms"
        ? []
        : areas.filter((a) => {
            if (needle && !`${a.name} ${a.code ?? ""}`.toLowerCase().includes(needle)) return false;
            if (building !== "all" && a.building_area_id !== building) return false;
            if (floor !== "all" && (a.floor ?? "") !== floor) return false;
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
    [areas, kind, needle, status, building, floor],
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

  const incomplete = rooms.filter((r) => r.incomplete).length;

  return (
    <div className="flex flex-col gap-5 p-[26px]" dir="rtl">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">חדרים ואזורים</h1>
          <p className="mt-1 text-sm font-semibold text-primary">
            {rooms.length} חדרים · {areas.length} אזורים
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Icon name="search" size={16} className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-faint" />
            <input
              className="h-11 w-64 rounded-xl border border-line bg-surface pe-9 ps-3 text-sm outline-none focus:border-primary"
              placeholder="חיפוש לפי מספר או שם…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {can.create && (
            <button type="button" className="bw-btn bw-btn-primary" onClick={() => setWizard({ room: null })}>
              <Icon name="plus" size={16} />
              הוספת חדר
            </button>
          )}
          {can.edit && (
            <button type="button" className="bw-btn bw-btn-o" onClick={() => setAreaPanel({ area: null })}>
              <Icon name="plus" size={16} />
              הוספת אזור
            </button>
          )}
        </div>
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-muted">סוג:</span>
        {(
          [
            { v: "all", label: "הכל", icon: "dashboard" },
            { v: "rooms", label: "חדרים", icon: "rooms" },
            { v: "areas", label: "אזורים", icon: "building" },
          ] as const
        ).map((o) => (
          <button
            key={o.v}
            type="button"
            onClick={() => setKind(o.v)}
            className={`flex min-h-10 items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-semibold transition-colors ${
              kind === o.v ? "border-primary bg-primary text-white" : "border-line bg-surface text-text2 hover:bg-hover"
            }`}
          >
            <Icon name={o.icon} size={14} />
            {o.label}
          </button>
        ))}

        <span className="ms-3 text-sm font-semibold text-muted">סטטוס:</span>
        <button
          type="button"
          onClick={() => setStatus("all")}
          className={`min-h-10 rounded-xl border px-3 py-1.5 text-sm font-semibold ${
            status === "all" ? "border-primary bg-primary text-white" : "border-line bg-surface text-text2 hover:bg-hover"
          }`}
        >
          הכל
        </button>
        {(Object.keys(STATUS_META) as RoomDerivedStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`flex min-h-10 items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-semibold ${
              status === s ? "border-primary bg-primary-050 text-primary" : "border-line bg-surface text-text2 hover:bg-hover"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${STATUS_META[s].dot}`} />
            {STATUS_META[s].label}
          </button>
        ))}

        {buildings.length > 0 && (
          <select
            className="h-10 rounded-xl border border-line bg-surface px-3 text-sm text-text2 outline-none"
            value={building}
            onChange={(e) => setBuilding(e.target.value)}
            aria-label="סינון לפי בניין/אגף"
          >
            <option value="all">כל הבניינים</option>
            {buildings.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        )}
        <select
          className="h-10 rounded-xl border border-line bg-surface px-3 text-sm text-text2 outline-none"
          value={floor}
          onChange={(e) => setFloor(e.target.value)}
          aria-label="סינון לפי קומה"
        >
          <option value="all">כל הקומות</option>
          {floors.map((f) => (
            <option key={f || "none"} value={f}>{floorLabel(f || null)}</option>
          ))}
        </select>
      </div>

      {incomplete > 0 && (
        <div className="flex items-center gap-2 rounded-xl bg-status-warning-050 px-4 py-3 text-sm" style={{ color: "#B4670A" }}>
          <Icon name="warning" size={16} />
          {incomplete} חדרים דורשים השלמה — חסרים בהם פרטים חיוניים (מסומנים על הכרטיס).
        </div>
      )}

      {/* floor groups */}
      {groups.map(([floorKey, floorRooms]) => {
        const freeCount = floorRooms.filter((r) => r.derived_status === "free").length;
        return (
          <section key={floorKey || "none"} className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
              <Icon name="building" size={16} className="text-faint" />
              {floorLabel(floorKey || null)}
              <span className="font-semibold text-faint">
                {floorRooms.length} חדרים · {freeCount} פנויים
              </span>
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {floorRooms.map((r) => (
                <RoomCard key={r.id} room={r} today={today} onOpen={() => can.edit && setWizard({ room: r })} />
              ))}
            </div>
          </section>
        );
      })}
      {filteredRooms.length === 0 && kind !== "areas" && (
        <p className="py-6 text-center text-sm text-faint">לא נמצאו חדרים תואמים</p>
      )}

      {/* areas */}
      {filteredAreas.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
            <Icon name="building" size={16} className="text-faint" />
            אזורים
            <span className="font-semibold text-faint">{filteredAreas.length} אזורים · ללא קומה</span>
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredAreas.map((a) => (
              <AreaCard key={a.id} area={a} onOpen={() => can.edit && setAreaPanel({ area: a })} />
            ))}
          </div>
        </section>
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

function RoomCard({ room, today, onOpen }: { room: BoardRoom; today: string; onOpen: () => void }) {
  const meta = STATUS_META[room.derived_status];
  const bottom =
    room.derived_status === "occupied" && room.current_guest
      ? `${room.current_guest} · עד ${fmtDM(room.current_until!, today)}`
      : room.next_arrival
        ? `הגעה קרובה: ${fmtDM(room.next_arrival, today)} · ${room.next_guest ?? ""}`
        : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-[110px] flex-col gap-2 rounded-2xl border border-line bg-surface p-4 text-start shadow-card transition-shadow hover:shadow-pop"
      style={{ borderInlineStart: `4px solid ${meta.stripe}` }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="text-lg font-extrabold text-ink" dir="ltr">{room.room_number}</span>
          <span className="rounded-full bg-primary-050 px-2 py-0.5 text-xs font-semibold text-primary">חדר</span>
        </span>
        <span className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${meta.chip}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
          {meta.label}
        </span>
      </div>
      <div className="flex items-center gap-2 text-sm text-text2">
        <span className="font-semibold">{room.room_type_name ?? room.name ?? "—"}</span>
        <span className="text-faint">·</span>
        <span className="flex items-center gap-1 text-faint">
          <Icon name="users-round" size={14} />
          {room.max_occupancy} אורחים
        </span>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="truncate text-xs text-faint">{bottom ?? " "}</span>
        {room.incomplete && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-status-warning-050 px-2 py-0.5 text-xs font-semibold text-status-warning"
            title={`חסר: ${room.missing.join(", ")}`}
          >
            <Icon name="warning" size={12} />
            דורש השלמה
          </span>
        )}
      </div>
    </button>
  );
}

function AreaCard({ area, onOpen }: { area: OperationalArea; onOpen: () => void }) {
  const meta = AREA_STATUS_META[area.status];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-[110px] flex-col gap-2 rounded-2xl border border-line bg-surface p-4 text-start shadow-card transition-shadow hover:shadow-pop"
      style={{ borderInlineStart: "4px solid var(--color-status-purple)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="text-lg font-extrabold text-ink">{area.name}</span>
          <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: "#f3e8ff", color: "var(--color-status-purple)" }}>
            אזור
          </span>
        </span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${meta.chip}`}>{meta.label}</span>
      </div>
      <div className="text-sm font-semibold text-text2">{AREA_TYPE_LABEL[area.area_type] ?? area.area_type}</div>
      <div className="mt-auto truncate text-xs text-faint">{area.status_note ?? area.building_name ?? " "}</div>
    </button>
  );
}
