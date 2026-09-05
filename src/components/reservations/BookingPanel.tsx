"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { SidePanel } from "@/components/ui/SidePanel";
import { Icon } from "@/components/shared/Icon";
import { formatFullDate, nightsBetween } from "@/lib/dates";
import { paymentState, type PaymentState } from "@/lib/inventory-rules";
import { computeReservationTotals, type DiscountMode, type PriceMode } from "@/lib/pricing/totals";
import {
  BalanceBoxes, CurrencySelector, DiscountControls, PaymentMethodExtras, StayPriceModeControls, VatToggleRow,
} from "./PricingControls";
import { BookingDocuments } from "./BookingDocuments";
import { deleteBookingDocumentAction } from "@/app/(dashboard)/reservations/document-actions";
import { normalizePan, parseExpiry } from "@/lib/card-rules";
import { statusTintPalette } from "@/lib/colors";
import { paymentTriplet, STATUS_COLORS } from "@/lib/status-colors";
import {
  createReservationAction,
  searchGuestsAction,
  getStayQuoteAction,
  previewCancellationPolicyAction,
} from "@/app/(dashboard)/reservations/actions";
import type { CancellationPolicySnapshot } from "@/lib/commercial/policy-snapshot";
import { CancellationSnapshotView } from "./EditReservationPanel";
import { saveReservationCardAction } from "@/app/(dashboard)/reservations/card-actions";
import { StayEditor, newStayKey, type StayDraft } from "./StayEditor";
import { CardFields, EMPTY_CARD, cardDraftState, type CardDraft } from "./CardFields";
import { autoFilled, formFingerprint } from "@/lib/reservations/form-dirty";
import { BookingSuccess, type BookingCreated } from "./BookingSuccess";
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
  /** 084 — the calendar's create gate was blocked on an overridable COMMERCIAL
   *  restriction and an authorized operator chose "המשך בכל זאת". Carried
   *  through to createReservationAction, which re-checks the permission. */
  restrictionOverride?: boolean;
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

// the MD's five steps (§2 ש'20): documents sit between pricing and the summary
const STEPS = ["פרטי אורח", "שהות וחדרים", "תמחור ותשלום", "מסמכים", "סיכום ואישור"];
const SUMMARY_STEP = STEPS.length - 1;
// the success screen closes itself after this many seconds without a click
const AUTO_CLOSE_SECONDS = 5;

// מדינה (MD ש'68: select) — the guests table has no country list of its own,
// so the select carries a local option set; a value outside it (an imported
// guest) is prepended so the field never lies.
const COUNTRIES = [
  "ישראל", "ארה\"ב", "בריטניה", "גרמניה", "צרפת", "רוסיה", "אוקראינה",
  "איטליה", "ספרד", "הולנד", "בלגיה", "שווייץ", "אוסטריה", "פולין",
  "רומניה", "גאורגיה", "קנדה", "אוסטרליה", "ברזיל", "ארגנטינה", "אחר",
];

// מדיניות ביטול (MD ש'126) — the option set the MD names, with its dynamic
// explanation line. GRAPHIC SHELL: the policy engine this select should read
// from was deleted (migration 078); the real at-booking terms render below it.
// TODO(wire-up): feed the options from a policy engine when one exists.
const CANCEL_POLICY_OPTIONS: { value: string; label: string; explain: string }[] = [
  { value: "free7", label: "ביטול חינם עד 7 ימים לפני ההגעה", explain: "ביטול ללא עלות עד 7 ימים לפני מועד ההגעה; לאחר מכן חיוב לילה ראשון." },
  { value: "free14", label: "ביטול חינם עד 14 יום לפני ההגעה", explain: "ביטול ללא עלות עד 14 יום לפני מועד ההגעה; לאחר מכן חיוב לילה ראשון." },
  { value: "none", label: "ללא ביטול (Non-refundable)", explain: "הזמנה ללא אפשרות ביטול — חיוב מלא בכל שלב." },
];

// dirty-state fingerprint of everything the user can edit.
//
// "שולם" used to be written by the form itself (D87 §2: the live quote was
// copied into it the moment it landed), which is why it is compared through
// autoFilled() behind the paidTouched flag: while the form owns the field it
// does not speak, and the instant the operator takes it over it counts in
// full. D174 removed that auto-fill — the field now starts at 0 and only an
// explicit input (typing, a payment chip) moves it — and the flag stays as the
// one source of truth for "this is theirs now".
function formSnapshot(
  guest: GuestForm,
  sourceId: string,
  stays: StayDraft[],
  pricing: { discountMode: string; discountValue: number; taxExempt: boolean; currency: string },
  paid: number,
  /** the operator has edited "שולם" by hand — see autoFilled() */
  paidTouched: boolean,
  method: string,
  notes: string,
  arrivalTime: string,
  asDraft: boolean,
  cc: CardDraft,
): string {
  return formFingerprint([
    guest, sourceId, stays, pricing,
    autoFilled(paidTouched, paid),
    method, notes, arrivalTime, asDraft, cc,
  ]);
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
  enabledCurrencies = ["ILS"],
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
  ratePlans: { id: string; name: string; code: string; plan_kind: string }[];
  vatRate: number;
  /** settings.enabled_currencies (D107) — the selector renders only when >1 */
  enabledCurrencies?: string[];
  canSaveCard: boolean;
  canPriceOverride: boolean;
}) {
  const [step, setStep] = useState(0);
  // 084 — set once, from the prefill, when the panel opens: the operator already
  // answered the gate dialog. Nothing in the panel can turn it on.
  const [restrictionOverride, setRestrictionOverride] = useState(false);
  // validation feedback: set true when a blocked "הבא"/"צור הזמנה" click reds the
  // missing fields; cleared on every step change so a fresh step starts clean.
  const [showErrors, setShowErrors] = useState(false);
  const [guest, setGuest] = useState<GuestForm>(EMPTY_GUEST);
  const [sourceId, setSourceId] = useState<string>("");
  const [stays, setStays] = useState<StayDraft[]>([]);
  const [quotes, setQuotes] = useState<
    Record<string, { total: number; restriction: string | null; planSelection: import("@/lib/pricing/types").PlanAutoSelection | null }>
  >({});
  const [discountMode, setDiscountMode] = useState<DiscountMode>("none");
  const [discountValue, setDiscountValue] = useState(0);
  const [taxExempt, setTaxExempt] = useState(false);
  const [currency, setCurrency] = useState("ILS");
  // manual display snapshot to the property currency (D107) — non-base only
  const [exchangeRate, setExchangeRate] = useState<number | null>(null);
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
  // the AT-BOOKING cancellation policy preview (SPEC step 4, ס-7) — the same
  // resolver the create action snapshots with
  const [policyPreview, setPolicyPreview] = useState<CancellationPolicySnapshot | null>(null);
  const paidRef = useRef<HTMLInputElement | null>(null);
  // ברירת מחדל אוטומטית: שם בעל הכרטיס נגזר משם האורח — עד שהמשתמש עורך את
  // השדה ידנית, ואז המערכת מפסיקה לדרוס אותו. סכום ששולם אינו נגזר מכלום
  // (D174): מתחיל ב-0 ומשתנה רק מקלט מפורש; paidTouched מסמן שהמפעיל נגע בו
  const holderTouched = useRef(false);
  const paidTouched = useRef(false);
  const [saving, startSaving] = useTransition();
  // dirty-state protection: snapshot of the form right after open
  const snapshotRef = useRef("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // documents uploaded during THIS wizard run (booking_id NULL server-side):
  // attached inside the creation transaction; soft-deleted on discard
  const [docIds, setDocIds] = useState<string[]>([]);
  // חברה / ארגון (MD ש'69) — GRAPHIC SHELL: guests has no such column, the
  // value never leaves this panel. TODO(wire-up): persist on the guest.
  const [company, setCompany] = useState("");
  // מדיניות ביטול select (MD ש'126) — shell state, see CANCEL_POLICY_OPTIONS
  const [policyChoice, setPolicyChoice] = useState(CANCEL_POLICY_OPTIONS[0].value);
  // מסך הצלחה (MD ש'127): after a successful create the panel shows the green
  // ✓ summary instead of closing straight away
  const [created, setCreated] = useState<BookingCreated | null>(null);
  // success-screen auto-close: 5 → 1, then the panel closes exactly as if
  // "סגור" was clicked. Any manual close clears the interval first (no double
  // close, no ticking after unmount).
  const [closeIn, setCloseIn] = useState(AUTO_CLOSE_SECONDS);
  const closeTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // guest search
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { id: string; full_name: string; first_name: string | null; last_name: string | null; phone: string | null; email: string | null; id_number: string | null }[]
  >([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    const initialSource = bookingSources[0]?.id ?? "";
    // אמצעי תשלום — מתחיל לא-נבחר (D174, מבטל את ברירת המחדל "מזומן" של
    // MD ש'25/ש'112): נדרש רק כשנרשם סכום ששולם, ראה handleCreate
    const initialMethod = "";
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
    setRestrictionOverride(prefill.restrictionOverride === true);
    setGuest(EMPTY_GUEST);
    setSourceId(initialSource);
    setStays(initialStays);
    setQuotes({});
    setDiscountMode("none");
    setDiscountValue(0);
    setTaxExempt(false);
    setCurrency("ILS");
    setExchangeRate(null);
    setPaid(0);
    setMethod(initialMethod);
    setNotes("");
    // שעת הגעה: cleared like every other field — it used to survive from the
    // previous wizard run, which both showed as an unsaved change on open and
    // rode along into the next reservation (see expectedArrivalTime on save)
    setArrivalTime("");
    setAsDraft(false);
    setCc(EMPTY_CARD);
    setDocIds([]);
    holderTouched.current = false;
    paidTouched.current = false;
    setWorkflowStatusId("");
    setQuery("");
    setResults([]);
    setConfirmDiscard(false);
    setCompany("");
    setPolicyChoice(CANCEL_POLICY_OPTIONS[0].value);
    setCreated(null);
    snapshotRef.current = formSnapshot(
      EMPTY_GUEST, initialSource, initialStays,
      { discountMode: "none", discountValue: 0, taxExempt: false, currency: "ILS" },
      // paid, and nobody has touched it yet — at open, by definition
      0, false,
      initialMethod, "", "", false, EMPTY_CARD,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirty =
    formSnapshot(guest, sourceId, stays, { discountMode, discountValue, taxExempt, currency }, paid, paidTouched.current, method, notes, arrivalTime, asDraft, cc) !==
      snapshotRef.current || docIds.length > 0;

  const clearCloseTimer = () => {
    if (closeTimer.current) {
      clearInterval(closeTimer.current);
      closeTimer.current = null;
    }
  };

  // every exit from the success screen — button, Esc, overlay, or the timer
  // itself — funnels here so the interval is ALWAYS cleared before closing
  const closeFromSuccess = () => {
    clearCloseTimer();
    onClose();
  };

  // the countdown runs only while the success screen is up; closing the panel
  // unmounts/resets `created`, and the cleanup kills the interval
  useEffect(() => {
    if (!created) return;
    setCloseIn(AUTO_CLOSE_SECONDS);
    closeTimer.current = setInterval(() => setCloseIn((s) => s - 1), 1000);
    return clearCloseTimer;
  }, [created]);

  useEffect(() => {
    if (created && closeIn <= 0) closeFromSuccess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeIn, created]);

  // Escape / X / overlay click route here — unsaved changes get an explicit
  // discard confirmation (footer strip) instead of a silent reset
  const requestClose = () => {
    if (saving) return;
    // the success screen is a terminal state — closing needs no discard confirm
    if (created) {
      closeFromSuccess();
      return;
    }
    if (dirty && !confirmDiscard) setConfirmDiscard(true);
    else onClose();
  };

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    // the MD's debounce (ש'53): 300ms
    searchTimer.current = setTimeout(async () => {
      const res = await searchGuestsAction(query);
      if (res.success && res.data) setResults(res.data);
    }, 300);
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
          setQuotes((q) => ({
            ...q,
            [s.key]: { total: res.data!.total, restriction: res.data!.restriction, planSelection: res.data!.planSelection },
          }));
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, stays.map((s) => `${s.key}|${s.roomId}|${s.checkIn}|${s.checkOut}|${s.adults}|${s.children}|${s.infants}|${s.ratePlanId ?? ""}`).join(",")]);

  const staysValid =
    stays.length > 0 &&
    stays.every((s) => s.roomId && s.checkIn && s.checkOut && s.checkOut > s.checkIn);
  // mode-aware committed line total (D106): manual figures are the operator's
  // word; auto comes from the live engine quote
  const lineTotalOf = (s: StayDraft): number => {
    const nights = s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0;
    if (s.priceMode === "manual_total" && s.manualTotal != null) return s.manualTotal;
    if ((s.priceMode === "manual_night" || (s.priceMode === undefined && s.isManualRate)) && s.ratePerNight != null)
      return Math.round(s.ratePerNight * nights * 100) / 100;
    return quotes[s.key]?.total ?? 0;
  };
  // length-of-stay discounts already sit INSIDE each line total (the engine
  // applies them); this is the summary figure, shown so the operator sees what
  // the stay length gave away (D104). A manual override is never auto-discounted.
  // THE single totals source (D106) — the same pure module the server persists
  // with; the client only feeds it state and displays the result
  const totals = computeReservationTotals(
    {
      stays: stays.map((s) => ({
        priceTotal: lineTotalOf(s),
        nights: s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0,
      })),
      discountMode,
      discountValue,
      extraCharges: 0,
      taxExempt,
      vatRate,
      currency,
      paid,
    },
    { validate: false }, // live preview never throws; the server validates on save
  );
  const total = totals.grandTotal;
  const payState = paymentState(total, paid);

  // שם בעל הכרטיס = שם האורח (עד עריכה ידנית)
  const guestFullName = `${guest.firstName} ${guest.lastName}`.trim();
  useEffect(() => {
    if (holderTouched.current) return;
    setCc((p) => (p.holder === guestFullName ? p : { ...p, holder: guestFullName }));
  }, [guestFullName]);
  // סכום ששולם אינו מסונכרן מהסה"כ (D174): 0 עד לקלט מפורש של המפעיל —
  // ברירת המחדל של D87 §2 יצרה שורת תשלום מזומן על כל הזמנה (#1159)

  useEffect(() => {
    if (step !== SUMMARY_STEP) return;
    let alive = true;
    previewCancellationPolicyAction(stays[0]?.ratePlanId ?? null).then((res) => {
      if (alive) setPolicyPreview(res.success && res.data ? res.data : null);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, stays[0]?.ratePlanId]);

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
  // D174 — אמצעי תשלום הוא חובה רק כשנרשם סכום ששולם
  const methodErr = showErrors && paid > 0 && !method;

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
    // D174 — a recorded amount needs a method; no amount needs nothing
    if (paid > 0 && !method) {
      setShowErrors(true);
      toast.error("נרשם סכום ששולם — יש לבחור אמצעי תשלום");
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
          // an explicit operator-set price — nightly or total — is an
          // authorized override (§13); otherwise the server prices through
          // the central engine
          ratePerNight: s.priceMode === "manual_night" || s.isManualRate ? s.ratePerNight : undefined,
          isManualRate: (s.priceMode ? s.priceMode === "manual_night" : s.isManualRate) || undefined,
          priceMode: s.priceMode,
          manualTotal: s.priceMode === "manual_total" ? s.manualTotal : undefined,
          ratePlanId: s.ratePlanId ?? null,
          guestFirstName: s.guestFirstName || undefined,
          guestLastName: s.guestLastName || undefined,
          guestPhone: s.guestPhone || undefined,
        })),
        notes: notes.trim() || undefined,
        expectedArrivalTime: arrivalTime || null,
        discountMode,
        discountValue: discountValue || undefined,
        taxExempt,
        currency,
        exchangeRate: currency !== (enabledCurrencies[0] ?? "ILS") ? exchangeRate : null,
        paidAmount: paid || undefined,
        paymentMethod: method || undefined,
        workflowStatusId: workflowStatusId || undefined,
        documentIds: docIds.length > 0 ? docIds : undefined,
        restrictionOverride,
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
          cvv: cc.cvv || undefined,
          source: cc.source,
        });
        if (!saved.success) toast.error(`ההזמנה נוצרה, אך שמירת הכרטיס נכשלה: ${saved.error}`);
      }
      setCc(EMPTY_CARD);
      if (res.data) onCreated?.(res.data.reservationId);
      toast.success(`הזמנה #${res.data?.reservationNumber} נוצרה בהצלחה`);
      // מסך הצלחה (MD ש'127): ✓ ירוק + שורת תקציר — the panel closes from it
      setCreated({
        number: res.data?.reservationNumber ?? "",
        guest: `${guest.firstName} ${guest.lastName}`.trim(),
        rooms: stays.length,
        total,
        paid,
        balance: totals.balance,
      });
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
      /* the MD shell: 60% width bounded to 900–1200px (same bounds as the edit
         window); bw-win scopes the booking chrome (18px corner, 40px X, X-hover)
         and bw-new the wizard-only values (subtitle .82, 26px total) */
      widthClassName="bw-win bw-new w-[60%] min-w-[min(900px,100%)] max-w-[1200px]"
      bodyClassName="bg-appbg p-0"
      /* MD §1: slide from -108% in .45s cubic-bezier(.32,.72,.24,1) over the
         rgba(15,23,42,.45)+blur overlay — the booking visual variant */
      visualVariant="booking"
      /* WHAT IS NOT IN THIS HEADER, AND WHY. תצוגה מקדימה / הדפסה / PDF /
         וואטסאפ / מייל used to sit here as graphic shells with no onClick,
         because on CREATE there is nothing to preview, print or send — the
         reservation does not exist yet. Owner ruling: those five belong to
         editing an EXISTING reservation, where BookingToolbar
         (BookingActions.tsx) draws them with real handlers.
         The room+lock door went with them (owner ruling, this run). A wizard for
         creating a reservation is not where a room gets closed: the act has its
         own doors on the board it belongs to — the "חסימת חדר" header button and
         a right-click on the desktop grid, the same header button on mobile — and
         a shortcut that had to close the wizard, ask about unsaved work and
         re-open somewhere else was a second route to a place that already had
         one. Nothing replaced it here; there is no header cluster left. */
      band={
        created ? undefined : (
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
        )
      }
      footer={
        created ? (
          /* success-screen footer — §7 via .dw-ft (row-reverse): DOM order =
             visual left→right, so "סגור" hugs the LEFT edge like every primary
             action, the countdown sits beside it, and the spacer fills the rest */
          <>
            <button type="button" className="btn btn-primary" onClick={closeFromSuccess}>
              <Icon name="check" size={18} />
              סגור
            </button>
            <span className="bw-ft-timer">
              החלון ייסגר אוטומטית תוך <b className="ltr-num">{Math.max(1, closeIn)}</b> שנ׳
            </span>
            <span className="flex-1" />
          </>
        ) : confirmDiscard ? (
          /* dirty-state discard confirmation. §7 via .dw-ft (row-reverse):
             DOM order = visual left→right — the confirming action is FIRST
             so it hugs the LEFT edge; the warning text sits at the far right. */
          <>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                // a discarded wizard leaves no live orphans — its pre-created
                // documents (booking_id NULL) are soft-deleted, fire-and-forget
                for (const id of docIds) void deleteBookingDocumentAction(id);
                onClose();
              }}
            >
              סגור בלי לשמור
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmDiscard(false)}
            >
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
            {step < SUMMARY_STEP ? (
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
            <span className="flex-1" />
            <span className="bw-ft-step">
              <Icon name="info" size={17} />
              שלב {step + 1} מתוך {STEPS.length}
            </span>
            {/* the MD footer order (right→left): ביטול · שלב X · הקודם · הבא —
                .dw-ft is row-reverse, so the LAST child sits at the far right */}
            <button type="button" className="btn bw-btn-cancel" onClick={requestClose}>
              ביטול
            </button>
          </>
        )
      }
    >
      {created ? (
        /* מסך הצלחה (MD ש'127): ✓ ירוק גדול + "ההזמנה נוצרה בהצלחה" + שורת
           תקציר (אורח · חדרים · סה"כ · שולם · יתרה) — centred in the body,
           with the drawn ✓ and the one-shot confetti burst */
        <BookingSuccess created={created} />
      ) : (
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
                    /* the MD's LARGE 54px search box (ש'52) */
                    className="field-input bw-search ps-11"
                    placeholder="חפש לפי שם, טלפון או אימייל…"
                    dir="auto" /* Latin/numeric queries keep their own base direction */
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
                      dir="auto" /* guest names are routinely Latin (OTA bookings) */
                      value={guest.firstName}
                      onChange={(e) => setGuest({ ...guest, firstName: e.target.value, id: undefined })}
                    />
                  </Field>
                  <Field label="שם משפחה" required>
                    <input
                      className={`field-input${guestErr.lastName ? " field-error" : ""}`}
                      aria-invalid={guestErr.lastName || undefined}
                      placeholder="שם משפחה"
                      dir="auto" /* guest names are routinely Latin (OTA bookings) */
                      value={guest.lastName}
                      onChange={(e) => setGuest({ ...guest, lastName: e.target.value, id: undefined })}
                    />
                  </Field>
                  <Field label="טלפון" required>
                    <div className="bw-fld-wrap">
                      <Icon name="phone" size={17} className="bw-fi" />
                      <input
                        className={`field-input bw-ic ltr-num${guestErr.phone ? " field-error" : ""}`}
                        aria-invalid={guestErr.phone || undefined}
                        placeholder="050-0000000"
                        dir="ltr"
                        value={guest.phone}
                        onChange={(e) => setGuest({ ...guest, phone: e.target.value })}
                      />
                    </div>
                  </Field>
                  <Field label="אימייל">
                    <div className="bw-fld-wrap">
                      <Icon name="mail" size={17} className="bw-fi" />
                      <input
                        className="field-input bw-ic"
                        placeholder="email@example.com"
                        dir="ltr"
                        type="email"
                        value={guest.email}
                        onChange={(e) => setGuest({ ...guest, email: e.target.value })}
                      />
                    </div>
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
                      {/* the MD's exact list and order (ש'67) */}
                      <option>עברית</option>
                      <option>English</option>
                      <option>العربية</option>
                      <option>Русский</option>
                      {/* legacy passthrough — a guest stored with another
                          language keeps displaying it until changed */}
                      {guest.language &&
                        !["עברית", "English", "العربية", "Русский"].includes(guest.language) && (
                          <option>{guest.language}</option>
                        )}
                    </select>
                  </Field>
                  <Field label="מדינה">
                    {/* the MD orders a select (ש'68) — options are the local
                        COUNTRIES set; an out-of-set stored value passes through */}
                    <select
                      className="field-input"
                      value={guest.country}
                      onChange={(e) => setGuest({ ...guest, country: e.target.value })}
                    >
                      {guest.country && !COUNTRIES.includes(guest.country) && (
                        <option>{guest.country}</option>
                      )}
                      {COUNTRIES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="חברה / ארגון">
                    {/* GRAPHIC SHELL (MD ש'69) — TODO(wire-up): no guest
                        company column exists; the value stays in the panel */}
                    <input
                      className="field-input"
                      dir="auto" /* company names are routinely Latin */
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
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
              <BookingCard
                icon="documents"
                title="תמחור ותשלום"
                chip={
                  <span className="flex items-center gap-3">
                    {currency !== (enabledCurrencies[0] ?? "ILS") && (
                      <label className="flex items-center gap-1.5 text-xs text-muted">
                        שער המרה
                        <input
                          type="number"
                          min={0}
                          step="0.0001"
                          dir="ltr"
                          aria-label="שער המרה"
                          className="field-input ltr-num w-24 text-center"
                          placeholder="—"
                          value={exchangeRate ?? ""}
                          onChange={(e) => setExchangeRate(Number(e.target.value) || null)}
                        />
                      </label>
                    )}
                    <CurrencySelector
                      currencies={enabledCurrencies}
                      value={currency}
                      onChange={setCurrency}
                    />
                  </span>
                }
              >
                {stays.map((s, i) => {
                  const nights = s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0;
                  const q = quotes[s.key];
                  const mode: PriceMode =
                    s.priceMode ?? (s.isManualRate ? "manual_night" : "auto");
                  const autoRate = nights ? Math.round(((q?.total ?? 0) / nights) * 100) / 100 : 0;
                  return (
                    <div key={s.key} className="border-b border-line pb-4 pt-3 last:border-b-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex flex-col gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <b>חדר {i + 1}</b>
                            <span className="text-xs text-muted">
                              <span className="ltr-num">{nights}</span> לילות
                            </span>
                          </div>
                          <StayPriceModeControls
                            /* the "מחיר מקורי" mode's ONE field (MD): the
                               rate-plan select — same state, same handler */
                            autoField={
                              ratePlans.length > 0 ? (
                                <select
                                  className="field-input w-40"
                                  aria-label="תוכנית תעריף"
                                  value={s.ratePlanId ?? ""}
                                  onChange={(e) =>
                                    setStays((all) =>
                                      all.map((x) =>
                                        x.key === s.key
                                          ? { ...x, ratePlanId: e.target.value || null, priceMode: "auto", isManualRate: false, ratePerNight: undefined, manualTotal: null }
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
                              ) : undefined
                            }
                            mode={mode}
                            onMode={(m) =>
                              /* switching mode keeps every entered value (SPEC
                                 rule 6) — only the ACTIVE mode's value prices */
                              setStays((all) =>
                                all.map((x) =>
                                  x.key === s.key
                                    ? { ...x, priceMode: m, isManualRate: m === "manual_night" }
                                    : x,
                                ),
                              )
                            }
                            nights={nights}
                            autoRate={autoRate}
                            autoTotal={q?.total ?? 0}
                            ratePerNight={s.ratePerNight ?? null}
                            onRatePerNight={(v) =>
                              setStays((all) =>
                                all.map((x) =>
                                  x.key === s.key
                                    ? { ...x, ratePerNight: v, priceMode: "manual_night", isManualRate: true }
                                    : x,
                                ),
                              )
                            }
                            manualTotal={s.manualTotal ?? null}
                            onManualTotal={(v) =>
                              setStays((all) =>
                                all.map((x) =>
                                  x.key === s.key
                                    ? { ...x, manualTotal: v, priceMode: "manual_total", isManualRate: false }
                                    : x,
                                ),
                              )
                            }
                            canPriceOverride={canPriceOverride}
                          />
                          {/* which plan the engine picked for the stay length —
                              its own sentence, only when the operator named none */}
                          {q?.planSelection?.selectedPlanId && !s.ratePlanId && mode === "auto" && (
                            <p className="text-sm font-semibold text-status-success">
                              {q.planSelection.reason}
                            </p>
                          )}
                        </div>
                        <b className="ltr-num tabular-nums">₪{lineTotalOf(s).toLocaleString()}</b>
                      </div>
                    </div>
                  );
                })}
                <div className="mt-4 border-t border-line pt-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-bold">
                    <Icon name="tags" size={16} />
                    הנחה
                  </div>
                  <DiscountControls
                    mode={discountMode}
                    value={discountValue}
                    onChange={(m, v) => {
                      setDiscountMode(m);
                      setDiscountValue(v);
                    }}
                  />
                  {/* live discount feedback (MD): amount · share of full price ·
                      per-night — warn-toned while a discount is in effect */}
                  {totals.discountAmount > 0 && (
                    <p className="mt-2 text-sm font-bold text-status-warning tabular-nums">
                      −₪<bdi className="ltr-num">{totals.discountAmount.toLocaleString()}</bdi> ·{" "}
                      <bdi className="ltr-num">
                        {totals.roomsTotal > 0
                          ? Math.round((totals.discountAmount / totals.roomsTotal) * 100)
                          : 0}
                      </bdi>
                      % מהמחיר המלא · ₪
                      <bdi className="ltr-num">
                        {totalNights > 0 ? Math.round(totals.discountAmount / totalNights).toLocaleString() : 0}
                      </bdi>{" "}
                      ללילה
                    </p>
                  )}
                </div>
                <div className="bw-price-line mt-3">
                  <span className="bw-plr">מחיר מלא</span>
                  <b className="ltr-num tabular-nums">₪{totals.roomsTotal.toLocaleString()}</b>
                </div>
                {totals.discountAmount > 0 && (
                  <div className="bw-price-line">
                    <span className="bw-plr">הנחה</span>
                    <b className="ltr-num text-status-danger">−₪{totals.discountAmount.toLocaleString()}</b>
                  </div>
                )}
                <VatToggleRow
                  vatRate={vatRate}
                  grandTotal={total}
                  taxExempt={taxExempt}
                  onToggle={setTaxExempt}
                />
                <div className="bw-price-total">
                  <span>סה״כ לתשלום</span>
                  <span className="bw-amt ltr-num">₪{total.toLocaleString()}</span>
                </div>
                {/* the currency list is Settings-owned (D107) — said where the
                    selector is offered, at the card's foot per the MD */}
                {enabledCurrencies.length > 1 && (
                  <p className="field-hint mt-3">
                    רשימת המטבעות נקבעת בהגדרות ← מטבעות להזמנות.
                  </p>
                )}
              </BookingCard>

              <BookingCard icon="finance" title="סטטוס תשלום">
                {/* payment progress (MD): שולם X מתוך Y + אחוז, over the ok token */}
                {total > 0 && (
                  <div className="mb-4">
                    <div className="mb-1.5 flex items-center justify-between text-sm font-bold">
                      <span>
                        שולם ₪<bdi className="ltr-num">{paid.toLocaleString()}</bdi> מתוך ₪
                        <bdi className="ltr-num">{total.toLocaleString()}</bdi>
                      </span>
                      <span className="ltr-num text-status-success">
                        {Math.min(100, Math.round((paid / total) * 100))}%
                      </span>
                    </div>
                    <div className="bw-payprog">
                      <span
                        className="bw-payprog-fill block"
                        style={{ width: `${Math.min(100, (paid / total) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
                {/* the chips drive REAL fields only: paid amount / draft
                    status — the shown state is always the derived one */}
                <div className="flex flex-wrap gap-2.5">
                  <PayChip
                    state="unpaid"
                    label="לא שולם"
                    on={!asDraft && payState === "unpaid"}
                    onClick={() => {
                      setAsDraft(false);
                      paidTouched.current = true;
                      setPaid(0);
                    }}
                  />
                  <PayChip
                    state="partial"
                    label="שולם חלקית"
                    on={!asDraft && payState === "partial"}
                    onClick={() => {
                      setAsDraft(false);
                      paidTouched.current = true;
                      paidRef.current?.focus();
                    }}
                  />
                  <PayChip
                    state="paid"
                    label="שולם מלא"
                    on={!asDraft && payState === "paid"}
                    onClick={() => {
                      setAsDraft(false);
                      paidTouched.current = true;
                      setPaid(total);
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
                      className={`field-input${methodErr ? " field-error" : ""}`}
                      aria-invalid={methodErr || undefined}
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
                      onChange={(e) => {
                        paidTouched.current = true;
                        setPaid(Math.max(0, Number(e.target.value) || 0));
                      }}
                    />
                  </Field>
                  <Field label="יתרה לתשלום">
                    {/* requirement 4: the balance is visible at CREATE time too */}
                    <b
                      className={`ltr-num tabular-nums ${
                        totals.balance > 0 ? "text-status-danger" : totals.balance < 0 ? "text-status-success" : ""
                      }`}
                    >
                      {totals.balance < 0
                        ? `זיכוי ₪${Math.abs(totals.balance).toLocaleString()}`
                        : `₪${totals.balance.toLocaleString()}`}
                    </b>
                  </Field>
                </div>
                {/* conditional method windows: ביט/פייבוקס/אפליקציה → מספר
                    אישור; העברה בנקאית → בנק/סניף/חשבון/בעל החשבון; צ'ק →
                    בנק/סניף/חשבון/מספר צ'ק. keyed so switching methods starts
                    the shell fields clean */}
                <PaymentMethodExtras
                  key={method}
                  methodKey={method}
                  methodLabel={paymentMethods.find((m) => m.key === method)?.label}
                  guestName={guestFullName}
                />
                {/* the card box renders ONLY while אמצעי תשלום = כרטיס אשראי
                    (MD ש'115 + this PR's prompt: for every other method —
                    including מזומן — the block is hidden entirely, not shown
                    disabled). Switching away clears the draft (§15 above), so
                    nothing survives hidden. */}
                {method === "credit_card" &&
                  (canSaveCard ? (
                    <CardFields
                      value={cc}
                      showErrors={showErrors}
                      onChange={(updater) =>
                        setCc((prev) => {
                          const next = updater(prev);
                          if (next.holder !== prev.holder) holderTouched.current = true;
                          return next;
                        })
                      }
                      chargeAmount={Math.max(0, total - paid)}
                      disabled={method !== "credit_card"}
                      showSaveMark
                    />
                  ) : (
                    <p className="field-hint mt-4">אין הרשאה לשמירת פרטי כרטיס אשראי</p>
                  ))}
              </BookingCard>
            </>
          )}

          {/* ---- step 4: documents (MD §"שלב 4 — מסמכים") — WIRED: uploads
               run immediately (booking_id NULL) and attach on create. Mounted
               on every step (hidden outside step 4) so the rows survive step
               navigation; the ids live in docIds above. ---- */}
          <div className={step === 3 ? undefined : "hidden"}>
            <BookingCard icon="folder" title="מסמכים להזמנה">
              <BookingDocuments bookingId={null} onIdsChange={setDocIds} />
            </BookingCard>
          </div>

          {/* ---- step 5: summary ---- */}
          {step === SUMMARY_STEP && (
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
                  const lineTotal = lineTotalOf(s);
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
                    dir="auto" /* notes arrive in either language */
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </Field>
              </div>
              <div className="bw-price-total mt-2">
                <span>סה״כ לתשלום</span>
                <span className="bw-amt ltr-num">₪{total.toLocaleString()}</span>
              </div>
              {/* requirement 4 + SPEC step 4: the balance strip at confirm time —
                  the MD's three cubes, the status badge as the third */}
              <div className="mt-3">
                <BalanceBoxes total={total} paid={paid} statusChip={<PaymentBadge state={payState} />} />
              </div>
            </BookingCard>
          )}

          {/* cancellation policy BELOW the notes (SPEC step 4 / complaint 11) */}
          {step === SUMMARY_STEP && (
            <BookingCard icon="documents" title="מדיניות ביטול">
              {/* the MD's select (ש'126) with its dynamic explanation line —
                  a GRAPHIC SHELL: the policy engine it should read from was
                  deleted (migration 078). TODO(wire-up): policy engine. */}
              <Field label="מדיניות ביטול">
                <select
                  className="field-input"
                  value={policyChoice}
                  onChange={(e) => setPolicyChoice(e.target.value)}
                >
                  {CANCEL_POLICY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="field-hint mt-2">
                {CANCEL_POLICY_OPTIONS.find((o) => o.value === policyChoice)?.explain}
              </p>
              {/* the REAL at-booking terms the create action freezes into the
                  snapshot — displayed unchanged below the select */}
              {policyPreview && (
                <div className="mt-4 border-t border-line pt-4">
                  <CancellationSnapshotView snap={policyPreview} />
                </div>
              )}
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
      )}
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
  // The chips are the demo's .paychip 1:1 (design-ref/booking-window-v2.html,
  // decoded source lines 266-274): 44px pills, white fill, colored 9px dot,
  // and a selected state wearing the dot-colored 2px border over a tinted
  // fill. Colors per the MD (הקמה ש'111): אדום/כתום/ירוק/כחול — the local
  // .bw-pc-* classes in booking-window.css; the global §3.1 .chip family is
  // untouched everywhere else. overpaid has no demo/MD row — it keeps the
  // approved purple family in the same geometry.
  return (
    <button
      type="button"
      className={`bw-paychip bw-pc-${state}${on ? " on" : ""} disabled:cursor-not-allowed disabled:opacity-60`}
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="pd" />
      {label}
    </button>
  );
}

// Payment badge — the same §3.1 triplet as the chip above and as the calendar
// bar (unpaid / partial / paid / overpaid = fully paid + a customer credit).
// "לא שולם" is the canonical §3.1 name of the unpaid state (both booking MDs
// use it); the workflow status "ממתין לתשלום" is a different axis entirely.
const PAYMENT_LABEL: Record<PaymentState, string> = {
  unpaid: "לא שולם",
  partial: "שולם חלקית",
  paid: "שולם מלא",
  overpaid: "שולם ביתר",
};

export function PaymentBadge({ state }: { state: PaymentState }) {
  // the same local partial→orange mapping as PayChip above (MD: כתום), so the
  // rail badge and the chips row can never disagree inside the windows
  const t = state === "partial" ? STATUS_COLORS.approval : paymentTriplet(state);
  return (
    <span className={`chip ${t.chip}`}>
      <span className="dot" />
      {PAYMENT_LABEL[state]}
    </span>
  );
}
