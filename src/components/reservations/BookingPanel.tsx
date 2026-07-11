"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { SidePanel } from "@/components/ui/SidePanel";
import { Icon } from "@/components/shared/Icon";
import { formatFullDate, nightsBetween } from "@/lib/dates";
import { paymentState, type PaymentState } from "@/lib/inventory-rules";
import { formatVatRate, includedVatAmount } from "@/lib/vat";
import { normalizePan, parseExpiry } from "@/lib/card-rules";
import { statusTintPalette } from "@/lib/colors";
import {
  createReservationAction,
  searchGuestsAction,
  getStayQuoteAction,
} from "@/app/(dashboard)/reservations/actions";
import { saveReservationCardAction } from "@/app/(dashboard)/reservations/card-actions";
import { StayEditor, newStayKey, type StayDraft } from "./StayEditor";
import { CardFields, EMPTY_CARD, cardDraftState, type CardDraft } from "./CardFields";
import type { LookupItem } from "@/app/(dashboard)/calendar/CalendarScreen";

// The canonical new-reservation flow (הקמת הזמנה חדשה) — the reference
// 4-step wizard (ref/html/booking-window.html, new-booking-step-*.png)
// inside the site-wide SIDE PANEL shell (D41): the calendar stays mounted
// and visible behind it. The calendar opens THIS flow; there is no
// calendar-only editor (§G). The VAT line is the TENANT setting
// (Settings → שיעור מע״מ), display-only over the VAT-inclusive total.

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

// dirty-state fingerprint of everything the user can edit (stay "key"
// fields are random per open, so the replacer drops them)
function formSnapshot(
  guest: GuestForm,
  sourceId: string,
  stays: StayDraft[],
  discount: number,
  paid: number,
  method: string,
  notes: string,
  arrivalTime: string,
  asDraft: boolean,
  cc: CardDraft,
): string {
  return JSON.stringify(
    [guest, sourceId, stays, discount, paid, method, notes, arrivalTime, asDraft, cc],
    (k, v) => (k === "key" ? undefined : v),
  );
}

export function BookingPanel({
  open,
  onClose,
  prefill,
  bookingSources,
  paymentMethods,
  workflowStatuses = [],
  ratePlans,
  vatRate,
  canSaveCard,
  canPriceOverride,
}: {
  open: boolean;
  onClose: () => void;
  prefill: BookingPrefill;
  bookingSources: LookupItem[];
  paymentMethods: LookupItem[];
  /** tenant workflow statuses (D77 §11) — optional explicit pick on create */
  workflowStatuses?: LookupItem[];
  ratePlans: { id: string; name: string; code: string }[];
  vatRate: number;
  canSaveCard: boolean;
  canPriceOverride: boolean;
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
  // שעת הגעה משוערת — dedicated field (D80), never folded into notes
  const [arrivalTime, setArrivalTime] = useState("");
  // "ממתין לאישור" chip → the reservation is created as a DRAFT (a status
  // the create action already supports); everything else creates confirmed
  const [asDraft, setAsDraft] = useState(false);
  // card values are sent ONLY to the dedicated guarded save action after
  // the reservation is created, then cleared (see CardFields security note)
  const [cc, setCc] = useState<CardDraft>(EMPTY_CARD);
  // workflow status (D77 §11) — "" = tenant default, applied server-side
  const [workflowStatusId, setWorkflowStatusId] = useState("");
  const paidRef = useRef<HTMLInputElement | null>(null);
  const [saving, startSaving] = useTransition();
  // dirty-state protection: snapshot of the form right after open
  const snapshotRef = useRef("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // guest search
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { id: string; full_name: string; first_name: string | null; last_name: string | null; phone: string | null; email: string | null; id_number: string | null }[]
  >([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    const initialSource = bookingSources[0]?.id ?? "";
    const initialStays: StayDraft[] = [
      {
        key: newStayKey(),
        roomId: prefill.roomId ?? "",
        checkIn: prefill.checkIn ?? "",
        checkOut: prefill.checkOut ?? "",
        adults: 2,
        children: 0,
        infants: 0,
      },
    ];
    setStep(0);
    setGuest(EMPTY_GUEST);
    setSourceId(initialSource);
    setStays(initialStays);
    setQuotes({});
    setDiscount(0);
    setPaid(0);
    setMethod("");
    setNotes("");
    setAsDraft(false);
    setCc(EMPTY_CARD);
    setWorkflowStatusId("");
    setQuery("");
    setResults([]);
    setConfirmDiscard(false);
    snapshotRef.current = formSnapshot(EMPTY_GUEST, initialSource, initialStays, 0, 0, "", "", "", false, EMPTY_CARD);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirty =
    formSnapshot(guest, sourceId, stays, discount, paid, method, notes, arrivalTime, asDraft, cc) !==
    snapshotRef.current;

  // Escape / X / overlay click route here — unsaved changes get an explicit
  // discard confirmation (footer strip) instead of a silent reset
  const requestClose = () => {
    if (saving) return;
    if (dirty && !confirmDiscard) setConfirmDiscard(true);
    else onClose();
  };

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

  // live quotes for the sidebar + pricing/summary steps — the SAME central
  // engine the save path commits (occupancy + Rate Plan included)
  useEffect(() => {
    for (const s of stays) {
      if (!s.roomId || !s.checkIn || !s.checkOut || s.checkOut <= s.checkIn) continue;
      getStayQuoteAction({
        roomId: s.roomId, checkIn: s.checkIn, checkOut: s.checkOut,
        adults: s.adults, children: s.children, infants: s.infants,
        ratePlanId: s.ratePlanId ?? null,
      }).then((res) => {
        if (res.success && res.data) {
          setQuotes((q) => ({ ...q, [s.key]: { total: res.data!.total, restriction: res.data!.restriction } }));
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, stays.map((s) => `${s.key}|${s.roomId}|${s.checkIn}|${s.checkOut}|${s.adults}|${s.children}|${s.infants}|${s.ratePlanId ?? ""}`).join(",")]);

  const staysValid =
    stays.length > 0 &&
    stays.every((s) => s.roomId && s.checkIn && s.checkOut && s.checkOut > s.checkIn);
  const roomsTotal = stays.reduce((sum, s) => {
    const q = quotes[s.key];
    const nights = s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0;
    return sum + (s.isManualRate && s.ratePerNight != null ? s.ratePerNight * nights : (q?.total ?? 0));
  }, 0);
  const total = Math.max(0, roomsTotal - discount);
  const payState = paymentState(total, paid);

  const stepValid = useMemo(() => {
    if (step === 0) return guest.firstName.trim() !== "" && guest.lastName.trim() !== "" && guest.phone.trim() !== "";
    if (step === 1) return staysValid;
    return true;
  }, [step, guest, staysValid]);

  // a partially-typed invalid card blocks creation; an empty one is skipped.
  // Manual card entry is available on ANY booking, independent of the chosen
  // payment method or source (D46) — not gated on method === "credit_card".
  const ccState = canSaveCard ? cardDraftState(cc) : "empty";

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
        status: asDraft ? "draft" : "confirmed",
        rooms: stays.map((s) => ({
          roomId: s.roomId,
          checkIn: s.checkIn,
          checkOut: s.checkOut,
          adults: s.adults,
          children: s.children,
          infants: s.infants,
          // an explicit operator-set nightly price is an authorized override
          // (§13); otherwise the server prices through the central engine
          ratePerNight: s.isManualRate ? s.ratePerNight : undefined,
          isManualRate: s.isManualRate || undefined,
          ratePlanId: s.ratePlanId ?? null,
          guestFirstName: s.guestFirstName || undefined,
          guestLastName: s.guestLastName || undefined,
          guestPhone: s.guestPhone || undefined,
        })),
        notes: notes.trim() || undefined,
        expectedArrivalTime: arrivalTime || null,
        discountAmount: discount || undefined,
        paidAmount: paid || undefined,
        paymentMethod: method || undefined,
        workflowStatusId: workflowStatusId || undefined,
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      // store the card through the dedicated guarded action AFTER the
      // reservation exists; card values are cleared from client state
      // either way and never included in the create payload (D41)
      if (ccState === "valid" && res.data) {
        const exp = parseExpiry(cc.exp)!;
        const saved = await saveReservationCardAction({
          reservationId: res.data.reservationId,
          holderName: cc.holder.trim(),
          holderIdNumber: cc.idNum || undefined,
          pan: normalizePan(cc.number),
          expMonth: exp.month,
          expYear: exp.year,
          source: cc.source,
          billingNotes: cc.billingNotes.trim() || undefined,
        });
        if (!saved.success) toast.error(`ההזמנה נוצרה, אך שמירת הכרטיס נכשלה: ${saved.error}`);
      }
      setCc(EMPTY_CARD);
      toast.success(`הזמנה #${res.data?.reservationNumber} נוצרה בהצלחה`);
      onClose();
    });

  const guestDisplay = `${guest.firstName} ${guest.lastName}`.trim() || "אורח חדש";
  const sourceLabel = bookingSources.find((s) => s.id === sourceId)?.label;
  const totalNights = stays.reduce(
    (n, s) => n + (s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0),
    0,
  );
  const totalGuests = stays.reduce((n, s) => n + s.adults + s.children + s.infants, 0);

  return (
    <SidePanel
      open={open}
      onClose={requestClose}
      title="הקמת הזמנה חדשה"
      subtitle="אורח · שהות · תמחור · אישור"
      icon="reservations"
      bodyClassName="bg-[#eef0f5] p-0"
      band={
        /* stepper band (reference .stp) — RTL: step 1 rightmost */
        <div className="bw-stp">
          <div className="bw-stp-row">
            <span className="bw-stp-line" />
            <span className="bw-stp-fill" style={{ width: `${(step / (STEPS.length - 1)) * 75}%` }} />
            {STEPS.map((label, i) => (
              <button
                key={label}
                type="button"
                className={`bw-stp-item ${i === step ? "active" : ""} ${i < step ? "done" : ""}`}
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
              >
                <span className="bw-stp-num">
                  {i < step ? <Icon name="check" size={18} /> : i + 1}
                </span>
                <span className="bw-stp-lbl">{label}</span>
              </button>
            ))}
          </div>
        </div>
      }
      footer={
        confirmDiscard ? (
          /* dirty-state discard confirmation (existing inline-confirm pattern) */
          <div className="flex items-center gap-3">
            <Icon name="warning" size={17} className="text-status-danger" />
            <span className="text-sm font-bold text-ink">יש שינויים שלא נשמרו — לסגור בכל זאת?</span>
            <span className="flex-1" />
            <button type="button" className="bw-btn bw-btn-o" onClick={() => setConfirmDiscard(false)}>
              המשך עריכה
            </button>
            <button type="button" className="bw-btn bw-btn-danger" onClick={onClose}>
              סגור בלי לשמור
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button type="button" className="bw-btn bw-btn-ghost" onClick={requestClose}>
              ביטול
            </button>
            <span className="flex-1" />
            <span className="bw-ft-step">
              <Icon name="info" size={15} />
              שלב {step + 1} מתוך {STEPS.length}
            </span>
            {step > 0 && (
              <button type="button" className="bw-btn bw-btn-o" onClick={() => setStep((s) => s - 1)}>
                הקודם
                <Icon name="chevron-right" size={16} />
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                className="bw-btn bw-btn-primary"
                disabled={!stepValid}
                onClick={() => setStep((s) => s + 1)}
              >
                <Icon name="chevron-left" size={16} />
                הבא
              </button>
            ) : (
              <button
                type="button"
                className="bw-btn bw-btn-primary"
                disabled={saving || !staysValid || ccState === "invalid"}
                title={ccState === "invalid" ? "פרטי הכרטיס שהוזנו אינם תקינים" : undefined}
                onClick={submit}
              >
                <Icon name="check" size={16} />
                {saving ? "יוצר…" : "צור הזמנה"}
              </button>
            )}
          </div>
        )
      }
    >
      <div className="bw-main">
        <div className="bw-col-main">
          {/* ---- step 1: guest ---- */}
          {step === 0 && (
            <>
              <section className="bw-card">
                <CardTitle icon="search" title="חיפוש אורח" />
                <div className="relative">
                  <Icon
                    name="search"
                    size={18}
                    className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-faint"
                  />
                  <input
                    className="bw-fld bw-search ps-11"
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
                <p className="bw-hint">מצא אורח קיים למילוי אוטומטי, או הזן את הפרטים ידנית למטה.</p>
              </section>

              <section className="bw-card">
                <CardTitle icon="filter" title="מקור הזמנה" />
                <div className="bw-fg">
                  <span className="bw-lbl">
                    מקור הזמנה <span className="bw-req">*</span>
                  </span>
                  <select className="bw-fld" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                    {bookingSources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </section>

              <section className="bw-card">
                <CardTitle icon="user" title="פרטי אורח" />
                <div className="bw-grid2">
                  <Field label="שם פרטי" required>
                    <input
                      className="bw-fld"
                      placeholder="שם פרטי"
                      value={guest.firstName}
                      onChange={(e) => setGuest({ ...guest, firstName: e.target.value, id: undefined })}
                    />
                  </Field>
                  <Field label="שם משפחה" required>
                    <input
                      className="bw-fld"
                      placeholder="שם משפחה"
                      value={guest.lastName}
                      onChange={(e) => setGuest({ ...guest, lastName: e.target.value, id: undefined })}
                    />
                  </Field>
                  <Field label="טלפון" required>
                    <input
                      className="bw-fld"
                      placeholder="050-0000000"
                      dir="ltr"
                      value={guest.phone}
                      onChange={(e) => setGuest({ ...guest, phone: e.target.value })}
                    />
                  </Field>
                  <Field label="אימייל">
                    <input
                      className="bw-fld"
                      placeholder="email@example.com"
                      dir="ltr"
                      type="email"
                      value={guest.email}
                      onChange={(e) => setGuest({ ...guest, email: e.target.value })}
                    />
                  </Field>
                  <Field label="ת.ז / דרכון">
                    <input
                      className="bw-fld"
                      placeholder="מספר מזהה"
                      dir="ltr"
                      value={guest.idNumber}
                      onChange={(e) => setGuest({ ...guest, idNumber: e.target.value })}
                    />
                  </Field>
                  <Field label="שפה">
                    <select
                      className="bw-fld"
                      value={guest.language}
                      onChange={(e) => setGuest({ ...guest, language: e.target.value })}
                    >
                      <option>עברית</option>
                      <option>English</option>
                      <option>Русский</option>
                      <option>العربية</option>
                      <option>Français</option>
                    </select>
                  </Field>
                  <Field label="מדינה">
                    <input
                      className="bw-fld"
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
            <section className="bw-card">
              <CardTitle icon="rooms" title="שהות וחדרים" />
              <div className="flex flex-col gap-4">
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
                  className="bw-addroom"
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
              </div>
            </section>
          )}

          {/* ---- step 3: pricing & payment (reference
               new-booking-step-3 + booking-window.html) ---- */}
          {step === 2 && (
            <>
              <section className="bw-card">
                <CardTitle icon="documents" title="פירוט תמחור" />
                {stays.map((s, i) => {
                  const nights = s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0;
                  const q = quotes[s.key];
                  const autoRate = nights ? Math.round((q?.total ?? 0) / nights) : 0;
                  const lineTotal =
                    s.isManualRate && s.ratePerNight != null ? s.ratePerNight * nights : (q?.total ?? 0);
                  return (
                    <div key={s.key} className="bw-price-line">
                      <div>
                        <b>חדר {i + 1}</b>
                        <div className="bw-plr">
                          {ratePlans.length > 0 && (
                            <select
                              className="ml-2 rounded-lg border border-line px-2 py-1 text-xs font-semibold"
                              aria-label="תוכנית תעריף"
                              value={s.ratePlanId ?? ""}
                              onChange={(e) =>
                                setStays((all) =>
                                  all.map((x) =>
                                    x.key === s.key
                                      ? { ...x, ratePlanId: e.target.value || null, isManualRate: false, ratePerNight: undefined }
                                      : x,
                                  ),
                                )
                              }
                            >
                              <option value="">מחיר בסיס</option>
                              {ratePlans.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </select>
                          )}
                          {nights} לילות × ₪
                          {canPriceOverride ? (
                            /* explicit operator edit = authorized manual override (§13) */
                            <input
                              type="number"
                              min={0}
                              className="mx-1 w-24 rounded-lg border border-line px-2 py-1 text-center text-xs font-semibold"
                              value={s.isManualRate ? (s.ratePerNight ?? 0) : autoRate}
                              onChange={(e) =>
                                setStays((all) =>
                                  all.map((x) =>
                                    x.key === s.key
                                      ? { ...x, ratePerNight: Number(e.target.value) || 0, isManualRate: true }
                                      : x,
                                  ),
                                )
                              }
                            />
                          ) : (
                            <b className="mx-1">{(s.isManualRate ? (s.ratePerNight ?? 0) : autoRate).toLocaleString()}</b>
                          )}
                          / לילה
                          {s.isManualRate && (
                            <button
                              type="button"
                              className="mr-2 text-xs font-semibold text-brand underline"
                              onClick={() =>
                                setStays((all) =>
                                  all.map((x) =>
                                    x.key === s.key ? { ...x, isManualRate: false, ratePerNight: undefined } : x,
                                  ),
                                )
                              }
                            >
                              חזרה למחיר אוטומטי
                            </button>
                          )}
                        </div>
                      </div>
                      <b dir="ltr">₪{lineTotal.toLocaleString()}</b>
                    </div>
                  );
                })}
                {discount > 0 && (
                  <div className="bw-price-line">
                    <span className="bw-plr">הנחה</span>
                    <b dir="ltr" style={{ color: "#B4231F" }}>
                      -₪{discount.toLocaleString()}
                    </b>
                  </div>
                )}
                {/* informational only — the TENANT VAT rate (Settings), already included in the total */}
                <div className="bw-price-line">
                  <span className="bw-plr" style={{ fontSize: 14 }}>
                    מע״מ ({formatVatRate(vatRate)}%) — כלול
                  </span>
                  <b dir="ltr" style={{ color: "#6B7385" }}>
                    ₪{includedVatAmount(total, vatRate).toLocaleString()}
                  </b>
                </div>
                <div className="bw-price-total">
                  <span>סה״כ לתשלום</span>
                  <span className="bw-amt" dir="ltr">
                    ₪{total.toLocaleString()}
                  </span>
                </div>
              </section>

              <section className="bw-card">
                <CardTitle icon="finance" title="סטטוס תשלום" />
                {/* the chips drive REAL fields only: paid amount / draft
                    status — the shown state is always the derived one */}
                <div className="bw-chips-row">
                  <PayChip
                    kind="pc-unpaid"
                    label="לא שולם"
                    on={!asDraft && payState === "unpaid"}
                    onClick={() => {
                      setAsDraft(false);
                      setPaid(0);
                    }}
                  />
                  <PayChip
                    kind="pc-partial"
                    label="שולם חלקית"
                    on={!asDraft && payState === "partial"}
                    onClick={() => {
                      setAsDraft(false);
                      paidRef.current?.focus();
                    }}
                  />
                  <PayChip
                    kind="pc-paid"
                    label="שולם מלא"
                    on={!asDraft && payState === "paid"}
                    onClick={() => {
                      setAsDraft(false);
                      setPaid(Math.round(total));
                    }}
                  />
                  <PayChip
                    kind="pc-pending"
                    label="ממתין לאישור"
                    on={asDraft}
                    onClick={() => setAsDraft(true)}
                  />
                </div>
                <div className="bw-grid3 mt-5">
                  <Field label="אמצעי תשלום">
                    <select
                      className="bw-fld"
                      value={method}
                      onChange={(e) => {
                        setMethod(e.target.value);
                        // §15 — leaving credit-card destroys any unsaved card draft
                        if (e.target.value !== "credit_card") setCc(EMPTY_CARD);
                      }}
                    >
                      <option value="">בחירה…</option>
                      {paymentMethods.map((m) => (
                        <option key={m.id} value={m.key}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="סכום ששולם">
                    <input
                      ref={paidRef}
                      type="number"
                      min={0}
                      className="bw-fld"
                      value={paid || ""}
                      placeholder="0"
                      onChange={(e) => setPaid(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </Field>
                  <Field label="הנחה (₪)">
                    <input
                      type="number"
                      min={0}
                      className="bw-fld"
                      value={discount || ""}
                      placeholder="0"
                      onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </Field>
                </div>
                {/* manual card entry (D77 §15) — the area is always visible but
                    activates (white/enabled/focusable) ONLY when the selected
                    payment method is credit card; otherwise grey + disabled */}
                {canSaveCard ? (
                  <CardFields
                    value={cc}
                    onChange={setCc}
                    chargeAmount={Math.max(0, total - paid)}
                    disabled={method !== "credit_card"}
                  />
                ) : (
                  <p className="bw-hint mt-4">אין הרשאה לשמירת פרטי כרטיס אשראי</p>
                )}
              </section>
            </>
          )}

          {/* ---- step 4: summary ---- */}
          {step === 3 && (
            <section className="bw-card">
              <CardTitle icon="check" title="סיכום ואישור" />
              <div className="bw-grid2">
                <Field label="אורח">
                  <div className="bw-fld flex items-center font-bold">{guestDisplay}</div>
                </Field>
                <Field label="מקור הזמנה">
                  <div className="bw-fld flex items-center font-bold">{sourceLabel ?? "—"}</div>
                </Field>
                {workflowStatuses.length > 0 && (
                  <Field label="סטטוס הזמנה">
                    {/* "" = the tenant's default status, applied server-side (§11).
                        A chosen status tints the select with its configured color
                        family (D77.1) — same language as the calendar pill. */}
                    <select
                      className="bw-fld"
                      style={(() => {
                        if (!workflowStatusId) return undefined;
                        const t = statusTintPalette(
                          workflowStatuses.find((w) => w.id === workflowStatusId)?.color,
                        );
                        return { background: t.bg, borderColor: t.bd, color: t.tx, fontWeight: 700 };
                      })()}
                      value={workflowStatusId}
                      onChange={(e) => setWorkflowStatusId(e.target.value)}
                    >
                      <option value="">ברירת מחדל</option>
                      {workflowStatuses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
              <div className="mt-4 flex flex-col gap-2.5">
                {stays.map((s, i) => {
                  const nights = s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0;
                  const q = quotes[s.key];
                  const lineTotal = s.isManualRate && s.ratePerNight != null ? s.ratePerNight * nights : (q?.total ?? 0);
                  return (
                    <div key={s.key} className="bw-price-line" style={{ borderBottom: "none", padding: "11px 13px", background: "#F8F9FC", borderRadius: 11 }}>
                      <div>
                        <b>חדר {i + 1}</b>
                        <div className="bw-plr">
                          {formatFullDate(s.checkIn)} – {formatFullDate(s.checkOut)} · {nights} לילות ·{" "}
                          {s.adults + s.children + s.infants} אורחים
                        </div>
                      </div>
                      <b dir="ltr" style={{ color: "var(--color-primary)" }}>
                        ₪{lineTotal.toLocaleString()}
                      </b>
                    </div>
                  );
                })}
              </div>
              <div className="bw-fg mt-4">
                <span className="bw-lbl">שעת הגעה משוערת</span>
                <input
                  type="time"
                  className="bw-fld"
                  dir="ltr"
                  value={arrivalTime}
                  onChange={(e) => setArrivalTime(e.target.value)}
                />
              </div>
              <div className="bw-fg full mt-4">
                <span className="bw-lbl">הערות להזמנה</span>
                <textarea
                  className="bw-fld"
                  placeholder="בקשות מיוחדות…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              <div className="bw-price-total mt-2">
                <span>סה״כ לתשלום</span>
                <span className="bw-amt" dir="ltr">
                  ₪{total.toLocaleString()}
                </span>
              </div>
            </section>
          )}
        </div>

        {/* ---- summary sidebar (reference .sum) ---- */}
        <aside className="bw-col-side max-lg:hidden">
          <div className="bw-sum">
            <div className="bw-sum-h">
              <Icon name="reservations" size={18} className="text-primary" />
              סיכום הזמנה
            </div>
            <div className="bw-sum-b">
              <div className="bw-sum-guest">
                <span className="bw-sum-ava">{(guest.firstName || "א").slice(0, 1)}</span>
                <div className="min-w-0">
                  <p className="bw-sum-gname truncate">{guestDisplay}</p>
                  <p className="bw-sum-gsrc truncate">מקור: {sourceLabel ?? "—"}</p>
                </div>
              </div>
              {stays.filter((s) => s.checkIn && s.checkOut && s.checkOut > s.checkIn).length > 0 && (
                <div className="bw-sum-sec">
                  {stays
                    .filter((s) => s.checkIn && s.checkOut && s.checkOut > s.checkIn)
                    .map((s, i) => {
                      const nights = nightsBetween(s.checkIn, s.checkOut);
                      const q = quotes[s.key];
                      const lineTotal = s.isManualRate && s.ratePerNight != null ? s.ratePerNight * nights : (q?.total ?? null);
                      return (
                        <div key={s.key} className="bw-sum-room">
                          <div className="bw-sum-rt">
                            <span>חדר {i + 1}</span>
                            {lineTotal != null && (
                              <span className="bw-p" dir="ltr">
                                ₪{lineTotal.toLocaleString()}
                              </span>
                            )}
                          </div>
                          <div className="bw-sum-rd">
                            <Icon name="calendar" size={14} />
                            <span dir="ltr">
                              {formatFullDate(s.checkIn)} – {formatFullDate(s.checkOut)}
                            </span>
                            <Icon name="moon" size={14} />
                            <span>{nights} ל׳</span>
                            <Icon name="users-round" size={14} />
                            <span>{s.adults + s.children + s.infants} אורחים</span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
              <div className="bw-sum-sec">
                <div className="bw-sum-line">
                  <span>לילות סה״כ</span>
                  <span>{totalNights}</span>
                </div>
                <div className="bw-sum-line">
                  <span>אורחים</span>
                  <span>{totalGuests}</span>
                </div>
              </div>
              <div className="bw-sum-total">
                <span className="bw-l">סה״כ</span>
                <span className="bw-v" dir="ltr">
                  ₪{total.toLocaleString()}
                </span>
              </div>
              <div className="bw-sum-pay">
                <span>סטטוס תשלום</span>
                <PaymentBadge state={payState} />
              </div>
            </div>
          </div>
        </aside>
      </div>
    </SidePanel>
  );
}

export function CardTitle({ icon, title }: { icon: Parameters<typeof Icon>[0]["name"]; title: string }) {
  return (
    <div className="bw-card-h">
      <span className="bw-hi">
        <Icon name={icon} size={17} />
      </span>
      {title}
    </div>
  );
}

export function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="bw-fg">
      <span className="bw-lbl">
        {label} {required && <span className="bw-req">*</span>}
      </span>
      {children}
    </label>
  );
}

// Selectable payment-status chip (reference .paychip, step 3).
function PayChip({
  kind,
  label,
  on,
  onClick,
}: {
  kind: "pc-unpaid" | "pc-partial" | "pc-paid" | "pc-pending";
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`bw-paychip ${kind} ${on ? "on" : ""}`}
      aria-pressed={on}
      onClick={onClick}
    >
      <span className="bw-d" />
      {label}
    </button>
  );
}

// Payment badge — reference edit-modal chip palette (unpaid red / partial
// orange / paid green / overpaid teal = fully paid + customer credit, D52 §7).
export function PaymentBadge({ state }: { state: PaymentState }) {
  const map = {
    unpaid: { label: "לא שולם", bg: "#FDECEC", bd: "#F4B9B9", tx: "#B4231F", dot: "#DC2626" },
    partial: { label: "שולם חלקית", bg: "#FDF2E1", bd: "#EBC078", tx: "#B4670A", dot: "#EA9314" },
    paid: { label: "שולם מלא", bg: "#E7F6EC", bd: "#AADDB7", tx: "#15803D", dot: "#16A34A" },
    overpaid: { label: "שולם ביתר", bg: "#DCF1F4", bd: "#8FD3DC", tx: "#0B6E7A", dot: "#0E8A99" },
  }[state];
  return (
    <span className="bw-badge" style={{ background: map.bg, borderColor: map.bd, color: map.tx }}>
      <span className="bw-d" style={{ background: map.dot }} />
      {map.label}
    </span>
  );
}
