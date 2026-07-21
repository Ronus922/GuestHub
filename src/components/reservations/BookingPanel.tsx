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
import { paymentTriplet } from "@/lib/status-colors";
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
  onCreated,
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
  /** called with the new reservation_id on success (calendar pulses its bar) */
  onCreated?: (reservationId: string) => void;
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
  // validation feedback: set true when a blocked "הבא"/"צור הזמנה" click reds the
  // missing fields; cleared on every step change so a fresh step starts clean.
  const [showErrors, setShowErrors] = useState(false);
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

  // per-field red flags for step 0 (only while errors are shown for this step)
  const guestErr = {
    firstName: showErrors && step === 0 && guest.firstName.trim() === "",
    lastName: showErrors && step === 0 && guest.lastName.trim() === "",
    phone: showErrors && step === 0 && guest.phone.trim() === "",
  };

  // move to `to` cleanly — navigation always leaves the error state behind
  const goStep = (to: number) => {
    setShowErrors(false);
    setStep(to);
  };
  // "הבא": advance only when the step is valid; otherwise red the fields + stay
  const handleNext = () => {
    if (!stepValid) {
      setShowErrors(true);
      return;
    }
    goStep(step + 1);
  };

  // a partially-typed invalid card blocks creation; an empty one is skipped.
  // Manual card entry is available on ANY booking, independent of the chosen
  // payment method or source (D46) — not gated on method === "credit_card".
  const ccState = canSaveCard ? cardDraftState(cc) : "empty";

  // "צור הזמנה" is never a silent dead-click: jump to the first incomplete step,
  // red its fields, and say what's missing — only a fully valid form submits.
  const handleCreate = () => {
    if (guest.firstName.trim() === "" || guest.lastName.trim() === "" || guest.phone.trim() === "") {
      setStep(0);
      setShowErrors(true);
      toast.error("יש להשלים את פרטי האורח המסומנים באדום");
      return;
    }
    if (!staysValid) {
      setStep(1);
      setShowErrors(true);
      toast.error("יש להשלים את פרטי השהות והחדרים המסומנים באדום");
      return;
    }
    if (ccState === "invalid") {
      setShowErrors(true);
      toast.error("פרטי הכרטיס אינם תקינים — השלימו אותם או נקו את השדות");
      return;
    }
    submit();
  };

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
      if (res.data) onCreated?.(res.data.reservationId);
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
      bodyClassName="bg-appbg p-0"
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
                onClick={() => i < step && goStep(i)}
                disabled={i > step}
              >
                <span className="bw-stp-num">
                  {i < step ? <Icon name="check" size={20} /> : i + 1}
                </span>
                <span className="bw-stp-lbl">{label}</span>
              </button>
            ))}
          </div>
        </div>
      }
      footer={
        confirmDiscard ? (
          /* dirty-state discard confirmation. §7 via .dw-ft (row-reverse):
             DOM order = visual left→right — the confirming action is FIRST
             so it hugs the LEFT edge; the warning text sits at the far right. */
          <>
            <button type="button" className="btn btn-danger" onClick={onClose}>
              סגור בלי לשמור
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmDiscard(false)}>
              המשך עריכה
            </button>
            <span className="flex-1" />
            <span className="text-sm font-bold text-ink">יש שינויים שלא נשמרו — לסגור בכל זאת?</span>
            <Icon name="warning" size={17} className="text-status-danger" />
          </>
        ) : (
          /* §7 via .dw-ft (row-reverse): DOM order = visual left→right — the
             PRIMARY action is FIRST so it hugs the LEFT edge, "ביטול" to its
             right; the step label is pushed to the far right. */
          <>
            {step < 3 ? (
              <button type="button" className="btn btn-primary" onClick={handleNext}>
                <Icon name="chevron-left" size={20} />
                הבא
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving}
                onClick={handleCreate}
              >
                <Icon name="check" size={20} />
                {saving ? "יוצר…" : "צור הזמנה"}
              </button>
            )}
            {step > 0 && (
              <button type="button" className="btn btn-secondary" onClick={() => goStep(step - 1)}>
                הקודם
                <Icon name="chevron-right" size={20} />
              </button>
            )}
            <button type="button" className="btn btn-tertiary" onClick={requestClose}>
              ביטול
            </button>
            <span className="flex-1" />
            <span className="bw-ft-step">
              <Icon name="info" size={17} />
              שלב {step + 1} מתוך {STEPS.length}
            </span>
          </>
        )
      }
    >
      <div className="bw-main">
        <div className="bw-col-main">
          {/* validation banner — shown when a blocked "הבא" reds the step's
              missing required fields (steps 0/1 have required fields) */}
          {showErrors && !stepValid && (
            <p
              role="alert"
              className="mb-4 flex items-center gap-2 rounded-xl bg-status-danger-050 px-4 py-2.5 text-sm font-bold text-status-danger"
            >
              <Icon name="warning" size={17} />
              יש למלא את כל שדות החובה המסומנים באדום כדי להמשיך.
            </p>
          )}
          {/* ---- step 1: guest ---- */}
          {step === 0 && (
            <>
              <BookingCard icon="search" title="חיפוש אורח">
                <div className="relative">
                  <Icon
                    name="search"
                    size={17}
                    className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-faint"
                  />
                  <input
                    className="field-input ps-11"
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
                            <span className="ltr-num text-xs text-muted">
                              {g.phone ?? g.email ?? ""}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <p className="field-hint mt-2">
                  מצא אורח קיים למילוי אוטומטי, או הזן את הפרטים ידנית למטה.
                </p>
              </BookingCard>

              <BookingCard icon="filter" title="מקור הזמנה">
                <Field label="מקור הזמנה" required>
                  <select
                    className="field-input"
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                  >
                    {bookingSources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </BookingCard>

              <BookingCard icon="user" title="פרטי אורח">
                <div className="bw-grid2">
                  <Field label="שם פרטי" required>
                    <input
                      className={`field-input${guestErr.firstName ? " field-error" : ""}`}
                      aria-invalid={guestErr.firstName || undefined}
                      placeholder="שם פרטי"
                      value={guest.firstName}
                      onChange={(e) => setGuest({ ...guest, firstName: e.target.value, id: undefined })}
                    />
                  </Field>
                  <Field label="שם משפחה" required>
                    <input
                      className={`field-input${guestErr.lastName ? " field-error" : ""}`}
                      aria-invalid={guestErr.lastName || undefined}
                      placeholder="שם משפחה"
                      value={guest.lastName}
                      onChange={(e) => setGuest({ ...guest, lastName: e.target.value, id: undefined })}
                    />
                  </Field>
                  <Field label="טלפון" required>
                    <input
                      className={`field-input ltr-num${guestErr.phone ? " field-error" : ""}`}
                      aria-invalid={guestErr.phone || undefined}
                      placeholder="050-0000000"
                      dir="ltr"
                      value={guest.phone}
                      onChange={(e) => setGuest({ ...guest, phone: e.target.value })}
                    />
                  </Field>
                  <Field label="אימייל">
                    <input
                      className="field-input"
                      placeholder="email@example.com"
                      dir="ltr"
                      type="email"
                      value={guest.email}
                      onChange={(e) => setGuest({ ...guest, email: e.target.value })}
                    />
                  </Field>
                  <Field label="ת.ז / דרכון">
                    <input
                      className="field-input ltr-num"
                      placeholder="מספר מזהה"
                      dir="ltr"
                      value={guest.idNumber}
                      onChange={(e) => setGuest({ ...guest, idNumber: e.target.value })}
                    />
                  </Field>
                  <Field label="שפה">
                    <select
                      className="field-input"
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
                      className="field-input"
                      value={guest.country}
                      onChange={(e) => setGuest({ ...guest, country: e.target.value })}
                    />
                  </Field>
                </div>
              </BookingCard>
            </>
          )}

          {/* ---- step 2: stays & rooms ---- */}
          {step === 1 && (
            <BookingCard icon="rooms" title="שהות וחדרים">
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
                    showErrors={showErrors}
                  />
                ))}
                <button
                  type="button"
                  className="btn bw-addroom"
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
                  <Icon name="plus" size={20} />
                  הוסף חדר נוסף
                </button>
              </div>
            </BookingCard>
          )}

          {/* ---- step 3: pricing & payment (reference
               new-booking-step-3 + booking-window.html) ---- */}
          {step === 2 && (
            <>
              <BookingCard icon="documents" title="פירוט תמחור">
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
                              className="field-input w-40"
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
                          <span className="ltr-num">{nights}</span> לילות × ₪
                          {canPriceOverride ? (
                            /* explicit operator edit = authorized manual override (§13) */
                            <input
                              type="number"
                              min={0}
                              aria-label="מחיר ללילה"
                              className="field-input ltr-num w-24 text-center"
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
                            <b className="ltr-num">
                              {(s.isManualRate ? (s.ratePerNight ?? 0) : autoRate).toLocaleString()}
                            </b>
                          )}
                          / לילה
                          {s.isManualRate && (
                            <button
                              type="button"
                              className="text-xs font-semibold text-primary underline"
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
                      <b className="ltr-num">₪{lineTotal.toLocaleString()}</b>
                    </div>
                  );
                })}
                {discount > 0 && (
                  <div className="bw-price-line">
                    <span className="bw-plr">הנחה</span>
                    <b className="ltr-num text-status-danger">-₪{discount.toLocaleString()}</b>
                  </div>
                )}
                {/* informational only — the TENANT VAT rate (Settings), already included in the total */}
                <div className="bw-price-line">
                  <span className="bw-plr">מע״מ ({formatVatRate(vatRate)}%) — כלול</span>
                  <b className="ltr-num text-muted">
                    ₪{includedVatAmount(total, vatRate).toLocaleString()}
                  </b>
                </div>
                <div className="bw-price-total">
                  <span>סה״כ לתשלום</span>
                  <span className="bw-amt ltr-num">₪{total.toLocaleString()}</span>
                </div>
              </BookingCard>

              <BookingCard icon="finance" title="סטטוס תשלום">
                {/* the chips drive REAL fields only: paid amount / draft
                    status — the shown state is always the derived one */}
                <div className="flex flex-wrap gap-2.5">
                  <PayChip
                    state="unpaid"
                    label="ממתין לתשלום"
                    on={!asDraft && payState === "unpaid"}
                    onClick={() => {
                      setAsDraft(false);
                      setPaid(0);
                    }}
                  />
                  <PayChip
                    state="partial"
                    label="שולם חלקית"
                    on={!asDraft && payState === "partial"}
                    onClick={() => {
                      setAsDraft(false);
                      paidRef.current?.focus();
                    }}
                  />
                  <PayChip
                    state="paid"
                    label="שולם מלא"
                    on={!asDraft && payState === "paid"}
                    onClick={() => {
                      setAsDraft(false);
                      setPaid(Math.round(total));
                    }}
                  />
                  <PayChip
                    state="pending"
                    label="ממתין לאישור"
                    on={asDraft}
                    onClick={() => setAsDraft(true)}
                  />
                </div>
                <div className="bw-grid3 mt-5">
                  <Field label="אמצעי תשלום">
                    <select
                      className="field-input"
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
                      className="field-input ltr-num"
                      value={paid || ""}
                      placeholder="0"
                      onChange={(e) => setPaid(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </Field>
                  <Field label="הנחה (₪)">
                    <input
                      type="number"
                      min={0}
                      className="field-input ltr-num"
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
                    showErrors={showErrors}
                    onChange={setCc}
                    chargeAmount={Math.max(0, total - paid)}
                    disabled={method !== "credit_card"}
                  />
                ) : (
                  <p className="field-hint mt-4">אין הרשאה לשמירת פרטי כרטיס אשראי</p>
                )}
              </BookingCard>
            </>
          )}

          {/* ---- step 4: summary ---- */}
          {step === 3 && (
            <BookingCard icon="check" title="סיכום ואישור">
              <div className="bw-grid2">
                <Field label="אורח">
                  <div className="field-input bw-ro flex items-center font-bold">{guestDisplay}</div>
                </Field>
                <Field label="מקור הזמנה">
                  <div className="field-input bw-ro flex items-center font-bold">{sourceLabel ?? "—"}</div>
                </Field>
                {workflowStatuses.length > 0 && (
                  <Field label="סטטוס הזמנה">
                    {/* "" = the tenant's default status, applied server-side (§11).
                        A chosen status tints the select with its configured color
                        family (D77.1) — same language as the calendar pill.
                        backgroundColor (not the `background` shorthand) keeps the
                        canonical select chevron image alive. */}
                    <select
                      className="field-input"
                      style={(() => {
                        if (!workflowStatusId) return undefined;
                        const t = statusTintPalette(
                          workflowStatuses.find((w) => w.id === workflowStatusId)?.color,
                        );
                        return { backgroundColor: t.bg, borderColor: t.bd, color: t.tx, fontWeight: 700 };
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
                    <div key={s.key} className="bw-price-line bw-price-flat">
                      <div>
                        <b>חדר {i + 1}</b>
                        <div className="bw-plr">
                          <bdi className="ltr-num">
                            {formatFullDate(s.checkIn)} – {formatFullDate(s.checkOut)}
                          </bdi>
                          · {nights} לילות · {s.adults + s.children + s.infants} אורחים
                        </div>
                      </div>
                      <b className="ltr-num text-primary">₪{lineTotal.toLocaleString()}</b>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-col gap-4">
                <Field label="שעת צ'ק-אין צפויה">
                  <input
                    type="time"
                    className="field-input ltr-num"
                    dir="ltr"
                    value={arrivalTime}
                    onChange={(e) => setArrivalTime(e.target.value)}
                  />
                </Field>
                <Field label="הערות להזמנה">
                  <textarea
                    className="field-input"
                    placeholder="בקשות מיוחדות…"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </Field>
              </div>
              <div className="bw-price-total mt-2">
                <span>סה״כ לתשלום</span>
                <span className="bw-amt ltr-num">₪{total.toLocaleString()}</span>
              </div>
            </BookingCard>
          )}
        </div>

        {/* ---- summary sidebar (reference .sum) ---- */}
        <aside className="bw-col-side max-lg:hidden">
          <div className="card">
            <div className="card-hd">
              <span className="bw-hi">
                <Icon name="reservations" size={17} />
              </span>
              סיכום הזמנה
            </div>
            <div className="card-bd bw-sum-b">
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
                              <span className="bw-p ltr-num">₪{lineTotal.toLocaleString()}</span>
                            )}
                          </div>
                          <div className="bw-sum-rd">
                            <Icon name="calendar" size={13.5} />
                            <bdi className="ltr-num">
                              {formatFullDate(s.checkIn)} – {formatFullDate(s.checkOut)}
                            </bdi>
                            <Icon name="moon" size={13.5} />
                            <span>{nights} ל׳</span>
                            <Icon name="users-round" size={13.5} />
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
                  <span className="ltr-num">{totalNights}</span>
                </div>
                <div className="bw-sum-line">
                  <span>אורחים</span>
                  <span className="ltr-num">{totalGuests}</span>
                </div>
              </div>
              <div className="bw-sum-total">
                <span className="bw-l">סה״כ</span>
                <span className="bw-v ltr-num">₪{total.toLocaleString()}</span>
              </div>
              <div className="bw-sum-line">
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

// A booking section = the canonical card (§6): `.card` shell, `.card-hd`
// heading (17px/800), `.card-bd` body. Every section of both booking panels
// goes through this one component — there is no second card anatomy.
export function BookingCard({
  icon,
  title,
  chip,
  tone,
  sectionRef,
  children,
}: {
  icon?: Parameters<typeof Icon>[0]["name"];
  title?: string;
  /** trailing chip pushed to the heading's end (e.g. "שונה") */
  chip?: React.ReactNode;
  /** whole-card state tint, derived from the status tokens */
  tone?: "danger" | "warn";
  sectionRef?: React.Ref<HTMLElement>;
  children: React.ReactNode;
}) {
  return (
    <section ref={sectionRef} className={`card${tone ? ` bw-card-${tone}` : ""}`}>
      {title ? (
        <div className="card-hd">
          {icon ? (
            <span className="bw-hi">
              <Icon name={icon} size={17} />
            </span>
          ) : null}
          {title}
          {chip ? (
            <>
              <span className="bw-sp" />
              {chip}
            </>
          ) : null}
        </div>
      ) : null}
      <div className="card-bd">{children}</div>
    </section>
  );
}

// The canonical field (§5): label ABOVE at 12px/700, 44px control.
export function Field({
  label,
  required,
  full,
  children,
}: {
  label: string;
  required?: boolean;
  /** span the whole form grid */
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`field${full ? " bw-full" : ""}`}>
      <span className="field-label">
        {label} {required && <span className="bw-req">*</span>}
      </span>
      {children}
    </label>
  );
}

// Selectable payment-status chip (§3): the canonical `.chip`. Selected wears
// the §3.1 triplet of the state; unselected is the neutral counting chip with
// the state's dot. Colours come from paymentTriplet — never re-typed here.
export function PayChip({
  state,
  label,
  on,
  disabled,
  title,
  onClick,
}: {
  state: PaymentState | "pending";
  label: string;
  on: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const t = paymentTriplet(state);
  return (
    <button
      type="button"
      className={`chip ${on ? t.chip : "chip-neutral"} cursor-pointer disabled:cursor-not-allowed disabled:opacity-60`}
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="dot" style={on ? undefined : { background: t.dot }} />
      {label}
    </button>
  );
}

// Payment badge — the same §3.1 triplet as the chip above and as the calendar
// bar (unpaid / partial / paid / overpaid = fully paid + a customer credit).
const PAYMENT_LABEL: Record<PaymentState, string> = {
  unpaid: "ממתין לתשלום",
  partial: "שולם חלקית",
  paid: "שולם מלא",
  overpaid: "שולם ביתר",
};

export function PaymentBadge({ state }: { state: PaymentState }) {
  return (
    <span className={`chip ${paymentTriplet(state).chip}`}>
      <span className="dot" />
      {PAYMENT_LABEL[state]}
    </span>
  );
}
