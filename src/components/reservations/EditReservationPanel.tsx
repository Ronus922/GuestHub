"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { SidePanel } from "@/components/ui/SidePanel";
import { Icon } from "@/components/shared/Icon";
import { nightsBetween } from "@/lib/dates";
import { paymentState } from "@/lib/inventory-rules";
import {
  getReservationAction,
  updateReservationAction,
  cancelReservationAction,
  type ReservationDetail,
} from "@/app/(dashboard)/reservations/actions";
import { EDITABLE_STATUSES } from "@/lib/validation/reservation";
import { StayEditor, newStayKey, type StayDraft } from "./StayEditor";
import { PaymentBadge } from "./BookingPanel";
import type { LookupItem } from "@/app/(dashboard)/calendar/CalendarScreen";

// עריכת הזמנה — the single reservation detail/edit flow the calendar opens
// (ref/screens/edit-booking-modal.png). Preserves every reservation room,
// per-room guests, pricing, status and payments (§F). Status-only edits do
// not re-validate untouched stays server-side.
export function EditReservationPanel({
  reservationId,
  onClose,
  bookingSources,
  paymentMethods,
  statusItems,
  canEdit,
  canCancel,
}: {
  reservationId: string | null;
  onClose: () => void;
  bookingSources: LookupItem[];
  paymentMethods: LookupItem[];
  statusItems: LookupItem[];
  canEdit: boolean;
  canCancel: boolean;
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
  const [saving, startSaving] = useTransition();
  const [confirmCancel, setConfirmCancel] = useState(false);

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
          guestFirstName: r.guestFirstName ?? undefined,
          guestLastName: r.guestLastName ?? undefined,
          guestPhone: r.guestPhone ?? undefined,
        })),
      );
      setDiscount(d.discount_amount);
      setAddPay(0);
      setMethod("");
      setNotes(d.notes ?? "");
    });
  }, [reservationId]);

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

  const save = () =>
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
        status: status as (typeof EDITABLE_STATUSES)[number],
        rooms: stays.map((s) => ({
          rrId: s.rrId,
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

  const statusColor = statusItems.find((s) => s.key === status)?.color ?? "#6B7385";

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title="עריכת הזמנה"
      subtitle={detail ? `#${detail.reservation_number}` : "טוען…"}
      icon="reservations"
      badge={detail ? (statusItems.find((s) => s.key === detail.status)?.label ?? detail.status) : undefined}
      footer={
        detail && (
          <div className="flex items-center justify-between gap-3">
            {canCancel && detail.status !== "cancelled" ? (
              confirmCancel ? (
                <span className="flex items-center gap-2">
                  <button type="button" className="btn !min-h-[40px] bg-status-danger text-white" disabled={saving} onClick={doCancel}>
                    אישור ביטול
                  </button>
                  <button type="button" className="btn btn-outline !min-h-[40px]" onClick={() => setConfirmCancel(false)}>
                    חזרה
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-xl border border-[#F4B9B9] px-4 py-2 text-sm font-bold text-status-danger hover:bg-status-danger-050"
                  onClick={() => setConfirmCancel(true)}
                >
                  <Icon name="close" size={15} />
                  בטל הזמנה
                </button>
              )
            ) : (
              <span />
            )}
            <div className="flex items-center gap-3">
              <button type="button" className="text-sm font-semibold text-muted hover:text-ink" onClick={onClose}>
                סגור
              </button>
              {canEdit && (
                <button type="button" className="btn btn-primary" disabled={saving || !staysValid} onClick={save}>
                  <Icon name="check" size={16} />
                  {saving ? "שומר…" : "שמור שינויים"}
                </button>
              )}
            </div>
          </div>
        )
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
        <div className="space-y-4" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl bg-hover" />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {/* guest */}
          <section className="rounded-2xl border border-line bg-surface p-5">
            <p className="mb-4 flex items-center gap-2.5 text-base font-bold text-ink">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-050 text-primary">
                <Icon name="user" size={17} />
              </span>
              פרטי אורח
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-text2">
                  שם פרטי <span className="text-status-danger">*</span>
                </span>
                <input className="field" value={guest.firstName} disabled={!canEdit}
                  onChange={(e) => setGuest({ ...guest, firstName: e.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-text2">
                  שם משפחה <span className="text-status-danger">*</span>
                </span>
                <input className="field" value={guest.lastName} disabled={!canEdit}
                  onChange={(e) => setGuest({ ...guest, lastName: e.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-text2">טלפון</span>
                <input className="field" dir="ltr" value={guest.phone} disabled={!canEdit}
                  onChange={(e) => setGuest({ ...guest, phone: e.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-text2">אימייל</span>
                <input className="field" dir="ltr" type="email" value={guest.email} disabled={!canEdit}
                  onChange={(e) => setGuest({ ...guest, email: e.target.value })} />
              </label>
            </div>
          </section>

          {/* status + source */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block rounded-2xl border border-line bg-surface p-5">
              <span className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-text2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: statusColor }} />
                סטטוס הזמנה
              </span>
              <select className="field" value={status} disabled={!canEdit} onChange={(e) => setStatus(e.target.value)}>
                {EDITABLE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusItems.find((x) => x.key === s)?.label ?? s}
                  </option>
                ))}
              </select>
            </label>
            <label className="block rounded-2xl border border-line bg-surface p-5">
              <span className="mb-1.5 block text-sm font-semibold text-text2">מקור הזמנה</span>
              <select className="field" value={sourceId} disabled={!canEdit} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">—</option>
                {bookingSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </section>

          {/* stays */}
          <section className="space-y-4">
            <p className="flex items-center gap-2.5 text-base font-bold text-ink">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-050 text-primary">
                <Icon name="rooms" size={17} />
              </span>
              שהות וחדרים
            </p>
            {stays.map((s, i) => (
              <StayEditor
                key={s.key}
                index={i}
                value={s}
                excludeReservationId={detail.id}
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
                className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line text-sm font-semibold text-primary hover:border-primary hover:bg-primary-050"
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
          </section>

          {/* pricing & payment */}
          <section className="rounded-2xl border border-line bg-surface p-5">
            <p className="mb-4 flex items-center gap-2.5 text-base font-bold text-ink">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-050 text-primary">
                <Icon name="finance" size={17} />
              </span>
              תמחור ותשלום
            </p>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-xl bg-field p-3">
                <p className="text-xs text-muted">סה״כ</p>
                <p className="text-lg font-extrabold text-ink" dir="ltr">₪{total.toLocaleString()}</p>
              </div>
              <div className="rounded-xl bg-field p-3">
                <p className="text-xs text-muted">שולם</p>
                <p className="text-lg font-extrabold text-[#15803D]" dir="ltr">₪{paidAfter.toLocaleString()}</p>
              </div>
              <div className="rounded-xl bg-field p-3">
                <p className="text-xs text-muted">יתרה לתשלום</p>
                <p className="text-lg font-extrabold text-[#B4231F]" dir="ltr">
                  ₪{Math.max(0, total - paidAfter).toLocaleString()}
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <PaymentBadge state={paymentState(total, paidAfter)} />
            </div>
            {canEdit && (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-text2">הנחה (₪)</span>
                  <input type="number" min={0} className="field" value={discount || ""}
                    placeholder="0" onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))} />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-text2">תשלום נוסף (₪)</span>
                  <input type="number" min={0} className="field" value={addPay || ""}
                    placeholder="0" onChange={(e) => setAddPay(Math.max(0, Number(e.target.value) || 0))} />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-text2">אמצעי תשלום</span>
                  <select className="field" value={method} onChange={(e) => setMethod(e.target.value)}>
                    <option value="">בחירה…</option>
                    {paymentMethods.map((m) => (
                      <option key={m.id} value={m.key}>{m.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {detail.payments.length > 0 && (
              <ul className="mt-4 space-y-1 border-t border-line pt-3 text-xs text-muted">
                {detail.payments.map((p) => (
                  <li key={p.id} className="flex justify-between">
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
          <section className="rounded-2xl border border-line bg-surface p-5">
            <p className="mb-3 flex items-center gap-2.5 text-base font-bold text-ink">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-050 text-primary">
                <Icon name="documents" size={17} />
              </span>
              הערות להזמנה
            </p>
            <textarea className="field min-h-24" value={notes} disabled={!canEdit}
              placeholder="בקשות מיוחדות, שעת הגעה…" onChange={(e) => setNotes(e.target.value)} />
          </section>

          {/* activity trail */}
          {detail.activity.length > 0 && (
            <section className="rounded-2xl border border-line bg-surface p-5">
              <p className="mb-3 flex items-center gap-2.5 text-base font-bold text-ink">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-050 text-primary">
                  <Icon name="refresh" size={17} />
                </span>
                יומן פעילות
              </p>
              <ul className="space-y-2">
                {detail.activity.map((a, i) => (
                  <li key={i} className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-text2">
                      {ACTIVITY_LABEL[a.action] ?? a.action}
                      {a.user_name ? ` · ${a.user_name}` : ""}
                    </span>
                    <span className="text-faint" dir="ltr">
                      {a.created_at.slice(0, 16).replace("T", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </SidePanel>
  );
}

const ACTIVITY_LABEL: Record<string, string> = {
  create: "ההזמנה נוצרה",
  update: "ההזמנה עודכנה",
  cancel: "ההזמנה בוטלה",
  reschedule: "חדר / תאריכים עודכנו",
};
