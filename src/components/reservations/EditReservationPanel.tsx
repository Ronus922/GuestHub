"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { SidePanel } from "@/components/ui/SidePanel";
import { Icon, type IconName } from "@/components/shared/Icon";
import { formatFullDate, nightsBetween } from "@/lib/dates";
import { paymentState, formatBalance } from "@/lib/inventory-rules";
import { formatVatRate, includedVatAmount } from "@/lib/vat";
import { normalizePan, parseExpiry } from "@/lib/card-rules";
import { describeCancellationTier } from "@/lib/commercial/cancellation";
import { statusTintPalette } from "@/lib/colors";
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
import {
  saveReservationCardAction,
  deleteReservationCardAction,
} from "@/app/(dashboard)/reservations/card-actions";
import { EDITABLE_STATUSES } from "@/lib/validation/reservation";
import { StayEditor, newStayKey, type StayDraft } from "./StayEditor";
import { CardFields, EMPTY_CARD, cardDraftState, type CardDraft } from "./CardFields";
import { PaymentBadge, CardTitle, Field } from "./BookingPanel";
import { BookingToolbar, MessageComposer } from "./BookingActions";
import type { LookupItem } from "@/app/(dashboard)/calendar/CalendarScreen";

// עריכת הזמנה — the single reservation detail/edit flow the calendar opens
// (ref/screens/edit-booking-modal.png) inside the site-wide SIDE PANEL
// shell (D41): sectioned form, summary + activity sidebar, sticky header
// and action footer, the calendar stays mounted and visible behind it.
// Preserves every reservation room, per-room guests, pricing, status and
// payments (§F). The stored-card section shows masked metadata only;
// full-PAN reveal is explicit, permission-guarded and audited.
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
  ratePlans: { id: string; name: string; code: string }[];
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
  const [discount, setDiscount] = useState(0);
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
  const [cardBusy, startCardBusy] = useTransition();
  const [saving, startSaving] = useTransition();
  const [cancelOpen, setCancelOpen] = useState(false);
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
        ratePlanId: r.ratePlanId,
        guestFirstName: r.guestFirstName ?? undefined,
        guestLastName: r.guestLastName ?? undefined,
        guestPhone: r.guestPhone ?? undefined,
      }));
      setStays(loadedStays);
      setDiscount(d.discount_amount);
      setAddPay(0);
      setMethod("");
      setCc(EMPTY_CARD);
      setCardMeta(d.card);
      setReplacingCard(false);
      setConfirmDiscard(false);
      setNotes(d.notes ?? "");
      setArrivalTime(d.expected_arrival_time ?? "");
      snapshotRef.current = editSnapshot(
        loadedGuest,
        d.source_id ?? "",
        loadedStays,
        d.discount_amount,
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
    editSnapshot(guest, sourceId, stays, discount, addPay, method, notes, arrivalTime, cc) !==
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

  // §15 — switching the payment method away from credit card destroys any
  // unsaved sensitive draft (a stored/tokenized card is NOT touched)
  useEffect(() => {
    if (method !== "credit_card") setCc(EMPTY_CARD);
  }, [method]);

  const staysValid =
    stays.length > 0 &&
    stays.every((s) => s.roomId && s.checkIn && s.checkOut && s.checkOut > s.checkIn);
  const roomsTotal = stays.reduce(
    (sum, s) =>
      sum +
      (s.ratePerNight ?? 0) * (s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0),
    0,
  );
  const total = Math.max(0, roomsTotal - discount + (detail?.extra_charges ?? 0));
  const paidAfter = (detail?.paid_amount ?? 0) + addPay;

  // statusOverride serves the quick actions (e.g. בצע צ׳ק-אין) — same
  // validated action, same payload, just an explicit status. An ordinary
  // save sends NO status at all: the retired "סטטוס שהות" select was the
  // only manual writer, so the server keeps the stored lifecycle value.
  const save = (statusOverride?: (typeof EDITABLE_STATUSES)[number]) =>
    startSaving(async () => {
      if (!detail) return;
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
          // a stored manual rate rides along; auto-priced stays never resend a
          // price (the server prices through the central engine)
          ratePerNight: s.isManualRate ? s.ratePerNight : undefined,
          ratePlanId: s.ratePlanId ?? null,
          guestFirstName: s.guestFirstName || undefined,
          guestLastName: s.guestLastName || undefined,
          guestPhone: s.guestPhone || undefined,
        })),
        notes: notes.trim() || undefined,
        expectedArrivalTime: arrivalTime || null,
        discountAmount: discount,
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
      const exp = parseExpiry(cc.exp)!;
      const res = await saveReservationCardAction({
        reservationId: detail.id,
        holderName: cc.holder.trim(),
        holderIdNumber: cc.idNum || undefined,
        pan: normalizePan(cc.number),
        expMonth: exp.month,
        expYear: exp.year,
        source: cc.source,
        billingNotes: cc.billingNotes.trim() || undefined,
      });
      if (res.success && res.data) {
        // raw values are cleared; only masked metadata remains client-side
        setCc(EMPTY_CARD);
        setCardMeta(res.data);
        setReplacingCard(false);
        toast.success("הכרטיס נשמר מוצפן");
      } else {
        toast.error(res.success ? "שמירת הכרטיס נכשלה" : res.error);
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
  // canonical balance (D52 §7/§9): NOT floored — a negative balance is shown as a
  // customer credit, never as a zero balance. Formatted here, computed centrally.
  const bal = formatBalance(total, paidAfter);
  const BAL_COLOR = { due: "#B4231F", settled: "#15803D", credit: "#0B6E7A" } as const;

  return (
    <SidePanel
      open={open}
      onClose={requestClose}
      title="עריכת הזמנה"
      /* V2 shell (this editor ONLY): opt-in chrome + .bw-v2 token scope,
         60% width (900–1200px), flat #F1F3F8 body, no title icon */
      v2
      widthClassName="w-[60%] min-w-[min(900px,100%)] max-w-[1200px]"
      bodyClassName="bg-[#F1F3F8] p-0"
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
        ) : null
      }
      headerChips={
        detail ? (
          <>
            <span className="bw-hd-num" dir="ltr">
              #{detail.reservation_number}
            </span>
            {/* V2 .st-badge — the status color family (tint bg / readable text) */}
            <span
              className="bw-st-badge"
              style={(() => {
                const t = statusTintPalette(statusMeta?.color);
                return { background: t.bg, color: t.tx };
              })()}
            >
              <span className="bw-d" style={{ background: statusMeta?.color ?? "#6B7385" }} />
              {statusMeta?.label ?? detail.status}
            </span>
          </>
        ) : null
      }
      footer={
        detail ? (
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
              {canCancel && detail.status !== "cancelled" ? (
                <button type="button" className="bw-btn bw-btn-danger" onClick={() => setCancelOpen(true)}>
                  <Icon name="circle-slash" size={16} />
                  בטל הזמנה
                </button>
              ) : (
                <span />
              )}
              <span className="flex-1" />
              {dirty && (
                <span className="bw-dirty">
                  <Icon name="warning" size={16} />
                  יש שינויים שלא נשמרו
                </span>
              )}
              <button type="button" className="bw-btn bw-btn-ghost" onClick={requestClose}>
                סגור
              </button>
              {canEditNow && (
                <button
                  type="button"
                  className="bw-btn bw-btn-primary"
                  disabled={saving || !staysValid}
                  onClick={() => save()}
                >
                  <Icon name="save" size={16} />
                  {saving ? "שומר…" : "שמור שינויים"}
                </button>
              )}
            </div>
          )
        ) : undefined
      }
    >
      {loadError ? (
        <div className="grid h-40 place-items-center text-center">
          <div>
            <Icon name="warning" size={28} className="mx-auto mb-2 text-status-danger" />
            <p className="font-semibold text-ink">{loadError}</p>
          </div>
        </div>
      ) : !detail ? (
        <div className="bw-main" aria-busy="true">
          <div className="bw-col-main">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-40 animate-pulse rounded-2xl bg-white/70" />
            ))}
          </div>
          <div className="bw-col-side max-lg:hidden">
            <div className="h-72 animate-pulse rounded-2xl bg-white/70" />
          </div>
        </div>
      ) : (
        <div className="bw-main">
          <div className="bw-col-main">
            {/* cancellation history (D77 §7) — who/when/why, permanent record */}
            {detail.cancellation && (
              <section className="bw-card" style={{ borderColor: "#E8B4B0", background: "#FDF6F5" }}>
                <CardTitle icon="circle-slash" title="ההזמנה בוטלה" />
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
              </section>
            )}
            {/* honest pending-external-cancellation state (§9/§10) */}
            {detail.ota?.externalCancellationRequestedAt && detail.status !== "cancelled" && (
              <section className="bw-card" style={{ borderColor: "#F1C21B", background: "#FFF9E8" }}>
                <p className="text-sm font-bold text-ink">
                  נשלחה בקשת ביטול ל-Booking.com — ההזמנה תבוטל אוטומטית כשהערוץ יאשר. החדרים לא
                  שוחררו עדיין.
                </p>
              </section>
            )}
            {/* guest. "סטטוס שהות" (the manual lifecycle select) is RETIRED —
                hidden product-wide and never editable; the lifecycle itself
                still changes only through the validated quick actions
                (check-in/out) and the cancellation flow. */}
            <section className="bw-card">
              <CardTitle
                icon="employees"
                title="פרטי אורח"
                chip={
                  guestDirty ? (
                    <span className="bw-chg">
                      <Icon name="edit" size={13} />
                      שונה
                    </span>
                  ) : undefined
                }
              />
              <div className="bw-grid2">
                <Field label="שם פרטי" required>
                  <input className="bw-fld" value={guest.firstName} disabled={!canEditNow}
                    onChange={(e) => setGuest({ ...guest, firstName: e.target.value })} />
                </Field>
                <Field label="שם משפחה" required>
                  <input className="bw-fld" value={guest.lastName} disabled={!canEditNow}
                    onChange={(e) => setGuest({ ...guest, lastName: e.target.value })} />
                </Field>
                <Field label="טלפון">
                  <div className="bw-fld-wrap">
                    <Icon name="phone" size={16} className="bw-fi" />
                    <input className="bw-fld ic" dir="ltr" value={guest.phone} disabled={!canEditNow}
                      onChange={(e) => setGuest({ ...guest, phone: e.target.value })} />
                  </div>
                </Field>
                <Field label="אימייל">
                  <div className="bw-fld-wrap">
                    <Icon name="mail" size={16} className="bw-fi" />
                    <input className="bw-fld ic" dir="ltr" type="email" value={guest.email} disabled={!canEditNow}
                      onChange={(e) => setGuest({ ...guest, email: e.target.value })} />
                  </div>
                </Field>
                <Field label="מקור הזמנה">
                  <select className="bw-fld" value={sourceId} disabled={!canEditNow} onChange={(e) => setSourceId(e.target.value)}>
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
                      className="bw-fld"
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
            </section>

            {/* stays */}
            <section ref={staysRef} className="bw-card">
              <CardTitle
                icon="rooms"
                title="שהות וחדרים"
                chip={
                  stayDirty ? (
                    <span className="bw-chg">
                      <Icon name="edit" size={13} />
                      שונה
                    </span>
                  ) : undefined
                }
              />
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
                )}
              </div>
            </section>

            {/* pricing & payment */}
            <section className="bw-card">
              <CardTitle icon="finance" title="תמחור ותשלום" />
              {stays.map((s, i) => {
                const nights = s.checkOut > s.checkIn ? nightsBetween(s.checkIn, s.checkOut) : 0;
                const line = (s.ratePerNight ?? 0) * nights;
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
                            className="ml-2 rounded-lg border border-line px-2 py-1 text-xs font-semibold"
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
                        {nights} לילות × ₪{Math.round(s.ratePerNight ?? 0).toLocaleString()}
                        {s.isManualRate && <span className="mr-2 text-xs font-semibold text-brand">· מחיר ידני</span>}
                      </div>
                    </div>
                    <b dir="ltr">₪{Math.round(line).toLocaleString()}</b>
                  </div>
                );
              })}
              {detail.extra_charges > 0 && (
                <div className="bw-price-line">
                  <span className="bw-plr">חיובים נוספים</span>
                  <b dir="ltr">₪{detail.extra_charges.toLocaleString()}</b>
                </div>
              )}
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
                  ₪{Math.round(total).toLocaleString()}
                </span>
              </div>

              {/* payment-state chips (V2 .paychip) — a DISPLAY of the derived
                  ledger state (paymentState). The actionable chips edit only
                  the additional-payment DRAFT (a real field); recorded ledger
                  payments are never reduced from here. */}
              <div className="bw-chips-row" style={{ marginTop: 18 }}>
                <button
                  type="button"
                  className={`bw-paychip pc-unpaid ${payState === "unpaid" ? "on" : ""}`}
                  disabled={!canEditNow || (detail.paid_amount ?? 0) > 0}
                  title={
                    (detail.paid_amount ?? 0) > 0
                      ? "תשלומים שנרשמו ביומן התשלומים אינם ניתנים לביטול מכאן"
                      : undefined
                  }
                  onClick={() => setAddPay(0)}
                >
                  <span className="bw-d" />
                  לא שולם
                </button>
                <button
                  type="button"
                  className={`bw-paychip pc-partial ${payState === "partial" ? "on" : ""}`}
                  disabled={!canEditNow}
                  onClick={() => addPayRef.current?.focus()}
                >
                  <span className="bw-d" />
                  שולם חלקית
                </button>
                <button
                  type="button"
                  className={`bw-paychip pc-paid ${payState === "paid" ? "on" : ""}`}
                  disabled={!canEditNow}
                  onClick={() => setAddPay(Math.max(0, Math.round(total - (detail.paid_amount ?? 0))))}
                >
                  <span className="bw-d" />
                  שולם מלא
                </button>
                {payState === "overpaid" && (
                  <button type="button" className="bw-paychip pc-over on" disabled>
                    <span className="bw-d" />
                    שולם ביתר
                  </button>
                )}
              </div>

              {canEditNow && (
                <div className="bw-grid3 mt-4">
                  <Field label="אמצעי תשלום">
                    <select className="bw-fld" value={method} onChange={(e) => setMethod(e.target.value)}>
                      <option value="">בחירה…</option>
                      {paymentMethods.map((m) => (
                        <option key={m.id} value={m.key}>{m.label}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="תשלום נוסף (₪)">
                    <input ref={addPayRef} type="number" min={0} className="bw-fld" value={addPay || ""}
                      placeholder="0" onChange={(e) => setAddPay(Math.max(0, Number(e.target.value) || 0))} />
                  </Field>
                  <Field label="הנחה (₪)">
                    <input type="number" min={0} className="bw-fld" value={discount || ""}
                      placeholder="0" onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))} />
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
                    <Icon name="finance" size={19} />
                    גבייה מהערוץ
                  </div>
                  <div className="bw-grid2">
                    {/* both numbers, separately (D80 §2): GuestHub's internal
                        number is never replaced by the OTA's */}
                    <Field label="מספר הזמנה ב-GuestHub">
                      <b className="text-sm text-ink" dir="ltr" style={{ textAlign: "right" }}>
                        #{detail.reservation_number}
                      </b>
                    </Field>
                    <Field label={otaCodeLabel(detail.ota.otaName)}>
                      <b className="text-sm text-ink" dir="ltr" style={{ textAlign: "right" }}>
                        {detail.ota.otaReservationCode ?? "—"}
                      </b>
                    </Field>
                    {/* honest PIN state (D80 §4): Channex supplies no dedicated
                        Booking.com PIN/secret field — never mined from notes */}
                    <Field label="קוד סודי מהערוץ">
                      <b className="text-sm" style={{ color: "#6B7385" }}>
                        לא התקבל קוד סודי מהערוץ
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
                   channel guarantee, manual entry, or the empty state. §15 —
                   manual entry activates only when the payment method is credit
                   card; switching away destroys the unsaved draft. ---- */}
              {showCardSection && (
                <>
                  <CardFields
                    value={cc}
                    onChange={setCc}
                    chargeAmount={Math.max(0, total - paidAfter)}
                    disabled={method !== "credit_card"}
                    stored={cardMeta}
                    channel={guarantee}
                    channelName={
                      otaDisplayName(detail.ota?.otaName ?? null) ?? detail.ota?.otaName ?? null
                    }
                    stateLabel={detail.ota ? COLLECTION_LABEL[detail.collection.state] : null}
                    manualEntry={replacingCard}
                    onToggleManual={
                      canManageCard
                        ? (manual) => {
                            setReplacingCard(manual);
                            if (!manual) setCc(EMPTY_CARD);
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
                  {/* the guarded save action — only reachable from the editable
                      (manual-entry / empty) state of the same fields */}
                  {canManageCard && (replacingCard || (!cardMeta && !guarantee)) && (
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        className="bw-btn bw-btn-o"
                        disabled={cardBusy || ccStateForSave !== "valid" || method !== "credit_card"}
                        onClick={saveCard}
                      >
                        <Icon name="check" size={15} />
                        {cardBusy ? "שומר…" : cardMeta ? "החלף כרטיס" : "שמור כרטיס"}
                      </button>
                    </div>
                  )}
                </>
              )}
              {/* balance boxes (V2 .balance/.bal-box) — canonical formatBalance:
                  a negative balance shows as customer credit, never floored */}
              <div className="bw-grid3" style={{ marginTop: 18, gap: 12 }}>
                <div className="bw-bal">
                  <p className="bw-bal-l">סה״כ</p>
                  <p className="bw-bal-v" dir="ltr">₪{Math.round(total).toLocaleString()}</p>
                </div>
                <div className="bw-bal">
                  <p className="bw-bal-l">שולם</p>
                  <p className="bw-bal-v" style={{ color: "#15803D" }} dir="ltr">
                    ₪{Math.round(paidAfter).toLocaleString()}
                  </p>
                </div>
                <div className="bw-bal">
                  <p className="bw-bal-l">{bal.kind === "credit" ? "זיכוי ללקוח" : "יתרה לתשלום"}</p>
                  <p className="bw-bal-v" style={{ color: BAL_COLOR[bal.kind] }} dir="ltr">
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
                      <span dir="ltr">{p.paid_at ? p.paid_at.slice(0, 16).replace("T", " ") : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* cancellation policy — the immutable AT-BOOKING snapshot (034).
                Displayed from the reservation itself; a later edit to the
                Settings template never changes what is shown here. */}
            {detail.cancellation_policy && (
              <section className="bw-card">
                <CardTitle icon="documents" title="מדיניות ביטול (בעת ההזמנה)" />
                <CancellationSnapshotView snap={detail.cancellation_policy} />
              </section>
            )}

            {/* notes + expected arrival time — separate fields; the arrival
                time is never folded into the notes text (D80 §6) */}
            <section className="bw-card">
              <CardTitle icon="documents" title="הערות להזמנה" />
              <div className="bw-grid2 mb-4">
                <Field label="שעת צ'ק-אין צפויה">
                  <input
                    type="time"
                    className="bw-fld"
                    dir="ltr"
                    value={arrivalTime}
                    disabled={!canEditNow}
                    onChange={(e) => setArrivalTime(e.target.value)}
                  />
                  {detail.expected_arrival_time_source && (
                    <span className="bw-opt mt-1 block">
                      {detail.expected_arrival_time_source === "ota"
                        ? `התקבל מ-${detail.ota?.otaName ?? "הערוץ"}`
                        : "עודכן ידנית"}
                    </span>
                  )}
                </Field>
              </div>
              {/* enlarged notes — ~2× a standard multiline field, per the
                  approved V2 layout; do not shrink back */}
              <textarea className="bw-fld min-h-[184px]" value={notes} disabled={!canEditNow}
                placeholder="בקשות מיוחדות…" onChange={(e) => setNotes(e.target.value)} />
            </section>
          </div>

          {/* ---- sidebar: summary + activity (reference) ---- */}
          <aside className="bw-col-side max-lg:hidden">
            <div className="bw-sum">
              <div className="bw-sum-h" style={{ fontSize: 18 }}>
                <Icon name="reservations" size={19} className="text-primary" />
                סיכום הזמנה
              </div>
              <div className="bw-sum-b">
                <div className="bw-sum-guest">
                  <span className="bw-sum-ava">{(guest.firstName || "א").slice(0, 1)}</span>
                  <div className="min-w-0">
                    <p className="bw-sum-gname truncate">{guestDisplay}</p>
                    <p className="bw-sum-gsrc truncate" dir="ltr">
                      {detail.source_label ? `${detail.source_label} · ` : ""}#{detail.reservation_number}
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
                        <span className="bw-p" dir="ltr">
                          ₪{Math.round(r.priceTotal).toLocaleString()}
                        </span>
                      </div>
                      <div className="bw-sum-rd">
                        <Icon name="calendar" size={14} />
                        <span dir="ltr">
                          {formatFullDate(r.checkIn)} – {formatFullDate(r.checkOut)}
                        </span>
                        <Icon name="moon" size={14} />
                        <span>{nightsBetween(r.checkIn, r.checkOut)} ל׳</span>
                        <Icon name="users-round" size={14} />
                        <span>{r.adults + r.children + r.infants}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="bw-sum-sec">
                  <div className="bw-sum-line">
                    <span>לילות סה״כ</span>
                    <span>{detail.rooms.reduce((n, r) => n + nightsBetween(r.checkIn, r.checkOut), 0)}</span>
                  </div>
                  <div className="bw-sum-line">
                    <span>אורחים</span>
                    <span>{detail.rooms.reduce((n, r) => n + r.adults + r.children + r.infants, 0)}</span>
                  </div>
                </div>
                <div className="bw-sum-total">
                  <span className="bw-l">סה״כ</span>
                  <span className="bw-v" dir="ltr">₪{Math.round(total).toLocaleString()}</span>
                </div>
              </div>
            </div>

            {/* quick actions (V2 פעולות מהירות card) — only actions the system
                truly supports: check-in/out via the same validated save path,
                a real booking-confirmation send (the D53 composer), and
                jumping to the room editor. */}
            {canEditNow && ["confirmed", "draft", "checked_in"].includes(detail.status) && (
              <div className="bw-card" style={{ padding: "16px 18px" }}>
                <div className="bw-card-h" style={{ fontSize: 16, marginBottom: 13 }}>
                  <span className="bw-hi" style={{ width: 30, height: 30 }}>
                    <Icon name="automations" size={16} />
                  </span>
                  פעולות מהירות
                </div>
                <div className="bw-qa">
                  {detail.status === "checked_in" ? (
                    /* same validated save path — check-out never touches payment */
                    <button
                      type="button"
                      className="bw-qa-btn qg"
                      disabled={saving || !staysValid}
                      onClick={() => save("checked_out")}
                    >
                      <Icon name="logout" size={18} />
                      בצע צ׳ק-אאוט
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="bw-qa-btn qg"
                      disabled={saving || !staysValid}
                      onClick={() => save("checked_in")}
                    >
                      <Icon name="login" size={18} />
                      בצע צ׳ק-אין
                    </button>
                  )}
                  {/* the reference's "שלח אישור הזמנה" action is deliberately
                      NOT rendered here — this pass is a visual refactor; the
                      header toolbar already owns the real messaging actions */}
                  <button
                    type="button"
                    className="bw-qa-btn"
                    onClick={() => staysRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  >
                    <Icon name="refresh" size={18} />
                    העבר לחדר אחר
                  </button>
                </div>
              </div>
            )}

            {detail.activity.length > 0 && (
              <div className="bw-card" style={{ padding: "16px 18px" }}>
                <div className="bw-card-h" style={{ fontSize: 16, marginBottom: 13 }}>
                  <span className="bw-hi" style={{ width: 30, height: 30 }}>
                    <Icon name="attendance" size={16} />
                  </span>
                  יומן פעילות
                </div>
                <div className="bw-log">
                  {detail.activity.map((a, i) => (
                    <div key={i} className="bw-log-i">
                      <span className="bw-log-d">
                        <Icon name={ACTIVITY_ICON[a.action] ?? "edit"} size={11} />
                      </span>
                      <div className="min-w-0">
                        <div className="bw-log-t">{ACTIVITY_LABEL[a.action] ?? a.action}</div>
                        <div className="bw-log-s">
                          <span dir="ltr">{a.created_at.slice(0, 16).replace("T", " ")}</span>
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
function CancellationSnapshotView({
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
                  <b dir="ltr">
                    {p.amount ?? "—"} {p.currency ?? ""}
                  </b>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <span className="bw-opt">
        {sourceLine} · תועד בעת ההזמנה ({fmtDate(snap.captured_at)}) — עדכון עתידי של
        התבניות בהגדרות לא ישנה הזמנה קיימת
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
  discount: number,
  addPay: number,
  method: string,
  notes: string,
  arrivalTime: string,
  cc: CardDraft,
): string {
  return JSON.stringify(
    [guest, sourceId, stays, discount, addPay, method, notes, arrivalTime, cc],
    dropStayKey,
  );
}
