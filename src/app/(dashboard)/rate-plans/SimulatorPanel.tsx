"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { F, QtyStep } from "@/app/(dashboard)/rooms/RoomWizard";
import { formatFullDate, nightsBetween } from "@/lib/dates";
import type {
  AdjustmentSource,
  NightQuote,
  PriceSource,
  PricingError,
  PricingQuoteResult,
  PricingWarning,
  RoomQuote,
} from "@/lib/pricing/types";
import { simulateQuoteAction } from "./actions";
import type { AssignableUnit, RatePlanListItem } from "./types";

// ============================================================
// Pricing simulator (spec §21) — operational verification panel. Builds the
// exact simulateQuoteSchema payload, calls THE central engine through
// simulateQuoteAction, and renders the full PricingQuoteResult faithfully:
// verdict, totals, per-room provenance, nightly breakdown, engine meta.
// ============================================================

const MAX_ROOMS = 10;
const MAX_GUESTS = 20;

// Hebrew labels for the engine's machine-readable provenance values.
const PRICE_SOURCE_HE: Record<PriceSource, string> = {
  base_plan_rate: "רשת תעריפים",
  room_type_base_price: "מחיר בסיס סוג חדר",
  derived_from_parent_plan: "נגזר מתוכנית האב",
  plan_unit_date_override: "חריגת תאריך",
  independent_plan_price: "מחיר עצמאי",
  manual_override: "מחיר ידני מאושר",
};

const ADJUSTMENT_SOURCE_HE: Record<AdjustmentSource, string> = {
  plan_adjustment: "התאמת תוכנית",
  assignment_adjustment: "התאמת שיוך",
};

const RESTRICTION_GROUP_HE: Record<string, string> = {
  room_status: "סטטוס חדר",
  availability: "זמינות פיזית",
  assignment: "שיוך תוכנית",
  plan_rules: "כללי תוכנית",
  date_restrictions: "הגבלות תאריך",
  occupancy: "תפוסה",
};

const EXTRA_GUEST_SOURCE_HE: Record<RoomQuote["extraGuestSource"], string> = {
  room_override: "חריגת חדר",
  property_default: "ברירת מחדל הנכס",
  unconfigured: "לא הוגדר",
};

const EXTRA_GUEST_FREQUENCY_HE: Record<RoomQuote["extraGuestFrequency"], string> = {
  per_night: "ללילה",
  per_stay: "לשהות",
};

type RowState = {
  key: number;
  roomId: string;
  ratePlanId: string;
  adults: number;
  children: number;
  infants: number;
};

const clampGuest = (v: number | null): number =>
  Math.min(MAX_GUESTS, Math.max(0, v ?? 0));

// ---- small render helpers ----

function Money({ fmt, v }: { fmt: Intl.NumberFormat; v: number }) {
  return (
    <span dir="ltr" className="tabular-nums">
      {fmt.format(v)}
    </span>
  );
}

function CodeChip({ code }: { code: string }) {
  return (
    <span dir="ltr" className="chip chip-neutral font-mono">
      {code}
    </span>
  );
}

function ErrorList({ errors }: { errors: PricingError[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {errors.map((e, i) => (
        <li key={`${e.code}-${i}`} className="flex flex-wrap items-center gap-2 text-[14px]">
          <span>{e.message}</span>
          <CodeChip code={e.code} />
          {e.date ? (
            <span dir="ltr" className="text-[12px] opacity-80">
              {formatFullDate(e.date)}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function WarningList({ warnings }: { warnings: PricingWarning[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {warnings.map((w, i) => (
        <li key={`${w.code}-${i}`} className="flex flex-wrap items-center gap-2 text-[14px]">
          <Icon name="info" size={13.5} />
          <span>{w.message}</span>
          <CodeChip code={w.code} />
          {w.date ? (
            <span dir="ltr" className="text-[12px] opacity-80">
              {formatFullDate(w.date)}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Stat({
  label,
  big,
  children,
}: {
  label: React.ReactNode;
  big?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="t-label">{label}</span>
      <span className={big ? "h3" : "text-[14px] font-semibold text-ink"}>
        {children}
      </span>
    </div>
  );
}

// ---- nightly breakdown table (§8.3 provenance, rendered as-is) ----

const NIGHT_HEADERS = [
  "תאריך",
  "מחיר בסיס",
  "התאמה",
  "חריגת תאריך",
  "מחיר לילה",
  "מקור",
  "אורח נוסף",
  'סה"כ לילה',
] as const;

function NightsTable({ nights, fmt }: { nights: NightQuote[]; fmt: Intl.NumberFormat }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[860px] text-[14px] text-ink">
        <thead>
          <tr className="border-b border-line bg-hover">
            {NIGHT_HEADERS.map((h) => (
              <th key={h} className="px-4 py-3 text-start text-[12px] font-bold text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nights.map((n) => (
            <tr key={n.date} className="border-b border-line last:border-b-0">
              <td className="px-4 py-3">
                <span dir="ltr">{formatFullDate(n.date)}</span>
              </td>
              <td className="px-4 py-3">
                {n.basePrice != null ? (
                  <span className="flex flex-col">
                    <Money fmt={fmt} v={n.basePrice} />
                    {n.basePriceSource ? (
                      <span className="text-[12px] text-muted">
                        {PRICE_SOURCE_HE[n.basePriceSource]}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-4 py-3">
                <span className="flex flex-col">
                  {n.adjustmentValue != null ? (
                    <>
                      <span dir="ltr">
                        {n.adjustmentValue > 0
                          ? `+${n.adjustmentValue}`
                          : String(n.adjustmentValue)}
                      </span>
                      {n.adjustmentSource ? (
                        <span className="text-[12px] text-muted">
                          {ADJUSTMENT_SOURCE_HE[n.adjustmentSource]}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span>—</span>
                  )}
                  {n.parentResolvedPrice != null ? (
                    <span className="text-[12px] text-muted">
                      אב: <Money fmt={fmt} v={n.parentResolvedPrice} />
                    </span>
                  ) : null}
                </span>
              </td>
              <td className="px-4 py-3">
                {n.overridePrice != null ? <Money fmt={fmt} v={n.overridePrice} /> : "—"}
              </td>
              <td className="px-4 py-3 font-bold">
                {n.resolvedPlanPrice != null ? (
                  <Money fmt={fmt} v={n.resolvedPlanPrice} />
                ) : (
                  "—"
                )}
              </td>
              <td className="px-4 py-3">{n.priceSource ? PRICE_SOURCE_HE[n.priceSource] : "—"}</td>
              <td className="px-4 py-3">
                {n.extraGuestAmount > 0 ? <Money fmt={fmt} v={n.extraGuestAmount} /> : "—"}
              </td>
              <td className="px-4 py-3 font-semibold">
                {n.nightTotal != null ? <Money fmt={fmt} v={n.nightTotal} /> : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- per-room result card ----

function RoomCard({ room, fmt }: { room: RoomQuote; fmt: Intl.NumberFormat }) {
  const extraCount = room.extraAdults + room.extraChildren + room.extraInfants;
  const showExtra = room.extraGuestTotal > 0 || extraCount > 0;
  return (
    <section className="flex flex-col gap-4 rounded-[16px] border border-line bg-surface p-4 shadow-card">
      <header className="flex flex-wrap items-center gap-2">
        <h4 className="h4">חדר {room.roomNumber}</h4>
        {room.roomName ? <span className="text-[14px] text-muted">{room.roomName}</span> : null}
        <span className="text-[14px] text-ink">· {room.ratePlanName}</span>
        <CodeChip code={room.ratePlanCode} />
        <span className="grow" />
        <span className={`chip ${room.valid ? "chip-paid" : "chip-unpaid"}`}>
          <span className="dot" />
          {room.valid ? "תקף" : "נדחה"}
        </span>
        <span className={`chip ${room.available ? "chip-paid" : "chip-unpaid"}`}>
          <span className="dot" />
          {room.available ? "פנוי" : "לא זמין"}
        </span>
      </header>

      {room.errors.length > 0 ? (
        <div className="rounded-xl bg-status-danger-050 p-4 text-status-danger">
          <ErrorList errors={room.errors} />
        </div>
      ) : null}
      {room.warnings.length > 0 ? (
        <div className="rounded-xl bg-status-warning-050 p-4 text-status-warning">
          <WarningList warnings={room.warnings} />
        </div>
      ) : null}

      <p className="flex items-center gap-1.5 text-[14px] text-ink">
        <Icon name="users-round" size={17} />
        מבוגרים {room.adults} · ילדים {room.children} · תינוקות {room.infants}
      </p>

      {showExtra ? (
        <div className="flex flex-col gap-1.5 rounded-[12px] bg-primary-050 p-4 text-[14px] text-ink">
          <p className="flex items-center gap-1.5 font-semibold">
            <Icon name="baby" size={17} />
            אורחים נוספים
          </p>
          <p>תפוסה כלולה: {room.includedOccupancy ?? "—"}</p>
          <p>
            נוספים: מבוגרים {room.extraAdults} · ילדים {room.extraChildren} · תינוקות{" "}
            {room.extraInfants}
          </p>
          <p>
            מקור: {EXTRA_GUEST_SOURCE_HE[room.extraGuestSource]} · חיוב:{" "}
            {EXTRA_GUEST_FREQUENCY_HE[room.extraGuestFrequency]}
          </p>
          {room.extraGuestFrequency === "per_night" ? (
            <p>
              תוספת ללילה: <Money fmt={fmt} v={room.extraGuestPerNight} />
            </p>
          ) : (
            <p>
              תוספת לשהות: <Money fmt={fmt} v={room.extraGuestPerStay} />
            </p>
          )}
          <p className="font-semibold">
            סה&quot;כ תוספת אורחים: <Money fmt={fmt} v={room.extraGuestTotal} />
          </p>
        </div>
      ) : null}

      {room.nights.length > 0 ? <NightsTable nights={room.nights} fmt={fmt} /> : null}

      <p className="text-[14px] font-semibold text-ink">
        סה&quot;כ לחדר: <Money fmt={fmt} v={room.roomSubtotal} />
      </p>
    </section>
  );
}

// ---- full results area (re-mounted per run via key) ----

function ResultsView({ quote, onClear }: { quote: PricingQuoteResult; onClear: () => void }) {
  const fmt = useMemo(() => {
    try {
      return new Intl.NumberFormat("he-IL", { style: "currency", currency: quote.currency });
    } catch {
      return new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2 });
    }
  }, [quote.currency]);

  const anyPriced = quote.rooms.some((r) => r.nights.some((n) => n.nightTotal != null));
  const restrictions = [...new Set(quote.rooms.flatMap((r) => r.restrictionsEvaluated))];
  const sources = [...new Set(quote.rooms.flatMap((r) => r.priceSourcesUsed))];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="h4">תוצאות הסימולציה</h3>
        <button
          type="button"
          onClick={onClear}
          className="btn btn-tertiary"
        >
          נקה תוצאות
        </button>
      </div>

      {/* 1 — verdict banner + global errors */}
      <div
        className={`flex flex-col gap-2 rounded-xl p-4 ${
          quote.valid
            ? "bg-status-success-050 text-status-success"
            : "bg-status-danger-050 text-status-danger"
        }`}
      >
        <p className="flex items-center gap-2 font-semibold">
          <Icon name={quote.valid ? "check" : "warning"} size={20} />
          {quote.valid ? "הצעת המחיר תקפה" : "הצעת המחיר אינה תקפה"}
        </p>
        {quote.errors.length > 0 ? <ErrorList errors={quote.errors} /> : null}
      </div>
      {quote.warnings.length > 0 ? (
        <div className="rounded-xl bg-status-warning-050 p-4 text-status-warning">
          <WarningList warnings={quote.warnings} />
        </div>
      ) : null}

      {/* 2 — totals */}
      {anyPriced ? (
        <section className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-5">
          <Stat label='סה"כ כולל מע"מ' big>
            <Money fmt={fmt} v={quote.totalGross} />
          </Stat>
          <Stat
            label={
              <>
                מע&quot;מ <span dir="ltr">{quote.vatRate}%</span>
              </>
            }
          >
            <Money fmt={fmt} v={quote.vatAmount} />
          </Stat>
          <Stat label="לפני מע&quot;מ">
            <Money fmt={fmt} v={quote.subtotalNet} />
          </Stat>
          <Stat label="מטבע">
            <span dir="ltr">{quote.currency}</span>
          </Stat>
          <Stat label="לילות">
            <span dir="ltr">{quote.numberOfNights}</span>
          </Stat>
        </section>
      ) : null}

      {/* 3–5 — per-room cards */}
      {quote.rooms.map((room, i) => (
        <RoomCard key={`${room.roomId}-${i}`} room={room} fmt={fmt} />
      ))}

      {/* 6 — engine meta */}
      <section className="flex flex-col gap-2 rounded-[12px] border border-line bg-surface p-4 text-[12px] text-muted">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span>
            גרסת מנוע: <span dir="ltr">{quote.engineVersion}</span>
          </span>
          <span title={quote.roundingPolicy}>
            מדיניות עיגול: עיגול לאגורות לכל לילה; אורח נוסף לפי כלל העיגול של הנכס; מע״מ מחולץ מהסכום הכולל
          </span>
          <span>
            טביעת אצבע:{" "}
            <span dir="ltr" title={quote.quoteFingerprint} className="font-mono">
              {quote.quoteFingerprint.slice(0, 16)}
            </span>
          </span>
        </div>
        {restrictions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span>חוקים שנבדקו:</span>
            {restrictions.map((r) => (
              <span key={r} className="chip chip-neutral">
                {RESTRICTION_GROUP_HE[r] ?? r}
              </span>
            ))}
          </div>
        ) : null}
        {sources.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span>מקורות מחיר בשימוש:</span>
            {/* price SOURCES wear the canonical .chip-brand so they stay visually
                distinct from the grey restriction-group chips above */}
            {sources.map((s) => (
              <span key={s} className="chip chip-brand">
                {PRICE_SOURCE_HE[s]}
              </span>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

// ---- the panel ----

export function SimulatorPanel({
  open,
  onClose,
  units,
  plans,
}: {
  open: boolean;
  onClose: () => void;
  units: AssignableUnit[];
  plans: RatePlanListItem[];
}) {
  const nextKey = useRef(1);
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [rows, setRows] = useState<RowState[]>([
    { key: 0, roomId: "", ratePlanId: "", adults: 2, children: 0, infants: 0 },
  ]);
  const [quote, setQuote] = useState<PricingQuoteResult | null>(null);
  const [runId, setRunId] = useState(0);
  const [pending, startTransition] = useTransition();

  const roomOptions = useMemo(() => units.filter((u) => u.room_id != null), [units]);
  const planOptions = useMemo(() => plans.filter((p) => !p.is_archived), [plans]);

  const nights = checkIn && checkOut ? nightsBetween(checkIn, checkOut) : null;

  const setRow = (key: number, patch: Partial<RowState>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addRow = () =>
    setRows((rs) =>
      rs.length >= MAX_ROOMS
        ? rs
        : [
            ...rs,
            {
              key: nextKey.current++,
              roomId: "",
              ratePlanId: "",
              adults: 2,
              children: 0,
              infants: 0,
            },
          ],
    );

  const submit = () => {
    if (!checkIn || !checkOut) {
      toast.error("יש לבחור תאריכי צ׳ק-אין וצ׳ק-אאוט");
      return;
    }
    if (nights == null || nights < 1) {
      toast.error("תאריך הצ׳ק-אאוט חייב להיות אחרי תאריך הצ׳ק-אין");
      return;
    }
    if (rows.some((r) => !r.roomId || !r.ratePlanId)) {
      toast.error("יש לבחור חדר ותוכנית תעריף בכל שורה");
      return;
    }
    startTransition(async () => {
      const res = await simulateQuoteAction({
        checkIn,
        checkOut,
        rooms: rows.map((r) => ({
          roomId: r.roomId,
          ratePlanId: r.ratePlanId,
          adults: r.adults,
          children: r.children,
          infants: r.infants,
        })),
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      if (!res.quote) {
        toast.error("אירעה שגיאה בלתי צפויה");
        return;
      }
      setQuote(res.quote);
      setRunId((n) => n + 1);
    });
  };

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title="סימולטור תמחור"
      subtitle="בדיקת חישוב מנוע התמחור — כלי תפעולי"
      icon="calculator"
      widthClassName="w-[60vw]"
    >
      <div className="flex flex-col gap-4">
        {/* form card */}
        <section className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <F label="צ׳ק-אין" required>
              <input
                type="date"
                dir="ltr"
                className="field-input ltr-num"
                value={checkIn}
                onChange={(e) => setCheckIn(e.target.value)}
              />
            </F>
            <F label="צ׳ק-אאוט" required>
              <input
                type="date"
                dir="ltr"
                className="field-input ltr-num"
                value={checkOut}
                onChange={(e) => setCheckOut(e.target.value)}
              />
            </F>
            {nights != null && nights >= 1 ? (
              <div className="flex items-center pb-3.5">
                <span className="chip chip-neutral">
                  <bdi className="ltr-num">{nights}</bdi> לילות
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-3">
            {rows.map((row) => (
              <div
                key={row.key}
                className="flex flex-wrap items-end gap-3 rounded-[12px] border border-line bg-surface p-4"
              >
                <div className="min-w-44 flex-1">
                  <F label="חדר" required>
                    <select
                      className="field-input"
                      value={row.roomId}
                      onChange={(e) => setRow(row.key, { roomId: e.target.value })}
                    >
                      <option value="">בחירת חדר…</option>
                      {roomOptions.map((u) => (
                        <option key={u.sellable_unit_id} value={u.room_id ?? ""}>
                          חדר {u.room_number} — {u.room_name ?? u.room_type_name}
                        </option>
                      ))}
                    </select>
                  </F>
                </div>
                <div className="min-w-44 flex-1">
                  <F label="תוכנית תעריף" required>
                    <select
                      className="field-input"
                      value={row.ratePlanId}
                      onChange={(e) => setRow(row.key, { ratePlanId: e.target.value })}
                    >
                      <option value="">בחירת תוכנית…</option>
                      {planOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {p.code}
                          {p.is_active ? "" : " (לא פעילה)"}
                        </option>
                      ))}
                    </select>
                  </F>
                </div>
                <QtyStep
                  label="מבוגרים"
                  value={row.adults}
                  onChange={(v) => setRow(row.key, { adults: clampGuest(v) })}
                />
                <QtyStep
                  label="ילדים"
                  value={row.children}
                  onChange={(v) => setRow(row.key, { children: clampGuest(v) })}
                />
                <QtyStep
                  label="תינוקות"
                  value={row.infants}
                  onChange={(v) => setRow(row.key, { infants: clampGuest(v) })}
                />
                {rows.length > 1 ? (
                  <button
                    type="button"
                    aria-label="הסרת חדר"
                    title="הסרת חדר"
                    className="icon-btn shrink-0 text-status-danger hover:bg-status-danger-050"
                    onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
                  >
                    <Icon name="trash" size={20} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={addRow}
              disabled={rows.length >= MAX_ROOMS}
            >
              <Icon name="plus" size={20} />
              הוסף חדר
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={pending}>
              <Icon name="calculator" size={20} />
              {pending ? "מחשב…" : "חשב מחיר"}
            </button>
          </div>
        </section>

        {/* results — keyed per run so the whole area re-mounts */}
        {quote ? (
          <ResultsView key={runId} quote={quote} onClear={() => setQuote(null)} />
        ) : null}
      </div>
    </SidePanel>
  );
}
