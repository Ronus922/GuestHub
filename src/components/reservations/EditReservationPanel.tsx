"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { SidePanel } from "@/components/ui/SidePanel";
import { Icon } from "@/components/shared/Icon";
import { formatFullDate, nightsBetween } from "@/lib/dates";
import { paymentState } from "@/lib/inventory-rules";
import { formatVatRate, includedVatAmount } from "@/lib/vat";
import { normalizePan, parseExpiry } from "@/lib/card-rules";
import {
  getReservationAction,
  updateReservationAction,
  cancelReservationAction,
  type ReservationDetail,
} from "@/app/(dashboard)/reservations/actions";
import {
  saveReservationCardAction,
  deleteReservationCardAction,
} from "@/app/(dashboard)/reservations/card-actions";
import { EDITABLE_STATUSES } from "@/lib/validation/reservation";
import { StayEditor, newStayKey, type StayDraft } from "./StayEditor";
import {
  CardFields,
  EMPTY_CARD,
  StoredCardBox,
  cardDraftState,
  type CardDraft,
} from "./CardFields";
import { PaymentBadge, CardTitle, Field } from "./BookingPanel";
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
  const [status, setStatus] = useState<string>("confirmed");
  const [stays, setStays] = useState<StayDraft[]>([]);
  const [discount, setDiscount] = useState(0);
  const [addPay, setAddPay] = useState(0);
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  // new-card entry values travel ONLY through the dedicated guarded save
  // action, then are cleared (see CardFields security note)
  const [cc, setCc] = useState<CardDraft>(EMPTY_CARD);
  const [cardMeta, setCardMeta] = useState<ReservationDetail["card"]>(null);
  const [replacingCard, setReplacingCard] = useState(false);
  const [cardBusy, startCardBusy] = useTransition();
  const [saving, startSaving] = useTransition();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const snapshotRef = useRef("");
  const staysRef = useRef<HTMLElement | null>(null);

  const open = reservationId !== null;

  useEffect(() => {
    if (!reservationId) {
      setDetail(null);
      return;
    }
    setDetail(null);
    setLoadError(null);
    setConfirmCancel(false);
    getReservationAction(reservationId).then((res) => {
      if (!res.success || !res.data) {
        setLoadError(res.success ? "הזמנה לא נמצאה" : res.error);
        return;
      }
      const d = res.data;
      setDetail(d);
      setGuest({
        firstName: d.guest.first_name,
        lastName: d.guest.last_name,
        phone: d.guest.phone ?? "",
        email: d.guest.email ?? "",
        idNumber: d.guest.id_number ?? "",
      });
      setSourceId(d.source_id ?? "");
      setStatus(d.status);
      setStays(
        d.rooms.map((r) => ({
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
        })),
      );
      setDiscount(d.discount_amount);
      setAddPay(0);
      setMethod("");
      setCc(EMPTY_CARD);
      setCardMeta(d.card);
      setReplacingCard(false);
      setConfirmDiscard(false);
      setNotes(d.notes ?? "");
      snapshotRef.current = editSnapshot(
        {
          firstName: d.guest.first_name,
          lastName: d.guest.last_name,
          phone: d.guest.phone ?? "",
          email: d.guest.email ?? "",
          idNumber: d.guest.id_number ?? "",
        },
        d.source_id ?? "",
        d.status,
        d.rooms.map((r) => ({
          rrId: r.rrId,
          roomId: r.roomId,
          checkIn: r.checkIn,
          checkOut: r.checkOut,
          adults: r.adults,
          children: r.children,
          infants: r.infants,
          ratePerNight: r.ratePerNight,
          guestFirstName: r.guestFirstName ?? undefined,
          guestLastName: r.guestLastName ?? undefined,
          guestPhone: r.guestPhone ?? undefined,
        })),
        d.discount_amount,
        0,
        "",
        d.notes ?? "",
        EMPTY_CARD,
      );
    });
  }, [reservationId]);

  const dirty =
    detail !== null &&
    editSnapshot(guest, sourceId, status, stays, discount, addPay, method, notes, cc) !==
      snapshotRef.current;

  // Escape / X / overlay click — dirty forms get an explicit discard
  // confirmation in the footer instead of silently losing changes
  const requestClose = () => {
    if (saving) return;
    if (dirty && !confirmDiscard) setConfirmDiscard(true);
    else onClose();
  };

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
  // validated action, same payload, just an explicit status
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
        status: statusOverride ?? (status as (typeof EDITABLE_STATUSES)[number]),
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

  const doCancel = () =>
    startSaving(async () => {
      if (!detail) return;
      const res = await cancelReservationAction(detail.id);
      if (res.success) {
        toast.success("ההזמנה בוטלה");
        onClose();
      } else {
        toast.error(res.error);
      }
    });

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
        cvv: cc.cvv || undefined,
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

  const statusMeta = detail ? statusItems.find((s) => s.key === detail.status) : null;
  const guestDisplay = `${guest.firstName} ${guest.lastName}`.trim() || "—";
  const payState = paymentState(total, paidAfter);

  return (
    <SidePanel
      open={open}
      onClose={requestClose}
      title="עריכת הזמנה"
      icon="edit"
      bodyClassName="bg-[#eef0f5] p-0"
      subtitle={
        detail
          ? `נוצרה ${fmtDate(detail.created_at)}${
              detail.source_label ? ` · מקור: ${detail.source_label}` : ""
            } · עודכנה לאחרונה ${fmtDateTime(detail.updated_at)}`
          : "טוען…"
      }
      headerChips={
        detail ? (
          <>
            <span className="bw-hd-chip" dir="ltr">
              #{detail.reservation_number}
            </span>
            <span className="bw-hd-chip">
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
                confirmCancel ? (
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      className="bw-btn"
                      style={{ background: "var(--color-status-danger)", color: "#fff" }}
                      disabled={saving}
                      onClick={doCancel}
                    >
                      אישור ביטול
                    </button>
                    <button type="button" className="bw-btn bw-btn-ghost" onClick={() => setConfirmCancel(false)}>
                      חזרה
                    </button>
                  </span>
                ) : (
                  <button type="button" className="bw-btn bw-btn-danger" onClick={() => setConfirmCancel(true)}>
                    <Icon name="circle-slash" size={15} />
                    בטל הזמנה
                  </button>
                )
              ) : (
                <span />
              )}
              <span className="flex-1" />
              <button type="button" className="bw-btn bw-btn-ghost" onClick={requestClose}>
                סגור
              </button>
              {canEdit && (
                <button
                  type="button"
                  className="bw-btn bw-btn-primary"
                  disabled={saving || !staysValid}
                  onClick={() => save()}
                >
                  <Icon name="check" size={16} />
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
            {/* guest */}
            <section className="bw-card">
              <CardTitle icon="user" title="פרטי אורח" />
              <div className="bw-grid2">
                <Field label="שם פרטי" required>
                  <input className="bw-fld" value={guest.firstName} disabled={!canEdit}
                    onChange={(e) => setGuest({ ...guest, firstName: e.target.value })} />
                </Field>
                <Field label="שם משפחה" required>
                  <input className="bw-fld" value={guest.lastName} disabled={!canEdit}
                    onChange={(e) => setGuest({ ...guest, lastName: e.target.value })} />
                </Field>
                <Field label="טלפון">
                  <div className="bw-fld-wrap">
                    <Icon name="phone" size={16} className="bw-fi" />
                    <input className="bw-fld ic" dir="ltr" value={guest.phone} disabled={!canEdit}
                      onChange={(e) => setGuest({ ...guest, phone: e.target.value })} />
                  </div>
                </Field>
                <Field label="אימייל">
                  <div className="bw-fld-wrap">
                    <Icon name="mail" size={16} className="bw-fi" />
                    <input className="bw-fld ic" dir="ltr" type="email" value={guest.email} disabled={!canEdit}
                      onChange={(e) => setGuest({ ...guest, email: e.target.value })} />
                  </div>
                </Field>
                <Field label="סטטוס הזמנה">
                  <select className="bw-fld" value={status} disabled={!canEdit} onChange={(e) => setStatus(e.target.value)}>
                    {EDITABLE_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {statusItems.find((x) => x.key === s)?.label ?? s}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="מקור הזמנה">
                  <select className="bw-fld" value={sourceId} disabled={!canEdit} onChange={(e) => setSourceId(e.target.value)}>
                    <option value="">—</option>
                    {bookingSources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </section>

            {/* stays */}
            <section ref={staysRef} className="bw-card">
              <CardTitle icon="rooms" title="שהות וחדרים" />
              <div className="flex flex-col gap-4">
                {stays.map((s, i) => (
                  <StayEditor
                    key={s.key}
                    index={i}
                    value={s}
                    excludeReservationId={detail.id}
                    disabled={!canEdit}
                    onChange={(next) => canEdit && setStays((all) => all.map((x) => (x.key === s.key ? next : x)))}
                    onRemove={
                      canEdit && stays.length > 1
                        ? () => setStays((all) => all.filter((x) => x.key !== s.key))
                        : undefined
                    }
                  />
                ))}
                {canEdit && (
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
                return (
                  <div key={s.key} className="bw-price-line">
                    <div>
                      <b>חדר {i + 1}</b>
                      <div className="bw-plr">
                        {ratePlans.length > 0 && canEdit && (
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

              <div className="bw-grid3 mt-5">
                <div className="bw-tile">
                  <p className="bw-tl">סה״כ</p>
                  <p className="bw-tv" dir="ltr">₪{Math.round(total).toLocaleString()}</p>
                </div>
                <div className="bw-tile">
                  <p className="bw-tl">שולם</p>
                  <p className="bw-tv" style={{ color: "#15803D" }} dir="ltr">₪{Math.round(paidAfter).toLocaleString()}</p>
                </div>
                <div className="bw-tile">
                  <p className="bw-tl">יתרה לתשלום</p>
                  <p className="bw-tv" style={{ color: "#B4231F" }} dir="ltr">
                    ₪{Math.round(Math.max(0, total - paidAfter)).toLocaleString()}
                  </p>
                </div>
              </div>

              {canEdit && (
                <>
                  <div className="bw-grid3 mt-5">
                    <Field label="הנחה (₪)">
                      <input type="number" min={0} className="bw-fld" value={discount || ""}
                        placeholder="0" onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))} />
                    </Field>
                    <Field label="תשלום נוסף (₪)">
                      <input type="number" min={0} className="bw-fld" value={addPay || ""}
                        placeholder="0" onChange={(e) => setAddPay(Math.max(0, Number(e.target.value) || 0))} />
                    </Field>
                    <Field label="אמצעי תשלום">
                      <select className="bw-fld" value={method} onChange={(e) => setMethod(e.target.value)}>
                        <option value="">בחירה…</option>
                        {paymentMethods.map((m) => (
                          <option key={m.id} value={m.key}>{m.label}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                </>
              )}
              {/* ---- stored card (D41): masked by default; entry/replace
                   through the dedicated guarded save action only ---- */}
              {cardMeta && !replacingCard && (
                <StoredCardBox
                  card={cardMeta}
                  canReveal={canRevealCard}
                  canManage={canSaveCard && canEdit}
                  canCharge={canChargeCard}
                  canRecordPayment={canChargeCard && canEdit}
                  chargeAmount={Math.max(0, total - paidAfter)}
                  reservationId={detail.id}
                  onReplace={() => setReplacingCard(true)}
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
              )}
              {canSaveCard && canEdit && (replacingCard || !cardMeta) && (
                <>
                  <CardFields
                    value={cc}
                    onChange={setCc}
                    chargeAmount={Math.max(0, total - paidAfter)}
                  />
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      className="bw-btn bw-btn-o"
                      disabled={cardBusy || ccStateForSave !== "valid"}
                      onClick={saveCard}
                    >
                      <Icon name="check" size={15} />
                      {cardBusy ? "שומר…" : cardMeta ? "החלף כרטיס" : "שמור כרטיס"}
                    </button>
                    {replacingCard && (
                      <button
                        type="button"
                        className="bw-btn bw-btn-ghost"
                        onClick={() => {
                          setReplacingCard(false);
                          setCc(EMPTY_CARD);
                        }}
                      >
                        ביטול
                      </button>
                    )}
                  </div>
                </>
              )}
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

            {/* notes */}
            <section className="bw-card">
              <CardTitle icon="documents" title="הערות להזמנה" />
              <textarea className="bw-fld" value={notes} disabled={!canEdit}
                placeholder="בקשות מיוחדות, שעת הגעה…" onChange={(e) => setNotes(e.target.value)} />
            </section>
          </div>

          {/* ---- sidebar: summary + activity (reference) ---- */}
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
                <div className="bw-sum-pay">
                  <span>סטטוס תשלום</span>
                  <PaymentBadge state={payState} />
                </div>
              </div>
            </div>

            {/* quick actions (reference פעולות מהירות) — only actions the
                system truly supports: check-in via the same validated save
                path, and jumping to the room editor. שלח אישור הזמנה is not
                rendered (no messaging infra — D40). */}
            {canEdit && (detail.status === "confirmed" || detail.status === "draft") && (
              <div className="bw-sum">
                <div className="bw-sum-h">
                  <Icon name="automations" size={17} className="text-primary" />
                  פעולות מהירות
                </div>
                <div className="bw-sum-b">
                  <div className="bw-qa">
                    <button
                      type="button"
                      className="bw-qa-btn qg"
                      disabled={saving || !staysValid}
                      onClick={() => save("checked_in")}
                    >
                      <Icon name="login" size={17} />
                      בצע צ׳ק-אין
                    </button>
                    <button
                      type="button"
                      className="bw-qa-btn"
                      onClick={() => staysRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                    >
                      <Icon name="refresh" size={17} />
                      העבר לחדר אחר
                    </button>
                  </div>
                </div>
              </div>
            )}

            {detail.activity.length > 0 && (
              <div className="bw-sum">
                <div className="bw-sum-h">
                  <Icon name="refresh" size={17} className="text-primary" />
                  יומן פעילות
                </div>
                <div className="bw-sum-b">
                  <div className="bw-act">
                    {detail.activity.map((a, i) => (
                      <div key={i} className="bw-act-row">
                        <span className="bw-act-t">
                          {ACTIVITY_LABEL[a.action] ?? a.action}
                          {a.user_name ? ` · ${a.user_name}` : ""}
                        </span>
                        <span className="bw-act-d">{a.created_at.slice(0, 16).replace("T", " ")}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </SidePanel>
  );
}

function fmtDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}
function fmtDateTime(iso: string): string {
  return `${fmtDate(iso)} ${iso.slice(11, 16)}`;
}

const ACTIVITY_LABEL: Record<string, string> = {
  create: "ההזמנה נוצרה",
  update: "ההזמנה עודכנה",
  cancel: "ההזמנה בוטלה",
  reschedule: "חדר / תאריכים עודכנו",
  card_save: "כרטיס אשראי נשמר",
  card_replace: "כרטיס אשראי הוחלף",
  card_reveal: "מספר כרטיס נחשף",
  card_reveal_denied: "ניסיון חשיפת כרטיס נדחה",
  card_charge_attempt: "ניסיון סליקת כרטיס",
  card_import_channel: "כרטיס יובא מערוץ",
  card_delete: "כרטיס אשראי הוסר",
  payment_external_record: "נרשם תשלום שבוצע חיצונית",
};

// dirty-state fingerprint of everything the user can edit (stay "key"
// fields are random per load, so the replacer drops them)
function editSnapshot(
  guest: { firstName: string; lastName: string; phone: string; email: string; idNumber: string },
  sourceId: string,
  status: string,
  stays: (StayDraft | Omit<StayDraft, "key">)[],
  discount: number,
  addPay: number,
  method: string,
  notes: string,
  cc: CardDraft,
): string {
  return JSON.stringify(
    [guest, sourceId, status, stays, discount, addPay, method, notes, cc],
    (k, v) => (k === "key" ? undefined : v),
  );
}
