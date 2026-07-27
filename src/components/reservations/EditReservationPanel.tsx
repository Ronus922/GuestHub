"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { SidePanel } from "@/components/ui/SidePanel";
import { Icon, type IconName } from "@/components/shared/Icon";
import { formatFullDate, nightsBetween } from "@/lib/dates";
import { paymentState, formatBalance } from "@/lib/inventory-rules";
import { computeReservationTotals, type DiscountMode, type PriceMode } from "@/lib/pricing/totals";
import { DiscountControls, StayPriceModeControls, VatToggleRow } from "./PricingControls";
import { normalizePan, parseExpiry, resolveCardMode } from "@/lib/card-rules";
import { describeCancellationTier } from "@/lib/commercial/cancellation";
import { normalizeVisibleChannel, statusTintPalette } from "@/lib/colors";
import { paymentTriplet } from "@/lib/status-colors";
import {
  COLLECTION_LABEL,
  COLLECT_OWNER_LABEL,
  PAYMENT_TYPE_LABEL,
} from "@/lib/payments/collection-labels";
import { useRealtimeEvent } from "@/components/providers/RealtimeProvider";
import {
  getReservationAction,
  updateReservationAction,
  setWorkflowStatusAction,
  type ReservationDetail,
} from "@/app/(dashboard)/reservations/actions";
import { CancelReservationDialog } from "./CancelReservationDialog";
import { BookingComReportsCard, BookingComReportDialog } from "./BookingComReports";
import type { BookingReportAction } from "@/lib/channel/booking-com-report-rules";
import {
  saveReservationCardAction,
  deleteReservationCardAction,
} from "@/app/(dashboard)/reservations/card-actions";
import { EDITABLE_STATUSES } from "@/lib/validation/reservation";
import { StayEditor, newStayKey, type StayDraft } from "./StayEditor";
import { CardFields, EMPTY_CARD, cardDraftState, type CardDraft } from "./CardFields";
import { PaymentBadge, PayChip, BookingCard, Field } from "./BookingPanel";
import { BookingToolbar, MessageComposer } from "./BookingActions";
import type { LookupItem } from "@/app/(dashboard)/calendar/CalendarScreen";

// עריכת הזמנה — the single reservation detail/edit flow the calendar opens
// (ref/screens/edit-booking-modal.png) inside the site-wide SIDE PANEL
// shell (D41): sectioned form, summary + activity sidebar, sticky header
// and action footer, the calendar stays mounted and visible behind it.
// Preserves every reservation room, per-room guests, pricing, status and
// payments (§F). The stored-card section shows masked metadata only;
// full-PAN reveal is explicit, permission-guarded and audited.

// how long after our own save a realtime event for THIS reservation is treated
// as the echo of that save rather than a background change
const SELF_EVENT_WINDOW_MS = 5000;

export function EditReservationPanel({
  reservationId,
  onClose,
  bookingSources,
  paymentMethods,
  ratePlans,
  statusItems,
  workflowStatuses = [],
  canEdit,
  canCancel,
  vatRate,
  canSaveCard,
  canRevealCard,
  canChargeCard,
}: {
  reservationId: string | null;
  onClose: () => void;
  bookingSources: LookupItem[];
  paymentMethods: LookupItem[];
  ratePlans: { id: string; name: string; code: string; plan_kind: string }[];
  statusItems: LookupItem[];
  /** tenant workflow statuses (D77 §11) — active ones, DB colors */
  workflowStatuses?: LookupItem[];
  canEdit: boolean;
  canCancel: boolean;
  vatRate: number;
  canSaveCard: boolean;
  canRevealCard: boolean;
  canChargeCard: boolean;
}) {
  const [detail, setDetail] = useState<ReservationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [guest, setGuest] = useState({ firstName: "", lastName: "", phone: "", email: "", idNumber: "" });
  const [sourceId, setSourceId] = useState("");
  const [stays, setStays] = useState<StayDraft[]>([]);
  const [discountMode, setDiscountMode] = useState<DiscountMode>("none");
  const [discountValue, setDiscountValue] = useState(0);
  const [taxExempt, setTaxExempt] = useState(false);
  const [addPay, setAddPay] = useState(0);
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  // שעת הגעה משוערת — dedicated field (D80), independent of notes; "" = none
  const [arrivalTime, setArrivalTime] = useState("");
  // new-card entry values travel ONLY through the dedicated guarded save
  // action, then are cleared (see CardFields security note)
  const [cc, setCc] = useState<CardDraft>(EMPTY_CARD);
  const [cardMeta, setCardMeta] = useState<ReservationDetail["card"]>(null);
  // ONE manual-entry flag (D86): a stored card and an imported channel guarantee
  // both render read-only in the canonical fields until the operator explicitly
  // chooses to key a card in ("החלף כרטיס" / "הזנת כרטיס ידנית במקום").
  const [replacingCard, setReplacingCard] = useState(false);
  // card-save failure shown INLINE in the card section (role="alert") — a
  // swallowed/missed failure is exactly complaint 8; cleared on the next try
  const [cardError, setCardError] = useState<string | null>(null);
  const [cardBusy, startCardBusy] = useTransition();
  const [saving, startSaving] = useTransition();
  const [cancelOpen, setCancelOpen] = useState(false);
  // D96 — which Booking.com status report is being confirmed, if any
  const [reportAction, setReportAction] = useState<BookingReportAction | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // workflow status (D77 §11) — applied immediately via the dedicated
  // status-only action; deliberately OUTSIDE the dirty fingerprint
  const [workflowStatusId, setWorkflowStatusId] = useState<string>("");
  const [workflowBusy, startWorkflowBusy] = useTransition();
  const snapshotRef = useRef("");
  // section-level snapshots for the V2 "שונה" chips (guest card / stays card)
  const guestSnapRef = useRef("");
  const staysSnapRef = useRef("");
  const staysRef = useRef<HTMLElement | null>(null);
  const addPayRef = useRef<HTMLInputElement | null>(null);
  const staleToastRef = useRef(false);
  // when THIS panel last committed — realtime events inside the window below are
  // the echo of our own write, not a background change
  const selfSaveRef = useRef(0);
  // in-panel message composer (email | whatsapp) — a full-panel overlay; the
  // booking stays mounted underneath (no navigation, scroll preserved)
  const [composer, setComposer] = useState<null | "email" | "whatsapp">(null);

  const open = reservationId !== null;
  const reservationIdRef = useRef(reservationId);
  reservationIdRef.current = reservationId;

  // `force` = an explicit state change (initial load, post-cancel) that must
  // apply; a background realtime reload is dropped if the response is stale
  // (panel switched reservations) or the operator started editing mid-flight.
  const loadDetail = useCallback((id: string, opts?: { force?: boolean }) => {
    getReservationAction(id).then((res) => {
      if (reservationIdRef.current !== id) return;
      if (!opts?.force && dirtyRef.current) return;
      if (!res.success || !res.data) {
        setLoadError(res.success ? "הזמנה לא נמצאה" : res.error);
        return;
      }
      const d = res.data;
      setDetail(d);
      setWorkflowStatusId(d.workflow_status_id ?? "");
      const loadedGuest = {
        firstName: d.guest.first_name,
        lastName: d.guest.last_name,
        phone: d.guest.phone ?? "",
        email: d.guest.email ?? "",
        idNumber: d.guest.id_number ?? "",
      };
      setGuest(loadedGuest);
      setSourceId(d.source_id ?? "");
      // ONE mapping feeds both the live state and every snapshot — the dirty
      // fingerprint can never drift from the form (falsely-"dirty" openings
      // would trip the toolbar's save-first guard).
      const loadedStays: StayDraft[] = d.rooms.map((r) => ({
        key: newStayKey(),
        rrId: r.rrId,
        roomId: r.roomId,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        adults: r.adults,
        children: r.children,
        infants: r.infants,
        ratePerNight: r.ratePerNight,
        isManualRate: r.isManualRate,
        priceMode: r.priceMode,
        manualTotal: r.manualTotal,
        ratePlanId: r.ratePlanId,
        guestFirstName: r.guestFirstName ?? undefined,
        guestLastName: r.guestLastName ?? undefined,
        guestPhone: r.guestPhone ?? undefined,
      }));
      setStays(loadedStays);
      setDiscountMode(d.discount_mode);
      setDiscountValue(d.discount_value);
      setTaxExempt(d.tax_exempt);
      setAddPay(0);
      setMethod("");
      setCc(EMPTY_CARD);
      setCardMeta(d.card);
      // Card-entry MODE survives background refreshes. A realtime event may
      // reload a clean panel while the operator has just opened the manual
      // form (an empty draft is not "dirty", so the reload proceeds) — that
      // reload must not snap the section back to the imported card. Identity
      // changes reset the mode synchronously in the [reservationId] effect;
      // this force-path reset covers SAME-reservation explicit boundaries
      // (e.g. the post-cancel reload).
      if (opts?.force) setReplacingCard(false);
      setConfirmDiscard(false);
      setNotes(d.notes ?? "");
      setArrivalTime(d.expected_arrival_time ?? "");
      snapshotRef.current = editSnapshot(
        loadedGuest,
        d.source_id ?? "",
        loadedStays,
        { discountMode: d.discount_mode, discountValue: d.discount_value, taxExempt: d.tax_exempt },
        0,
        "",
        d.notes ?? "",
        d.expected_arrival_time ?? "",
        EMPTY_CARD,
      );
      guestSnapRef.current = JSON.stringify([loadedGuest, d.source_id ?? ""]);
      staysSnapRef.current = JSON.stringify(loadedStays, dropStayKey);
    });
  }, []);

  useEffect(() => {
    // Manual card-entry mode is scoped to ONE editor session on ONE
    // reservation. ANY identity change — open, switch to another reservation,
    // close — discards the mode and the sensitive manual draft SYNCHRONOUSLY,
    // before any in-flight response can render. (Resetting only inside the
    // async force-load response proved lossy: a dropped/failed load left the
    // stale mode behind, and the next same-reservation realtime reload — which
    // deliberately preserves the mode — painted a leaked blank manual form as
    // the INITIAL view of a different reservation.)
    setReplacingCard(false);
    setCc(EMPTY_CARD);
    if (!reservationId) {
      setDetail(null);
      return;
    }
    setDetail(null);
    setLoadError(null);
    setCancelOpen(false);
    staleToastRef.current = false;
    loadDetail(reservationId, { force: true });
  }, [reservationId, loadDetail]);

  const dirty =
    detail !== null &&
    editSnapshot(guest, sourceId, stays, { discountMode, discountValue, taxExempt }, addPay, method, notes, arrivalTime, cc) !==
      snapshotRef.current;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // per-section "שונה" chips (V2) — display only, never gate anything
  const guestDirty =
    detail !== null && JSON.stringify([guest, sourceId]) !== guestSnapRef.current;
  const stayDirty =
    detail !== null && JSON.stringify(stays, dropStayKey) !== staysSnapRef.current;

  // Live updates (D77 §6): when THIS reservation changes elsewhere (another
  // tab, an OTA revision, the worker) — reload a clean panel; a dirty editor
  // is never clobbered, it gets a one-time honest notice instead.
  useRealtimeEvent((event) => {
    if (!reservationId || event.reservationId !== reservationId) return;
    // OUR OWN save publishes this event, and the form is still dirty for the
    // instant between the commit and the panel closing — without this the
    // operator was told "your unsaved changes may conflict" right after a
    // successful save.
    if (Date.now() - selfSaveRef.current < SELF_EVENT_WINDOW_MS) return;
    if (dirtyRef.current) {
      if (!staleToastRef.current) {
        staleToastRef.current = true;
        toast.info("ההזמנה עודכנה ברקע — השינויים שלא נשמרו כאן עלולים להתנגש");
      }
      return;
    }
    loadDetail(reservationId);
  });

  // Escape / X / overlay click — dirty forms get an explicit discard
  // confirmation in the footer instead of silently losing changes
  const requestClose = () => {
    if (saving) return;
    if (dirty && !confirmDiscard) setConfirmDiscard(true);
    else onClose();
  };

  // The payment-method selector registers PAYMENTS (additionalPayment +
  // paymentMethod on save). Coupling to the card section is ONE-directional
  // (D108, רונן תלונה 7): choosing "כרטיס אשראי" when no usable card exists
  // (external_unavailable / fresh) ENTERS manual entry so the fields open for
  // typing immediately — the hidden toggle is no longer the only way in.
  // Choosing any other method never locks, hides, or wipes the card section,
  // and a stored card is never auto-replaced by a method click.

  const staysValid =
    stays.length > 0 &&
    stays.every((s) => s.roomId && s.checkIn && s.checkOut && s.checkOut > s.checkIn);
  // committed line total (D106): a stay whose price BASIS is unchanged shows
  // the SERVER-stored price_total (audit F-10 — never re-derived rate×nights);
  // manual figures are the operator's word; a re-based auto stay estimates
  // rate×nights until the save re-prices it.
  const lineTotalOf = (s: StayDraft): number => {
    const nights = s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0;
    if (s.priceMode === "manual_total" && s.manualTotal != null) return s.manualTotal;
    if ((s.priceMode === "manual_night" || (s.priceMode === undefined && s.isManualRate)) && s.ratePerNight != null)
      return Math.round(s.ratePerNight * nights * 100) / 100;
    const loaded = detail?.rooms.find((r) => r.rrId === s.rrId);
    const basisUnchanged =
      loaded != null &&
      loaded.roomId === s.roomId && loaded.checkIn === s.checkIn && loaded.checkOut === s.checkOut &&
      loaded.adults === s.adults && loaded.children === s.children && loaded.infants === s.infants &&
      loaded.ratePlanId === (s.ratePlanId ?? null) && loaded.priceMode === (s.priceMode ?? "auto");
    if (basisUnchanged) return loaded.priceTotal;
    return (s.ratePerNight ?? 0) * nights;
  };
  // THE single totals source (D106) — same pure module the server persists with
  const totals = computeReservationTotals(
    {
      stays: stays.map((s) => ({
        priceTotal: lineTotalOf(s),
        nights: s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0,
      })),
      roomsTotalOverride: detail?.rooms_total_override ?? null,
      discountMode,
      discountValue,
      extraCharges: detail?.extra_charges ?? 0,
      taxExempt,
      vatRate,
      currency: detail?.currency ?? "ILS",
    },
    { validate: false }, // live preview never throws; the server validates on save
  );
  const total = totals.grandTotal;
  const paidAfter = (detail?.paid_amount ?? 0) + addPay;

  // statusOverride serves the quick actions (e.g. בצע צ׳ק-אין) — same
  // validated action, same payload, just an explicit status. An ordinary
  // save sends NO status at all: the retired "סטטוס שהות" select was the
  // only manual writer, so the server keeps the stored lifecycle value.
  const save = (statusOverride?: (typeof EDITABLE_STATUSES)[number]) =>
    startSaving(async () => {
      if (!detail) return;
      selfSaveRef.current = Date.now();
      const res = await updateReservationAction({
        id: detail.id,
        guest: {
          firstName: guest.firstName.trim(),
          lastName: guest.lastName.trim(),
          phone: guest.phone.trim() || undefined,
          email: guest.email.trim() || undefined,
          idNumber: guest.idNumber.trim() || undefined,
        },
        sourceId: sourceId || null,
        status: statusOverride,
        rooms: stays.map((s) => ({
          rrId: s.rrId,
          roomId: s.roomId,
          checkIn: s.checkIn,
          checkOut: s.checkOut,
          adults: s.adults,
          children: s.children,
          infants: s.infants,
          // a stored manual price rides along; auto-priced stays never resend
          // a price (the server prices through the central engine)
          ratePerNight: s.isManualRate || s.priceMode === "manual_night" ? s.ratePerNight : undefined,
          isManualRate: s.priceMode ? s.priceMode === "manual_night" : s.isManualRate,
          priceMode: s.priceMode ?? (s.isManualRate ? "manual_night" : "auto"),
          manualTotal: s.priceMode === "manual_total" ? s.manualTotal : undefined,
          ratePlanId: s.ratePlanId ?? null,
          guestFirstName: s.guestFirstName || undefined,
          guestLastName: s.guestLastName || undefined,
          guestPhone: s.guestPhone || undefined,
        })),
        notes: notes.trim() || undefined,
        expectedArrivalTime: arrivalTime || null,
        discountMode,
        discountValue,
        taxExempt,
        additionalPayment: addPay || undefined,
        paymentMethod: method || undefined,
      });
      if (res.success) {
        toast.success("ההזמנה עודכנה");
        onClose();
      } else {
        toast.error(res.error);
      }
    });

  // workflow status — immediate, status-only save (never touches the stay)
  const applyWorkflowStatus = (nextId: string) => {
    if (!detail || !nextId || nextId === workflowStatusId) return;
    const prev = workflowStatusId;
    setWorkflowStatusId(nextId);
    startWorkflowBusy(async () => {
      const res = await setWorkflowStatusAction({
        reservationId: detail.id,
        workflowStatusId: nextId,
      });
      if (res.success) {
        toast.success("סטטוס הטיפול עודכן");
        setDetail((d) => (d ? { ...d, workflow_status_id: nextId } : d));
      } else {
        setWorkflowStatusId(prev);
        toast.error(res.error);
      }
    });
  };

  // Header toolbar actions operate on the SAVED booking only — unsaved edits
  // must not leak into a sent message, PDF or print (D53). Block with a Hebrew
  // save prompt while the form is dirty.
  const guardedToolbarAction = (fn: () => void) => {
    if (dirty) {
      toast.error("יש שינויים שלא נשמרו — שמור אותם לפני שליחה, הדפסה או הפקת PDF");
      return;
    }
    fn();
  };
  // Refresh only the read-only feeds (activity + payments) after a message send,
  // without touching the editable form fields.
  const refreshActivity = () => {
    if (!reservationId) return;
    getReservationAction(reservationId).then((res) => {
      if (res.success && res.data) {
        const fresh = res.data;
        setDetail((d) => (d ? { ...d, activity: fresh.activity, payments: fresh.payments } : d));
      }
    });
  };

  // ---- stored card (dedicated guarded actions, never the main save) ----
  const ccStateForSave = cardDraftState(cc);

  const saveCard = () =>
    startCardBusy(async () => {
      if (!detail || ccStateForSave !== "valid") return;
      setCardError(null);
      const exp = parseExpiry(cc.exp)!;
      const res = await saveReservationCardAction({
        reservationId: detail.id,
        holderName: cc.holder.trim(),
        holderIdNumber: cc.idNum || undefined,
        pan: normalizePan(cc.number),
        expMonth: exp.month,
        expYear: exp.year,
        cvv: cc.cvv || undefined,
        source: cc.source,
      });
      if (res.success && res.data) {
        // raw values are cleared; only masked metadata remains client-side
        setCc(EMPTY_CARD);
        setCardMeta(res.data);
        setReplacingCard(false);
        setCardError(null);
        toast.success("הכרטיס נשמר מוצפן");
      } else {
        const msg = res.success ? "שמירת הכרטיס נכשלה" : res.error;
        setCardError(msg);
        toast.error(msg);
      }
    });

  const deleteCard = () =>
    startCardBusy(async () => {
      if (!cardMeta) return;
      const res = await deleteReservationCardAction(cardMeta.id);
      if (res.success) {
        setCardMeta(null);
        setReplacingCard(false);
        toast.success("הכרטיס הוסר");
      } else {
        toast.error(res.error);
      }
    });

  // a cancelled reservation is HISTORY — every business field is read-only
  // (the cancellation banner + activity trail tell the story); the workflow
  // tag select below deliberately stays on plain canEdit.
  const canEditNow = canEdit && detail?.status !== "cancelled";
  const statusMeta = detail ? statusItems.find((s) => s.key === detail.status) : null;
  const guestDisplay = `${guest.firstName} ${guest.lastName}`.trim() || "—";
  const payState = paymentState(total, paidAfter);

  // The masked channel guarantee imported with an OTA booking (D86). It is NOT a
  // second card: it feeds the SAME canonical fields as a stored/manual card,
  // through resolveCardView inside the one card section. Only the stored card
  // outranks it.
  const guarantee = !cardMeta && detail?.ota ? detail.collection.guarantee : null;
  // the card section is shown whenever there is something to show — a read-only
  // viewer or a cancelled reservation still sees the imported details; the empty
  // entry form appears only for an operator who may actually save a card
  const showCardSection = Boolean(cardMeta || guarantee || (canSaveCard && canEditNow));
  // a card may be keyed in only with the permission, on a live reservation
  const canManageCard = canSaveCard && canEditNow;
  // External-channel reservation (channel-imported, or carrying an external
  // booking source per the ONE canonical channel mapping). Such a reservation
  // NEVER falls through to the editable fresh form — without card data it gets
  // the read-only "external_unavailable" state instead.
  const detailSource = detail ? bookingSources.find((s) => s.id === detail.source_id) : undefined;
  const externalReservation =
    Boolean(detail?.ota) || normalizeVisibleChannel(detailSource?.key ?? null) !== null;
  // the explicit section mode — the save action below is reachable only from
  // the two editable modes, never from a read-only external state
  const cardMode = resolveCardMode({
    stored: cardMeta,
    channel: guarantee,
    manualEntry: replacingCard,
    externalSource: externalReservation,
  });
  // canonical balance (D52 §7/§9): NOT floored — a negative balance is shown as a
  // customer credit, never as a zero balance. Formatted here, computed centrally.
  const bal = formatBalance(total, paidAfter);
  // §3.1 — the balance wears the SAME triplet text colour as the payment chip:
  // due = "לא שולם", settled = "שולם מלא", credit = the overpaid family.
  const BAL_COLOR = {
    due: paymentTriplet("unpaid").tx,
    settled: paymentTriplet("paid").tx,
    credit: paymentTriplet("overpaid").tx,
  } as const;

  return (
    <SidePanel
      open={open}
      onClose={requestClose}
      title="עריכת הזמנה"
      /* wide shell for the editor: 60% width (900–1200px), flat app-background
         body, no title icon. Typography/spacing are the canonical tokens — this
         panel has no scale of its own. */
      widthClassName="w-[60%] min-w-[min(900px,100%)] max-w-[1200px]"
      bodyClassName="bg-appbg p-0"
      subtitle={
        detail
          ? `נוצרה ${fmtDate(detail.created_at)}${
              detail.source_label ? ` · מקור: ${detail.source_label}` : ""
            } · עודכנה לאחרונה ${fmtDateTime(detail.updated_at)}`
          : "טוען…"
      }
      headerActions={
        detail ? (
          <BookingToolbar
            onEmail={() => guardedToolbarAction(() => setComposer("email"))}
            onWhatsApp={() => guardedToolbarAction(() => setComposer("whatsapp"))}
            onPdf={() =>
              guardedToolbarAction(() => window.open(`/api/reservations/${detail.id}/pdf`, "_blank", "noopener"))
            }
            onPrint={() =>
              guardedToolbarAction(() => window.open(`/reservations/${detail.id}/print`, "_blank", "noopener"))
            }
            onCancelReservation={
              canCancel && detail.status !== "cancelled" ? () => setCancelOpen(true) : undefined
            }
          />
        ) : undefined
      }
      overlay={
        detail && composer ? (
          <MessageComposer
            channel={composer}
            reservationId={detail.id}
            onClose={() => setComposer(null)}
            onSent={refreshActivity}
          />
        ) : detail && cancelOpen ? (
          <CancelReservationDialog
            detail={detail}
            guestName={guestDisplay}
            onClose={() => setCancelOpen(false)}
            onDone={() => {
              setCancelOpen(false);
              loadDetail(detail.id, { force: true });
            }}
          />
        ) : detail && reportAction ? (
          <BookingComReportDialog
            detail={detail}
            guestName={guestDisplay}
            action={reportAction}
            onClose={() => setReportAction(null)}
            onDone={() => {
              setReportAction(null);
              // the report stamps live on the reservation — reload so the chip
              // and the newly-unlocked cancel button reflect the truth
              loadDetail(detail.id, { force: true });
            }}
          />
        ) : null
      }
      headerChips={
        detail ? (
          <>
            <span className="chip chip-neutral ltr-num">#{detail.reservation_number}</span>
            {/* the tenant status colour family (tint bg / border / readable text),
                painted by the canonical chip — same language as the calendar pill */}
            {(() => {
              const t = statusTintPalette(statusMeta?.color);
              return (
                <span className="chip" style={{ background: t.bg, borderColor: t.bd, color: t.tx }}>
                  <span className="dot" style={{ background: t.bd }} />
                  {statusMeta?.label ?? detail.status}
                </span>
              );
            })()}
          </>
        ) : null
      }
      footer={
        detail ? (
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
               PRIMARY action is FIRST so it hugs the LEFT edge, "סגור" to its
               right; the destructive action is pushed to the far right. */
            <>
              {canEditNow && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving || !staysValid}
                  onClick={() => save()}
                >
                  <Icon name="save" size={20} />
                  {saving ? "שומר…" : "שמור שינויים"}
                </button>
              )}
              <button type="button" className="btn btn-tertiary" onClick={requestClose}>
                סגור
              </button>
              {dirty && (
                <span className="chip chip-approval">
                  <span className="dot" />
                  יש שינויים שלא נשמרו
                </span>
              )}
              <span className="flex-1" />
              {canCancel && detail.status !== "cancelled" && (
                <button type="button" className="btn btn-danger" onClick={() => setCancelOpen(true)}>
                  <Icon name="circle-slash" size={20} />
                  בטל הזמנה
                </button>
              )}
            </>
          )
        ) : undefined
      }
    >
      {loadError ? (
        <div className="grid h-40 place-items-center text-center">
          <div>
            <Icon name="warning" size={24} className="mx-auto mb-2 text-status-danger" />
            <p className="font-semibold text-ink">{loadError}</p>
          </div>
        </div>
      ) : !detail ? (
        <div className="bw-main" aria-busy="true">
          <div className="bw-col-main">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-40" />
            ))}
          </div>
          <div className="bw-col-side max-lg:hidden">
            <div className="skeleton h-72" />
          </div>
        </div>
      ) : (
        <div className="bw-main">
          <div className="bw-col-main">
            {/* cancellation history (D77 §7) — who/when/why, permanent record */}
            {detail.cancellation && (
              <BookingCard icon="circle-slash" title="ההזמנה בוטלה" tone="danger">
                <div className="bw-grid2">
                  <Field label="מועד הביטול">
                    <b className="text-sm text-ink">
                      {detail.cancellation.at ? fmtDateTime(detail.cancellation.at) : "—"}
                    </b>
                  </Field>
                  <Field label="בוטלה על ידי">
                    <b className="text-sm text-ink">
                      {CANCELLED_BY_LABEL[detail.cancellation.byType ?? ""] ??
                        detail.cancellation.byType ??
                        "—"}
                      {detail.cancellation.byUserName ? ` · ${detail.cancellation.byUserName}` : ""}
                    </b>
                  </Field>
                  <Field label="מקור הביטול">
                    <b className="text-sm text-ink">
                      {CANCEL_ORIGIN_LABEL[detail.cancellation.origin ?? ""] ??
                        detail.cancellation.origin ??
                        "—"}
                    </b>
                  </Field>
                  <Field label="סיבה">
                    <b className="text-sm text-ink">{detail.cancellation.reason ?? "—"}</b>
                  </Field>
                </div>
              </BookingCard>
            )}
            {/* honest pending-external-cancellation state (§9/§10) */}
            {detail.ota?.externalCancellationRequestedAt && detail.status !== "cancelled" && (
              <BookingCard tone="warn">
                <p className="text-sm font-bold text-ink">
                  נשלחה בקשת ביטול ל-Booking.com — ההזמנה תבוטל אוטומטית כשהערוץ יאשר. החדרים לא
                  שוחררו עדיין.
                </p>
              </BookingCard>
            )}
            {/* פעולות Booking.com (D96) — the three channel status reports.
                Renders itself away unless the booking really is a Booking.com
                booking with a Beds24 id and the operator holds
                reservations.channel_report. */}
            <BookingComReportsCard detail={detail} onOpen={setReportAction} />
            {/* guest. "סטטוס שהות" (the manual lifecycle select) is RETIRED —
                hidden product-wide and never editable; the lifecycle itself
                still changes only through the validated quick actions
                (check-in/out) and the cancellation flow. */}
            <BookingCard
              icon="employees"
              title="פרטי אורח"
              chip={
                guestDirty ? (
                  <span className="chip chip-approval">
                    <Icon name="edit" size={13.5} />
                    שונה
                  </span>
                ) : undefined
              }
            >
              <div className="bw-grid2">
                <Field label="שם פרטי" required>
                  <input className="field-input" value={guest.firstName} disabled={!canEditNow}
                    onChange={(e) => setGuest({ ...guest, firstName: e.target.value })} />
                </Field>
                <Field label="שם משפחה" required>
                  <input className="field-input" value={guest.lastName} disabled={!canEditNow}
                    onChange={(e) => setGuest({ ...guest, lastName: e.target.value })} />
                </Field>
                <Field label="טלפון">
                  <div className="bw-fld-wrap">
                    <Icon name="phone" size={17} className="bw-fi" />
                    <input className="field-input bw-ic ltr-num" dir="ltr" value={guest.phone} disabled={!canEditNow}
                      onChange={(e) => setGuest({ ...guest, phone: e.target.value })} />
                  </div>
                </Field>
                <Field label="אימייל">
                  <div className="bw-fld-wrap">
                    <Icon name="mail" size={17} className="bw-fi" />
                    <input className="field-input bw-ic" dir="ltr" type="email" value={guest.email} disabled={!canEditNow}
                      onChange={(e) => setGuest({ ...guest, email: e.target.value })} />
                  </div>
                </Field>
                <Field label="מקור הזמנה">
                  <select className="field-input" value={sourceId} disabled={!canEditNow} onChange={(e) => setSourceId(e.target.value)}>
                    <option value="">—</option>
                    {bookingSources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Field>
                {workflowStatuses.length > 0 && (
                  <Field label="סטטוס הזמנה" full>
                    {/* immediate status-only save — never revalidates the stay (§11).
                        D77.1: the select itself wears the status color family
                        (tint bg / color border / readable text) — same as the
                        calendar pill; no tiny dot. backgroundColor (not the
                        background shorthand) keeps the V2 chevron image alive. */}
                    <select
                      className="field-input"
                      style={(() => {
                        const t = statusTintPalette(
                          workflowStatuses.find((w) => w.id === workflowStatusId)?.color,
                        );
                        return {
                          backgroundColor: t.bg,
                          borderColor: t.bd,
                          color: t.tx,
                          fontWeight: 700,
                        };
                      })()}
                      value={workflowStatusId}
                      disabled={!canEdit || workflowBusy}
                      onChange={(e) => applyWorkflowStatus(e.target.value)}
                    >
                      {!workflowStatusId && <option value="">—</option>}
                      {workflowStatuses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
            </BookingCard>

            {/* stays */}
            <BookingCard
              sectionRef={staysRef}
              icon="rooms"
              title="שהות וחדרים"
              chip={
                stayDirty ? (
                  <span className="chip chip-approval">
                    <Icon name="edit" size={13.5} />
                    שונה
                  </span>
                ) : undefined
              }
            >
              <div className="flex flex-col gap-4">
                {stays.map((s, i) => (
                  <StayEditor
                    key={s.key}
                    index={i}
                    value={s}
                    excludeReservationId={detail.id}
                    disabled={!canEditNow}
                    onChange={(next) => canEditNow && setStays((all) => all.map((x) => (x.key === s.key ? next : x)))}
                    onRemove={
                      canEditNow && stays.length > 1
                        ? () => setStays((all) => all.filter((x) => x.key !== s.key))
                        : undefined
                    }
                  />
                ))}
                {canEditNow && (
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
                )}
              </div>
            </BookingCard>

            {/* pricing & payment */}
            <BookingCard icon="finance" title="תמחור ותשלום">
              {stays.map((s, i) => {
                const nights = s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0;
                const line = lineTotalOf(s);
                const mode: PriceMode = s.priceMode ?? (s.isManualRate ? "manual_night" : "auto");
                // V2 line label: real room number + type when the stay still
                // points at its loaded room; a swapped/new room falls back to
                // the ordinal (the parent doesn't hold the rooms lookup)
                const loadedRoom = s.rrId ? detail.rooms.find((r) => r.rrId === s.rrId) : undefined;
                const lineLabel =
                  loadedRoom && loadedRoom.roomId === s.roomId
                    ? `חדר ${loadedRoom.roomLabel}${loadedRoom.roomTypeName ? ` · ${loadedRoom.roomTypeName}` : ""}`
                    : `חדר ${i + 1}`;
                return (
                  <div key={s.key} className="bw-price-line">
                    <div>
                      <b>{lineLabel}</b>
                      <div className="bw-plr">
                        {ratePlans.length > 0 && canEditNow && (
                          /* changing the plan re-prices server-side on save */
                          <select
                            className="field-input w-40"
                            aria-label="תוכנית תעריף"
                            value={s.ratePlanId ?? ""}
                            onChange={(e) =>
                              setStays((all) =>
                                all.map((x) =>
                                  x.key === s.key ? { ...x, ratePlanId: e.target.value || null } : x,
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
                        <span className="text-xs text-muted">
                          <span className="ltr-num">{nights}</span> לילות
                        </span>
                      </div>
                      <div className="mt-2">
                        <StayPriceModeControls
                          mode={mode}
                          onMode={(m) =>
                            /* switching mode keeps entered values (SPEC rule 6);
                               back-to-auto re-prices server-side on save */
                            canEditNow &&
                            setStays((all) =>
                              all.map((x) =>
                                x.key === s.key
                                  ? { ...x, priceMode: m, isManualRate: m === "manual_night" }
                                  : x,
                              ),
                            )
                          }
                          nights={nights}
                          autoRate={s.ratePerNight ?? 0}
                          autoTotal={line}
                          ratePerNight={s.ratePerNight ?? null}
                          onRatePerNight={(v) =>
                            canEditNow &&
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
                            canEditNow &&
                            setStays((all) =>
                              all.map((x) =>
                                x.key === s.key
                                  ? { ...x, manualTotal: v, priceMode: "manual_total", isManualRate: false }
                                  : x,
                              ),
                            )
                          }
                          canPriceOverride={canEditNow}
                          disabled={!canEditNow}
                        />
                      </div>
                      {/* the length-of-stay tier this stay was SOLD with, read
                          from its stored snapshot — editing the tier later never
                          rewrites what a committed reservation says (D104) */}
                      {loadedRoom?.pricingSnapshot?.losDiscount && (
                        <p className="mt-1.5 text-sm font-semibold text-status-success">
                          {loadedRoom.pricingSnapshot.losDiscount.explanation}
                        </p>
                      )}
                      {/* why there is NO tier on a weekly/monthly plan (D105) */}
                      {!loadedRoom?.pricingSnapshot?.losDiscount && mode === "auto" &&
                        ratePlans.find((p) => p.id === s.ratePlanId)?.plan_kind === "derived_percentage" && (
                        <p className="mt-1.5 text-xs text-muted">
                          תוכנית זו מגלמת הנחת שהייה — מדרגות הנחת LOS אינן נערמות עליה
                        </p>
                      )}
                    </div>
                    <b className="ltr-num">₪{Math.round(line).toLocaleString()}</b>
                  </div>
                );
              })}
              {detail.extra_charges > 0 && (
                <div className="bw-price-line">
                  <span className="bw-plr">חיובים נוספים</span>
                  <b className="ltr-num">₪{detail.extra_charges.toLocaleString()}</b>
                </div>
              )}
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
                  disabled={!canEditNow}
                />
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
                onToggle={(v) => canEditNow && setTaxExempt(v)}
                disabled={!canEditNow}
              />
              <div className="bw-price-total">
                <span>סה״כ לתשלום</span>
                <span className="bw-amt ltr-num">₪{total.toLocaleString()}</span>
              </div>

              {/* payment-state chips (V2 .paychip) — a DISPLAY of the derived
                  ledger state (paymentState). The actionable chips edit only
                  the additional-payment DRAFT (a real field); recorded ledger
                  payments are never reduced from here. */}
              <div className="mt-4 flex flex-wrap gap-2.5">
                <PayChip
                  state="unpaid"
                  label="לא שולם"
                  on={payState === "unpaid"}
                  disabled={!canEditNow || (detail.paid_amount ?? 0) > 0}
                  title={
                    (detail.paid_amount ?? 0) > 0
                      ? "תשלומים שנרשמו ביומן התשלומים אינם ניתנים לביטול מכאן"
                      : undefined
                  }
                  onClick={() => setAddPay(0)}
                />
                <PayChip
                  state="partial"
                  label="שולם חלקית"
                  on={payState === "partial"}
                  disabled={!canEditNow}
                  onClick={() => addPayRef.current?.focus()}
                />
                <PayChip
                  state="paid"
                  label="שולם מלא"
                  on={payState === "paid"}
                  disabled={!canEditNow}
                  onClick={() => setAddPay(Math.max(0, Math.round(total - (detail.paid_amount ?? 0))))}
                />
                {payState === "overpaid" && (
                  <PayChip state="overpaid" label="שולם ביתר" on disabled />
                )}
              </div>

              {/* payment-ADJUSTMENT row (method / additional payment / discount).
                  Hidden — not disabled — while the operator is explicitly keying
                  a card in (replacingCard): during manual card entry only the
                  card-storage workflow is visible, so two payment interfaces
                  never stack. The values live in panel state (method/addPay/
                  discount), so returning restores them intact. */}
              {canEditNow && !replacingCard && (
                <div className="bw-grid3 mt-4">
                  <Field label="אמצעי תשלום">
                    <select
                      className="field-input"
                      value={method}
                      onChange={(e) => {
                        setMethod(e.target.value);
                        // D108 — credit card opens the card fields for typing
                        // when nothing usable is stored; never the reverse
                        if (e.target.value === "credit_card" && !cardMeta && !guarantee && canManageCard) {
                          setReplacingCard(true);
                        }
                      }}
                    >
                      <option value="">בחירה…</option>
                      {paymentMethods.map((m) => (
                        <option key={m.id} value={m.key}>{m.label}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="תשלום נוסף (₪)">
                    <input ref={addPayRef} type="number" min={0} className="field-input ltr-num" value={addPay || ""}
                      placeholder="0" onChange={(e) => setAddPay(Math.max(0, Number(e.target.value) || 0))} />
                  </Field>
                </div>
              )}
              {/* ---- channel collection metadata (D77 §13/§14, D86): who
                   collects, which method, the channel's own reservation code.
                   NO card data lives here — brand/number/expiry/holder belong to
                   the one card section below, and nowhere else. ---- */}
              {detail.ota && (
                <div className="bw-metabox">
                  <div className="bw-cc-top">
                    <Icon name="finance" size={20} />
                    גבייה מהערוץ
                  </div>
                  <div className="bw-grid2">
                    {/* both numbers, separately (D80 §2): GuestHub's internal
                        number is never replaced by the OTA's */}
                    <Field label="מספר הזמנה ב-GuestHub">
                      <b className="ltr-num text-end text-sm text-ink">#{detail.reservation_number}</b>
                    </Field>
                    <Field label={otaCodeLabel(detail.ota.otaName)}>
                      <b className="ltr-num text-end text-sm text-ink">
                        {detail.ota.otaReservationCode ?? "—"}
                      </b>
                    </Field>
                    {/* honest CVC state (D110): the generic "לא התקבל" is
                        replaced by the MEASURED reason — Ronen must know WHY.
                        Probe 2026-07-26 (read-only, this account's token):
                        GET /v2/bookings returns no card fields and empty
                        stripeToken/pcibookingToken on every booking; the
                        import requests no card endpoint (none is public).
                        Card data for this account lives only in the Beds24
                        dashboard behind its card-access permission. */}
                    <Field label="קוד סודי מהערוץ">
                      <b className="text-sm text-muted">
                        {cardMeta?.source === "channel"
                          ? "הערוץ העביר כרטיס ללא קוד סודי — CVC אינו נמסר ב-API של Beds24; ניתן להזין ידנית בכרטיס האשראי למטה"
                          : "Beds24 אינו מעביר פרטי כרטיס וקוד סודי ב-API לחשבון זה (נמדד 26/07/2026) — הצפייה נעשית בלוח Beds24 בהרשאת כרטיסים, או בהזנה ידנית למטה"}
                      </b>
                    </Field>
                    <Field label="אמצעי תשלום">
                      <b className="text-sm text-ink">
                        {detail.collection.paymentType
                          ? PAYMENT_TYPE_LABEL[detail.collection.paymentType] ??
                            detail.collection.paymentType
                          : "—"}
                      </b>
                    </Field>
                    <Field label="גבייה">
                      <b className="text-sm text-ink">
                        {detail.collection.collect
                          ? COLLECT_OWNER_LABEL[detail.collection.collect] ??
                            detail.collection.collect
                          : "—"}
                      </b>
                    </Field>
                    <Field label="מצב">
                      <b className="text-sm text-ink">
                        {COLLECTION_LABEL[detail.collection.state]}
                      </b>
                    </Field>
                    <Field label="תשלום">
                      <PaymentBadge state={payState} />
                    </Field>
                  </div>
                </div>
              )}
              {/* ---- THE credit-card section (D86) — one interface for every
                   source: the vaulted card (masked, audited reveal), the masked
                   channel guarantee, manual entry, or the empty state. Card
                   entry is governed by the section's own mode; the payment-
                   method selector above additionally OPENS manual entry when
                   "כרטיס אשראי" is chosen with nothing stored (D108) — it
                   never locks or hides these fields. ---- */}
              {showCardSection && (
                <>
                  {cardError && (
                    <p role="alert" className="mb-2 rounded-xl bg-status-danger-050 px-4 py-2.5 text-sm font-semibold text-status-danger">
                      שמירת הכרטיס נכשלה: {cardError} — הפרטים שהוזנו לא נשמרו
                    </p>
                  )}
                  <CardFields
                    value={cc}
                    onChange={setCc}
                    chargeAmount={Math.max(0, total - paidAfter)}
                    stored={cardMeta}
                    channel={guarantee}
                    channelName={
                      otaDisplayName(detail.ota?.otaName ?? null) ??
                      detail.ota?.otaName ??
                      (externalReservation ? detailSource?.label ?? null : null)
                    }
                    stateLabel={detail.ota ? COLLECTION_LABEL[detail.collection.state] : null}
                    manualEntry={replacingCard}
                    externalSource={externalReservation}
                    onToggleManual={
                      canManageCard
                        ? (manual) => {
                            setReplacingCard(manual);
                            // בהזנה ידנית — שם בעל הכרטיס מתמלא אוטומטית משם
                            // האורח (ניתן לעריכה); ביציאה — ניקוי הטיוטה
                            setCc(
                              manual
                                ? {
                                    ...EMPTY_CARD,
                                    holder: `${guest.firstName} ${guest.lastName}`.trim(),
                                  }
                                : EMPTY_CARD,
                            );
                          }
                        : undefined
                    }
                    canReveal={canRevealCard}
                    canManage={canManageCard}
                    canCharge={canChargeCard}
                    canRecordPayment={canChargeCard && canEditNow}
                    reservationId={detail.id}
                    onDelete={deleteCard}
                    onPaymentRecorded={(p) =>
                      setDetail((d) =>
                        d
                          ? { ...d, paid_amount: p.paid, balance: p.balance, payments: [p.payment, ...d.payments] }
                          : d,
                      )
                    }
                    deleting={cardBusy}
                  />
                  {/* the guarded save action — only reachable from the two
                      EDITABLE modes (explicit manual replacement / genuinely
                      fresh direct entry); the read-only external_unavailable
                      state never renders it */}
                  {canManageCard && (cardMode === "manual" || cardMode === "fresh") && (
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={cardBusy || ccStateForSave !== "valid"}
                        onClick={saveCard}
                      >
                        <Icon name="check" size={20} />
                        {cardBusy ? "שומר…" : "שמירת כרטיס"}
                      </button>
                    </div>
                  )}
                </>
              )}
              {/* balance boxes (V2 .balance/.bal-box) — canonical formatBalance:
                  a negative balance shows as customer credit, never floored */}
              <div className="bw-grid3 mt-4">
                <div className="bw-bal">
                  <p className="bw-bal-l">סה״כ</p>
                  <p className="bw-bal-v ltr-num">₪{total.toLocaleString()}</p>
                </div>
                <div className="bw-bal">
                  <p className="bw-bal-l">שולם</p>
                  <p className="bw-bal-v ltr-num" style={{ color: BAL_COLOR.settled }}>
                    ₪{paidAfter.toLocaleString()}
                  </p>
                </div>
                <div className="bw-bal">
                  <p className="bw-bal-l">{bal.kind === "credit" ? "זיכוי ללקוח" : "יתרה לתשלום"}</p>
                  <p className="bw-bal-v ltr-num" style={{ color: BAL_COLOR[bal.kind] }}>
                    {bal.kind === "credit" ? "-" : ""}₪{Math.round(bal.amount).toLocaleString()}
                  </p>
                </div>
              </div>

              {detail.payments.length > 0 && (
                <ul className="mt-5 flex flex-col gap-2 border-t border-line pt-4">
                  {detail.payments.map((p) => (
                    <li key={p.id} className="bw-sum-line">
                      <span>
                        התקבל תשלום ₪{p.amount.toLocaleString()}
                        {p.method ? ` (${paymentMethods.find((m) => m.key === p.method)?.label ?? p.method})` : ""}
                      </span>
                      <span className="ltr-num">{p.paid_at ? p.paid_at.slice(0, 16).replace("T", " ") : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </BookingCard>

            {/* notes + expected arrival time — separate fields; the arrival
                time is never folded into the notes text (D80 §6). Notes sit
                ABOVE the cancellation policy (complaint 11 / SPEC step 4). */}
            <BookingCard icon="documents" title="הערות להזמנה">
              <div className="bw-grid2 mb-4">
                <Field label="שעת צ'ק-אין צפויה">
                  <input
                    type="time"
                    className="field-input ltr-num"
                    dir="ltr"
                    value={arrivalTime}
                    disabled={!canEditNow}
                    onChange={(e) => setArrivalTime(e.target.value)}
                  />
                  {detail.expected_arrival_time_source && (
                    <span className="field-hint">
                      {detail.expected_arrival_time_source === "ota"
                        ? `התקבל מ-${detail.ota?.otaName ?? "הערוץ"}`
                        : "עודכן ידנית"}
                    </span>
                  )}
                </Field>
              </div>
              {/* enlarged notes — ~2× a standard multiline field, per the
                  approved layout; do not shrink back */}
              <textarea className="field-input min-h-[184px]" value={notes} disabled={!canEditNow}
                placeholder="בקשות מיוחדות…" onChange={(e) => setNotes(e.target.value)} />
            </BookingCard>

            {/* cancellation policy — the immutable AT-BOOKING snapshot (034).
                Displayed from the reservation itself; a later edit to the
                Settings template never changes what is shown here. */}
            {detail.cancellation_policy && (
              <BookingCard icon="documents" title="מדיניות ביטול (בעת ההזמנה)">
                <CancellationSnapshotView snap={detail.cancellation_policy} />
              </BookingCard>
            )}
          </div>

          {/* ---- sidebar: summary + activity (reference) ---- */}
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
                    <p className="bw-sum-gsrc truncate">
                      <bdi>{detail.source_label ? `${detail.source_label} · ` : ""}</bdi>
                      <bdi className="ltr-num">#{detail.reservation_number}</bdi>
                    </p>
                  </div>
                </div>
                <div className="bw-sum-sec">
                  {detail.rooms.map((r) => (
                    <div key={r.rrId} className="bw-sum-room">
                      <div className="bw-sum-rt">
                        <span>
                          חדר {r.roomLabel}
                          {r.roomTypeName ? ` · ${r.roomTypeName}` : ""}
                        </span>
                        <span className="bw-p ltr-num">
                          ₪{Math.round(r.priceTotal).toLocaleString()}
                        </span>
                      </div>
                      <div className="bw-sum-rd">
                        <Icon name="calendar" size={13.5} />
                        <bdi className="ltr-num">
                          {formatFullDate(r.checkIn)} – {formatFullDate(r.checkOut)}
                        </bdi>
                        <Icon name="moon" size={13.5} />
                        <span>{nightsBetween(r.checkIn, r.checkOut)} ל׳</span>
                        <Icon name="users-round" size={13.5} />
                        <span className="ltr-num">{r.adults + r.children + r.infants}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="bw-sum-sec">
                  <div className="bw-sum-line">
                    <span>לילות סה״כ</span>
                    <span className="ltr-num">
                      {detail.rooms.reduce((n, r) => n + nightsBetween(r.checkIn, r.checkOut), 0)}
                    </span>
                  </div>
                  <div className="bw-sum-line">
                    <span>אורחים</span>
                    <span className="ltr-num">
                      {detail.rooms.reduce((n, r) => n + r.adults + r.children + r.infants, 0)}
                    </span>
                  </div>
                </div>
                <div className="bw-sum-total">
                  <span className="bw-l">סה״כ</span>
                  <span className="bw-v ltr-num">₪{total.toLocaleString()}</span>
                </div>
              </div>
            </div>

            {/* quick actions (V2 פעולות מהירות card) — only actions the system
                truly supports: check-in/out via the same validated save path,
                a real booking-confirmation send (the D53 composer), and
                jumping to the room editor. */}
            {canEditNow && ["confirmed", "draft", "checked_in"].includes(detail.status) && (
              <div className="card">
                <div className="card-hd">
                  <span className="bw-hi">
                    <Icon name="automations" size={17} />
                  </span>
                  פעולות מהירות
                </div>
                <div className="card-bd bw-qa">
                  {detail.status === "checked_in" ? (
                    /* same validated save path — check-out never touches payment */
                    <button
                      type="button"
                      className="btn btn-secondary bw-qa-btn qg"
                      disabled={saving || !staysValid}
                      onClick={() => save("checked_out")}
                    >
                      <Icon name="logout" size={20} />
                      בצע צ׳ק-אאוט
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary bw-qa-btn qg"
                      disabled={saving || !staysValid}
                      onClick={() => save("checked_in")}
                    >
                      <Icon name="login" size={20} />
                      בצע צ׳ק-אין
                    </button>
                  )}
                  {/* the reference's "שלח אישור הזמנה" action is deliberately
                      NOT rendered here — this pass is a visual refactor; the
                      header toolbar already owns the real messaging actions */}
                  <button
                    type="button"
                    className="btn btn-secondary bw-qa-btn"
                    onClick={() => staysRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  >
                    <Icon name="refresh" size={20} />
                    העבר לחדר אחר
                  </button>
                </div>
              </div>
            )}

            {detail.activity.length > 0 && (
              <div className="card">
                <div className="card-hd">
                  <span className="bw-hi">
                    <Icon name="attendance" size={17} />
                  </span>
                  יומן פעילות
                </div>
                <div className="card-bd bw-log">
                  {detail.activity.map((a, i) => (
                    <div key={i} className="bw-log-i">
                      <span className="bw-log-d">
                        <Icon name={ACTIVITY_ICON[a.action] ?? "edit"} size={13.5} />
                      </span>
                      <div className="min-w-0">
                        <div className="bw-log-t">{ACTIVITY_LABEL[a.action] ?? a.action}</div>
                        <div className="bw-log-s">
                          <span className="ltr-num">{a.created_at.slice(0, 16).replace("T", " ")}</span>
                          {a.user_name ? ` · ${a.user_name}` : " · מערכת"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </SidePanel>
  );
}

// The reservation's at-booking cancellation terms (034) — pure display of the
// stored snapshot. Template sources show the copied title + tiers; the OTA
// source shows the imported text/penalties verbatim. Never re-reads Settings.
export function CancellationSnapshotView({
  snap,
}: {
  snap: NonNullable<ReservationDetail["cancellation_policy"]>;
}) {
  const sourceLine =
    snap.source === "ota"
      ? `התקבל מ-${snap.ota?.ota_name ?? "הערוץ"} יחד עם ההזמנה`
      : snap.source === "rate_plan"
        ? "מתבנית המדיניות של תוכנית המחיר שנבחרה"
        : "תבנית ברירת המחדל של הנכס";
  return (
    <div className="flex flex-col gap-2">
      {snap.policy && (
        <>
          <b className="text-sm text-ink">{snap.policy.public_title}</b>
          {snap.policy.guest_description && (
            <p className="text-sm text-muted">{snap.policy.guest_description}</p>
          )}
          {snap.policy.tiers.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm text-ink">
              {snap.policy.tiers.map((t, i) => (
                <li key={i}>· {describeCancellationTier(t)}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {snap.ota && (
        <>
          {snap.ota.policies_text && (
            <p className="whitespace-pre-wrap text-sm text-ink">{snap.ota.policies_text}</p>
          )}
          {snap.ota.cancel_penalties.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm text-ink">
              {snap.ota.cancel_penalties.map((p, i) => (
                <li key={i}>
                  · {p.from ? `החל מ-${fmtDate(p.from)}` : "בכל שלב"}: דמי ביטול{" "}
                  <b className="ltr-num">
                    {p.amount ?? "—"} {p.currency ?? ""}
                  </b>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <span className="field-hint">
        {sourceLine} · תועד בעת ההזמנה (<bdi className="ltr-num">{fmtDate(snap.captured_at)}</bdi>) —
        עדכון עתידי של התבניות בהגדרות לא ישנה הזמנה קיימת
      </span>
    </div>
  );
}

// OTA-specific label for the channel's own reservation number (D80 §2)
// The channel's stored name is a slug ("BookingCom"); staff read the brand. ONE
// mapping serves both the OTA-number label and the card section's origin line.
const OTA_DISPLAY_NAME: readonly (readonly [RegExp, string])[] = [
  [/booking/, "Booking.com"],
  [/airbnb/, "Airbnb"],
  [/expedia/, "Expedia"],
];

function otaDisplayName(otaName: string | null): string | null {
  const n = (otaName ?? "").toLowerCase();
  return OTA_DISPLAY_NAME.find(([re]) => re.test(n))?.[1] ?? null;
}

function otaCodeLabel(otaName: string | null): string {
  const name = otaDisplayName(otaName);
  return name ? `מספר הזמנה ב-${name}` : "מספר הזמנה בערוץ (OTA)";
}

function fmtDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}
function fmtDateTime(iso: string): string {
  return `${fmtDate(iso)} ${iso.slice(11, 16)}`;
}

const CANCELLED_BY_LABEL: Record<string, string> = {
  guest: "האורח",
  operator: "צוות המלון",
  ota: "הערוץ (OTA)",
  system: "המערכת",
  unknown: "לא ידוע",
};

const CANCEL_ORIGIN_LABEL: Record<string, string> = {
  guest_booking_page: "עמוד ההזמנה של האורח",
  operator_direct_booking: "ביטול ישיר במלון",
  ota_revision: "עדכון מהערוץ",
  booking_com: "Booking.com",
  expedia: "Expedia",
  invalid_card: "כרטיס לא תקין",
  no_show: "אי-הגעה",
  external: "גורם חיצוני",
  system: "מערכת",
};

// timeline glyph per activity type (V2 יומן פעילות)
const ACTIVITY_ICON: Record<string, IconName> = {
  create: "plus",
  update: "edit",
  cancel: "circle-slash",
  reschedule: "refresh",
  channel_import_create: "channels",
  channel_import_update: "channels",
  channel_import_cancel: "circle-slash",
  workflow_status_change: "check-circle",
  ota_invalid_card_report: "warning",
  ota_no_show_report: "warning",
  ota_cancel_due_invalid_card: "circle-slash",
  external_change_approve: "check",
  external_change_reject: "circle-slash",
  card_save: "credit-card",
  card_replace: "credit-card",
  card_reveal: "eye",
  card_reveal_denied: "lock",
  card_charge_attempt: "finance",
  card_import_channel: "credit-card",
  card_delete: "trash",
  payment_external_record: "finance",
  email_sent: "mail",
  email_failed: "warning",
  whatsapp_sent: "whatsapp",
  whatsapp_failed: "warning",
  pdf_generated: "download",
  print: "printer",
};

const ACTIVITY_LABEL: Record<string, string> = {
  create: "ההזמנה נוצרה",
  update: "ההזמנה עודכנה",
  cancel: "ההזמנה בוטלה",
  reschedule: "חדר / תאריכים עודכנו",
  channel_import_create: "ההזמנה התקבלה מהערוץ",
  channel_import_update: "ההזמנה עודכנה מהערוץ",
  channel_import_cancel: "ההזמנה בוטלה על ידי הערוץ",
  workflow_status_change: "סטטוס ההזמנה עודכן",
  ota_invalid_card_report: "דווח לערוץ על כרטיס לא תקין",
  ota_no_show_report: "דווח לערוץ על אי-הגעה",
  ota_cancel_due_invalid_card: "בקשת ביטול בגין כרטיס לא תקין",
  external_change_approve: "אושר שינוי שהגיע מהערוץ",
  external_change_reject: "נדחה שינוי שהגיע מהערוץ",
  card_save: "כרטיס אשראי נשמר",
  card_replace: "כרטיס אשראי הוחלף",
  card_reveal: "מספר כרטיס נחשף",
  card_reveal_denied: "ניסיון חשיפת כרטיס נדחה",
  card_charge_attempt: "ניסיון סליקת כרטיס",
  card_import_channel: "כרטיס יובא מערוץ",
  card_delete: "כרטיס אשראי הוסר",
  payment_external_record: "נרשם תשלום שבוצע חיצונית",
  email_sent: "נשלח מייל לאורח",
  email_failed: "שליחת מייל נכשלה",
  whatsapp_sent: "נשלחה הודעת WhatsApp",
  whatsapp_failed: "שליחת WhatsApp נכשלה",
  pdf_generated: "הופק PDF להזמנה",
  print: "ההזמנה נשלחה להדפסה",
};

// dirty-state fingerprint of everything the user can edit (stay "key"
// fields are random per load, so the replacer drops them). The reservation
// lifecycle status is deliberately NOT part of the fingerprint — the manual
// "סטטוס שהות" field was retired (hidden product-wide); status changes flow
// only through the validated quick actions (check-in/out) and cancellation.
function dropStayKey(k: string, v: unknown): unknown {
  return k === "key" ? undefined : v;
}
function editSnapshot(
  guest: { firstName: string; lastName: string; phone: string; email: string; idNumber: string },
  sourceId: string,
  stays: (StayDraft | Omit<StayDraft, "key">)[],
  pricing: { discountMode: string; discountValue: number; taxExempt: boolean },
  addPay: number,
  method: string,
  notes: string,
  arrivalTime: string,
  cc: CardDraft,
): string {
  return JSON.stringify(
    [guest, sourceId, stays, pricing, addPay, method, notes, arrivalTime, cc],
    dropStayKey,
  );
}
