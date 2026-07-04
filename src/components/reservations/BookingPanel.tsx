"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { SidePanel } from "@/components/ui/SidePanel";
import { Icon } from "@/components/shared/Icon";
import { formatFullDate, nightsBetween } from "@/lib/dates";
import { paymentState } from "@/lib/inventory-rules";
import {
  createReservationAction,
  searchGuestsAction,
  getStayQuoteAction,
} from "@/app/(dashboard)/reservations/actions";
import { StayEditor, newStayKey, type StayDraft } from "./StayEditor";
import type { LookupItem } from "@/app/(dashboard)/calendar/CalendarScreen";

// The canonical new-reservation flow (הקמת הזמנה חדשה) — a 4-step SidePanel
// wizard per ref/screens/new-booking-step-*.png. The calendar opens THIS
// flow; there is no calendar-only editor (§G).

export type BookingPrefill = {
  roomId?: string;
  checkIn?: string;
  checkOut?: string;
};

type GuestForm = {
  id?: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  idNumber: string;
  country: string;
  language: string;
};

const EMPTY_GUEST: GuestForm = {
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  idNumber: "",
  country: "ישראל",
  language: "עברית",
};

const STEPS = ["פרטי אורח", "שהות וחדרים", "תמחור ותשלום", "סיכום ואישור"];

export function BookingPanel({
  open,
  onClose,
  prefill,
  bookingSources,
  paymentMethods,
}: {
  open: boolean;
  onClose: () => void;
  prefill: BookingPrefill;
  bookingSources: LookupItem[];
  paymentMethods: LookupItem[];
}) {
  const [step, setStep] = useState(0);
  const [guest, setGuest] = useState<GuestForm>(EMPTY_GUEST);
  const [sourceId, setSourceId] = useState<string>("");
  const [stays, setStays] = useState<StayDraft[]>([]);
  const [quotes, setQuotes] = useState<Record<string, { total: number; restriction: string | null }>>({});
  const [discount, setDiscount] = useState(0);
  const [paid, setPaid] = useState(0);
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, startSaving] = useTransition();

  // guest search
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { id: string; full_name: string; first_name: string | null; last_name: string | null; phone: string | null; email: string | null; id_number: string | null }[]
  >([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setGuest(EMPTY_GUEST);
    setSourceId(bookingSources[0]?.id ?? "");
    setStays([
      {
        key: newStayKey(),
        roomId: prefill.roomId ?? "",
        checkIn: prefill.checkIn ?? "",
        checkOut: prefill.checkOut ?? "",
        adults: 2,
        children: 0,
        infants: 0,
      },
    ]);
    setQuotes({});
    setDiscount(0);
    setPaid(0);
    setMethod("");
    setNotes("");
    setQuery("");
    setResults([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      const res = await searchGuestsAction(query);
      if (res.success && res.data) setResults(res.data);
    }, 250);
  }, [query]);

  // quotes for pricing/summary steps
  useEffect(() => {
    if (step < 2) return;
    for (const s of stays) {
      if (!s.roomId || !s.checkIn || !s.checkOut || s.checkOut <= s.checkIn) continue;
      getStayQuoteAction({ roomId: s.roomId, checkIn: s.checkIn, checkOut: s.checkOut }).then((res) => {
        if (res.success && res.data) {
          setQuotes((q) => ({ ...q, [s.key]: { total: res.data!.total, restriction: res.data!.restriction } }));
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const staysValid =
    stays.length > 0 &&
    stays.every((s) => s.roomId && s.checkIn && s.checkOut && s.checkOut > s.checkIn);
  const roomsTotal = stays.reduce((sum, s) => {
    const q = quotes[s.key];
    const nights = s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0;
    return sum + (s.ratePerNight != null ? s.ratePerNight * nights : (q?.total ?? 0));
  }, 0);
  const total = Math.max(0, roomsTotal - discount);
  const payState = paymentState(total, paid);

  const stepValid = useMemo(() => {
    if (step === 0) return guest.firstName.trim() !== "" && guest.lastName.trim() !== "" && guest.phone.trim() !== "";
    if (step === 1) return staysValid;
    return true;
  }, [step, guest, staysValid]);

  const submit = () =>
    startSaving(async () => {
      const res = await createReservationAction({
        guest: {
          id: guest.id,
          firstName: guest.firstName.trim(),
          lastName: guest.lastName.trim(),
          phone: guest.phone.trim() || undefined,
          email: guest.email.trim() || undefined,
          idNumber: guest.idNumber.trim() || undefined,
          country: guest.country.trim() || undefined,
          language: guest.language.trim() || undefined,
        },
        sourceId: sourceId || null,
        status: "confirmed",
        rooms: stays.map((s) => ({
          roomId: s.roomId,
          checkIn: s.checkIn,
          checkOut: s.checkOut,
          adults: s.adults,
          children: s.children,
          infants: s.infants,
          ratePerNight: s.ratePerNight,
          guestFirstName: s.guestFirstName || undefined,
          guestLastName: s.guestLastName || undefined,
          guestPhone: s.guestPhone || undefined,
        })),
        notes: notes.trim() || undefined,
        discountAmount: discount || undefined,
        paidAmount: paid || undefined,
        paymentMethod: method || undefined,
      });
      if (res.success) {
        toast.success(`הזמנה #${res.data?.reservationNumber} נוצרה בהצלחה`);
        onClose();
      } else {
        toast.error(res.error);
      }
    });

  const guestDisplay = `${guest.firstName} ${guest.lastName}`.trim() || "אורח חדש";
  const sourceLabel = bookingSources.find((s) => s.id === sourceId)?.label;

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title="הקמת הזמנה חדשה"
      subtitle="אורח · שהות · תמחור · אישור"
      icon="calendar-plus"
      footer={
        <div className="flex items-center justify-between gap-3">
          <button type="button" className="text-sm font-semibold text-muted hover:text-ink" onClick={onClose}>
            ביטול
          </button>
          <div className="flex items-center gap-3">
            <span className="text-xs text-faint">
              שלב {step + 1} מתוך {STEPS.length}
            </span>
            {step > 0 && (
              <button type="button" className="btn btn-outline" onClick={() => setStep((s) => s - 1)}>
                הקודם
                <Icon name="chevron-right" size={16} />
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!stepValid}
                onClick={() => setStep((s) => s + 1)}
              >
                <Icon name="chevron-left" size={16} />
                הבא
              </button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={saving || !staysValid} onClick={submit}>
                <Icon name="check" size={16} />
                {saving ? "יוצר…" : "צור הזמנה"}
              </button>
            )}
          </div>
        </div>
      }
    >
      {/* stepper — RTL sequence 1→4 flows right-to-left naturally */}
      <ol className="mb-6 flex items-center">
        {STEPS.map((label, i) => (
          <li key={label} className={`flex items-center ${i > 0 ? "flex-1" : ""}`}>
            {i > 0 && (
              <span className={`mx-1 h-0.5 flex-1 rounded ${i <= step ? "bg-primary" : "bg-line"}`} />
            )}
            <span className="flex flex-col items-center gap-1">
              <span
                className={`grid h-9 w-9 place-items-center rounded-full border-2 text-sm font-bold ${
                  i < step
                    ? "border-primary bg-primary text-white"
                    : i === step
                      ? "border-primary bg-primary text-white"
                      : "border-line bg-surface text-faint"
                }`}
              >
                {i < step ? <Icon name="check" size={16} /> : i + 1}
              </span>
              <span className={`whitespace-nowrap text-[11px] font-semibold ${i === step ? "text-primary" : "text-faint"}`}>
                {label}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <div className="flex gap-5">
        <div className="min-w-0 flex-1 space-y-5">
          {/* ---- step 1: guest ---- */}
          {step === 0 && (
            <>
              <section className="rounded-2xl border border-line bg-surface p-5">
                <SectionTitle icon="search" title="חיפוש אורח" />
                <div className="relative">
                  <input
                    className="field"
                    placeholder="חפש לפי שם, טלפון או אימייל…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {results.length > 0 && (
                    <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
                      {results.map((g) => (
                        <li key={g.id}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between px-4 py-2.5 text-sm hover:bg-hover"
                            onClick={() => {
                              setGuest({
                                id: g.id,
                                firstName: g.first_name ?? g.full_name.split(" ")[0] ?? "",
                                lastName: g.last_name ?? g.full_name.split(" ").slice(1).join(" "),
                                phone: g.phone ?? "",
                                email: g.email ?? "",
                                idNumber: g.id_number ?? "",
                                country: "ישראל",
                                language: "עברית",
                              });
                              setQuery("");
                              setResults([]);
                            }}
                          >
                            <span className="font-semibold text-ink">{g.full_name}</span>
                            <span className="text-xs text-muted" dir="ltr">
                              {g.phone ?? g.email ?? ""}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <p className="mt-2 text-xs text-faint">
                  מצא אורח קיים למילוי אוטומטי, או הזן את הפרטים ידנית למטה.
                </p>
              </section>

              <section className="rounded-2xl border border-line bg-surface p-5">
                <SectionTitle icon="filter" title="מקור הזמנה" />
                <select className="field" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  {bookingSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </section>

              <section className="rounded-2xl border border-line bg-surface p-5">
                <SectionTitle icon="user" title="פרטי אורח" />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="שם פרטי" required>
                    <input
                      className="field"
                      placeholder="שם פרטי"
                      value={guest.firstName}
                      onChange={(e) => setGuest({ ...guest, firstName: e.target.value, id: undefined })}
                    />
                  </Field>
                  <Field label="שם משפחה" required>
                    <input
                      className="field"
                      placeholder="שם משפחה"
                      value={guest.lastName}
                      onChange={(e) => setGuest({ ...guest, lastName: e.target.value, id: undefined })}
                    />
                  </Field>
                  <Field label="טלפון" required>
                    <input
                      className="field"
                      placeholder="050-0000000"
                      dir="ltr"
                      value={guest.phone}
                      onChange={(e) => setGuest({ ...guest, phone: e.target.value })}
                    />
                  </Field>
                  <Field label="אימייל">
                    <input
                      className="field"
                      placeholder="email@example.com"
                      dir="ltr"
                      type="email"
                      value={guest.email}
                      onChange={(e) => setGuest({ ...guest, email: e.target.value })}
                    />
                  </Field>
                  <Field label="ת.ז / דרכון">
                    <input
                      className="field"
                      placeholder="מספר מזהה"
                      dir="ltr"
                      value={guest.idNumber}
                      onChange={(e) => setGuest({ ...guest, idNumber: e.target.value })}
                    />
                  </Field>
                  <Field label="שפה">
                    <input
                      className="field"
                      value={guest.language}
                      onChange={(e) => setGuest({ ...guest, language: e.target.value })}
                    />
                  </Field>
                  <Field label="מדינה">
                    <input
                      className="field"
                      value={guest.country}
                      onChange={(e) => setGuest({ ...guest, country: e.target.value })}
                    />
                  </Field>
                </div>
              </section>
            </>
          )}

          {/* ---- step 2: stays & rooms ---- */}
          {step === 1 && (
            <section className="space-y-4">
              <SectionTitle icon="rooms" title="שהות וחדרים" />
              {stays.map((s, i) => (
                <StayEditor
                  key={s.key}
                  index={i}
                  value={s}
                  onChange={(next) => setStays((all) => all.map((x) => (x.key === s.key ? next : x)))}
                  onRemove={
                    stays.length > 1
                      ? () => setStays((all) => all.filter((x) => x.key !== s.key))
                      : undefined
                  }
                />
              ))}
              <button
                type="button"
                className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line text-sm font-semibold text-primary hover:border-primary hover:bg-primary-050"
                onClick={() =>
                  setStays((all) => [
                    ...all,
                    {
                      key: newStayKey(),
                      roomId: "",
                      checkIn: all[all.length - 1]?.checkIn ?? "",
                      checkOut: all[all.length - 1]?.checkOut ?? "",
                      adults: 2,
                      children: 0,
                      infants: 0,
                    },
                  ])
                }
              >
                <Icon name="plus" size={16} />
                הוסף חדר נוסף
              </button>
            </section>
          )}

          {/* ---- step 3: pricing & payment ---- */}
          {step === 2 && (
            <section className="space-y-4">
              <SectionTitle icon="finance" title="תמחור ותשלום" />
              <div className="rounded-2xl border border-line bg-surface p-5">
                {stays.map((s, i) => {
                  const nights = s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0;
                  const q = quotes[s.key];
                  const lineTotal = s.ratePerNight != null ? s.ratePerNight * nights : (q?.total ?? 0);
                  return (
                    <div key={s.key} className="flex items-center justify-between gap-3 border-b border-line py-3 first:pt-0 last:border-b-0">
                      <div>
                        <p className="text-sm font-bold text-ink">חדר {i + 1}</p>
                        <p className="text-xs text-muted">
                          {nights} לילות × ₪
                          <input
                            type="number"
                            min={0}
                            className="mx-1 w-24 rounded-lg border border-line px-2 py-1 text-center text-xs font-semibold"
                            value={s.ratePerNight ?? (nights ? Math.round((q?.total ?? 0) / nights) : 0)}
                            onChange={(e) =>
                              setStays((all) =>
                                all.map((x) =>
                                  x.key === s.key ? { ...x, ratePerNight: Number(e.target.value) || 0 } : x,
                                ),
                              )
                            }
                          />
                          / לילה
                        </p>
                      </div>
                      <span className="font-bold text-ink" dir="ltr">
                        ₪{lineTotal.toLocaleString()}
                      </span>
                    </div>
                  );
                })}
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="הנחה (₪)">
                    <input
                      type="number"
                      min={0}
                      className="field"
                      value={discount || ""}
                      placeholder="0"
                      onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </Field>
                  <div className="flex items-end justify-between rounded-xl bg-field px-4 py-3">
                    <span className="text-sm font-semibold text-text2">סה״כ לתשלום</span>
                    <span className="text-xl font-extrabold text-primary" dir="ltr">
                      ₪{total.toLocaleString()}
                    </span>
                  </div>
                  <Field label="סכום ששולם">
                    <input
                      type="number"
                      min={0}
                      className="field"
                      value={paid || ""}
                      placeholder="0"
                      onChange={(e) => setPaid(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </Field>
                  <Field label="אמצעי תשלום">
                    <select className="field" value={method} onChange={(e) => setMethod(e.target.value)}>
                      <option value="">בחירה…</option>
                      {paymentMethods.map((m) => (
                        <option key={m.id} value={m.key}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="mt-4 flex justify-end">
                  <PaymentBadge state={payState} />
                </div>
              </div>
            </section>
          )}

          {/* ---- step 4: summary ---- */}
          {step === 3 && (
            <section className="space-y-4">
              <SectionTitle icon="check" title="סיכום ואישור" />
              <div className="rounded-2xl border border-line bg-surface p-5">
                <div className="grid grid-cols-2 gap-4">
                  <SummaryItem label="אורח" value={guestDisplay} />
                  <SummaryItem label="מקור הזמנה" value={sourceLabel ?? "—"} />
                </div>
                <div className="mt-4 space-y-2">
                  {stays.map((s, i) => {
                    const nights = s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0;
                    const q = quotes[s.key];
                    const lineTotal = s.ratePerNight != null ? s.ratePerNight * nights : (q?.total ?? 0);
                    return (
                      <div key={s.key} className="flex items-center justify-between rounded-xl bg-field px-4 py-3 text-sm">
                        <span className="font-semibold text-ink">
                          חדר {i + 1} · {formatFullDate(s.checkIn)} – {formatFullDate(s.checkOut)} · {nights} לילות ·{" "}
                          {s.adults + s.children + s.infants} אורחים
                        </span>
                        <span className="font-bold text-primary" dir="ltr">
                          ₪{lineTotal.toLocaleString()}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <label className="mt-4 block">
                  <span className="mb-1.5 block text-sm font-semibold text-text2">הערות להזמנה</span>
                  <textarea
                    className="field min-h-24"
                    placeholder="בקשות מיוחדות, שעת הגעה…"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </label>
                <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
                  <span className="text-sm font-bold text-ink">סה״כ לתשלום</span>
                  <span className="text-2xl font-extrabold text-primary" dir="ltr">
                    ₪{total.toLocaleString()}
                  </span>
                </div>
              </div>
            </section>
          )}
        </div>

        {/* ---- summary aside (ref: סיכום הזמנה) ---- */}
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-0 rounded-2xl border border-line bg-surface p-4">
            <p className="mb-3 flex items-center gap-2 border-b border-line pb-3 text-sm font-bold text-ink">
              <Icon name="reservations" size={16} className="text-primary" />
              סיכום הזמנה
            </p>
            <div className="mb-3 flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-sm font-bold text-white">
                {(guest.firstName || "א").slice(0, 1)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-ink">{guestDisplay}</p>
                <p className="truncate text-xs text-muted">מקור: {sourceLabel ?? "—"}</p>
              </div>
            </div>
            {stays
              .filter((s) => s.checkIn && s.checkOut && s.checkOut > s.checkIn)
              .map((s, i) => (
                <div key={s.key} className="mb-2 rounded-xl bg-field px-3 py-2.5 text-xs">
                  <p className="font-bold text-ink">חדר {i + 1}</p>
                  <p className="text-muted" dir="ltr">
                    {formatFullDate(s.checkIn)} – {formatFullDate(s.checkOut)}
                  </p>
                  <p className="text-muted">
                    {nightsBetween(s.checkIn, s.checkOut)} לילות · {s.adults + s.children + s.infants} אורחים
                  </p>
                </div>
              ))}
            <div className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
              <p className="flex justify-between text-muted">
                <span>לילות סה״כ</span>
                <span>
                  {stays.reduce(
                    (n, s) => n + (s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0),
                    0,
                  )}
                </span>
              </p>
              <p className="flex justify-between text-muted">
                <span>אורחים</span>
                <span>{stays.reduce((n, s) => n + s.adults + s.children + s.infants, 0)}</span>
              </p>
              <p className="flex justify-between pt-1 text-base font-extrabold text-ink">
                <span>סה״כ</span>
                <span dir="ltr">₪{total.toLocaleString()}</span>
              </p>
            </div>
            <div className="mt-3 border-t border-line pt-3">
              <p className="mb-1.5 text-xs text-muted">סטטוס תשלום</p>
              <PaymentBadge state={payState} />
            </div>
          </div>
        </aside>
      </div>
    </SidePanel>
  );
}

function SectionTitle({ icon, title }: { icon: Parameters<typeof Icon>[0]["name"]; title: string }) {
  return (
    <p className="mb-4 flex items-center gap-2.5 text-base font-bold text-ink">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-050 text-primary">
        <Icon name={icon} size={17} />
      </span>
      {title}
    </p>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-1 text-sm font-semibold text-text2">{label}</p>
      <p className="field flex items-center font-semibold">{value}</p>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold text-text2">
        {label} {required && <span className="text-status-danger">*</span>}
      </span>
      {children}
    </label>
  );
}

export function PaymentBadge({ state }: { state: "unpaid" | "partial" | "paid" }) {
  const map = {
    unpaid: { label: "לא שולם", bg: "#FDECEC", bd: "#F4B9B9", tx: "#B4231F" },
    partial: { label: "שולם חלקית", bg: "#E4F6EE", bd: "#A6E2CC", tx: "#0B7355" },
    paid: { label: "שולם מלא", bg: "#E7F6EC", bd: "#AADDB7", tx: "#15803D" },
  }[state];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold"
      style={{ background: map.bg, borderColor: map.bd, color: map.tx }}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: map.tx }} />
      {map.label}
    </span>
  );
}
