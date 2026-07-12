"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { statusTintPalette } from "@/lib/colors";
import { STATUS_COLORS } from "@/lib/status-colors";
import { EditReservationPanel } from "@/components/reservations/EditReservationPanel";
import type { LookupItem } from "@/app/(dashboard)/calendar/CalendarScreen";
import { getGuestProfileAction, type GuestProfile } from "./actions";
import type { GuestsListData } from "./data";

// ============================================================
// /guests — אורחים (D77 §19), over the canonical guests table. Same design
// language as /reservations (rl- shell + gl- grid). Row click opens the guest
// profile SidePanel; a reservation inside it opens the EXISTING reservation
// panel (never a second editor). No automatic guest merging anywhere.
// ============================================================

const ddmmyy = (iso: string | null) =>
  iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : "—";

const money = (n: number, currency: string) => {
  const sym = currency === "ILS" ? "₪" : currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  return `${sym}${Math.round(n).toLocaleString("en-US")}`;
};

const RES_STATUS_LABEL: Record<string, string> = {
  draft: "טיוטה",
  confirmed: "מאושרת",
  checked_in: "In House",
  checked_out: "הסתיימה",
  cancelled: "בוטלה",
  no_show: "No Show",
  blocked: "חסומה",
};

// the stay lifecycle wears the canonical chip families (§3/§3.1) — the same
// mapping the reservations list uses (LIFECYCLE_PILL): transfer purple is
// reserved for the overpaid payment state, "בוטלה" keeps the crimson "נכשל"
// family so a cancelled stay stays legible next to the checked-out grey.
const RES_STATUS_CHIP: Record<string, string> = {
  draft: "chip-approval",
  confirmed: "chip-brand",
  checked_in: "chip-paid",
  checked_out: "chip-refunded",
  cancelled: "chip-failed",
  no_show: "chip-approval",
  blocked: "chip-refunded",
};

const MSG_CHANNEL_LABEL: Record<string, string> = { email: "מייל", whatsapp: "WhatsApp" };

export function GuestsScreen({
  data,
  q: initialQ,
  bookingSources,
  paymentMethods,
  workflowStatuses,
  statusItems,
  ratePlans,
  can,
  vatRate,
}: {
  data: GuestsListData;
  q: string;
  bookingSources: LookupItem[];
  paymentMethods: LookupItem[];
  workflowStatuses: LookupItem[];
  statusItems: LookupItem[];
  ratePlans: { id: string; name: string; code: string }[];
  can: {
    edit: boolean;
    cancel: boolean;
    viewReservation: boolean;
    saveCard: boolean;
    revealCard: boolean;
    chargeCard: boolean;
  };
  vatRate: number;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profile, setProfile] = useState<GuestProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [reservationId, setReservationId] = useState<string | null>(null);

  useEffect(() => setQ(initialQ), [initialQ]);

  useEffect(() => {
    if (!profileId) {
      setProfile(null);
      return;
    }
    setProfile(null);
    setProfileError(null);
    getGuestProfileAction(profileId).then((res) => {
      if (res.success && res.data) setProfile(res.data);
      else setProfileError(res.success ? "אורח לא נמצא" : res.error);
    });
  }, [profileId]);

  const onSearch = (value: string) => {
    setQ(value);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => {
      router.replace(value.trim() ? `/guests?q=${encodeURIComponent(value.trim())}` : "/guests");
    }, 350);
  };

  return (
    <div className="rl-app">
      <div className="rl-hd">
        <h1 className="h1">אורחים</h1>
        <p className="t-secondary">
          {/* explicit locale — Node's default ICU locale and the browser's can
              disagree on grouping, which is a hydration mismatch (D71 class) */}
          <bdi className="ltr-num">{data.totalGuests.toLocaleString("he-IL")}</bdi> אורחים · כל
          ההיסטוריה, התשלומים והשהיות
        </p>
      </div>

      <div className="rl-toolbar">
        <span className="rl-sp" />
        <label className="rl-search field-input">
          <Icon name="search" size={20} />
          <input
            value={q}
            placeholder="חיפוש לפי שם, טלפון או אימייל…"
            onChange={(e) => onSearch(e.target.value)}
          />
        </label>
      </div>

      <div className="card rl-card">
        <div className="rl-twrap thin-scroll">
          <div className="rl-thead gl-rowg">
            <div className="rl-th start">אורח</div>
            <div className="rl-th">טלפון</div>
            <div className="rl-th">אימייל</div>
            <div className="rl-th">הזמנות</div>
            <div className="rl-th">פעילות</div>
            <div className="rl-th">שהיות</div>
            <div className="rl-th">בוטלו</div>
            <div className="rl-th">No-show</div>
            <div className="rl-th">שהות אחרונה</div>
            <div className="rl-th">שהות הבאה</div>
            <div className="rl-th">שולם</div>
            <div className="rl-th end">יתרה</div>
          </div>
          {data.rows.length === 0 ? (
            <div className="empty-state">
              <Icon name="guests" size={24} />
              <p className="empty-t">לא נמצאו אורחים</p>
              <p className="empty-s">נסו לשנות את מונח החיפוש</p>
            </div>
          ) : (
            data.rows.map((g) => (
              <div
                key={g.id}
                className="gl-rowg rl-trow"
                role="button"
                tabIndex={0}
                onClick={() => setProfileId(g.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setProfileId(g.id);
                  }
                }}
              >
                <div className="rl-td rl-guest">
                  <span className="rl-av">{(g.full_name || "א").slice(0, 1)}</span>
                  <span className="rl-gname">{g.full_name}</span>
                  {g.is_vip && (
                    <Icon name="star" size={20} className="rl-star" label="אורח VIP" />
                  )}
                  {g.is_blocked && <span className="chip chip-unpaid">חסום</span>}
                </div>
                <div className="rl-td">
                  <span className="rl-phone ltr-num">{g.phone ?? "—"}</span>
                </div>
                <div className="rl-td">
                  <span className="gl-email ltr-num">{g.email ?? "—"}</span>
                </div>
                <div className="rl-td">
                  <span className={`gl-num ltr-num ${g.total_reservations === 0 ? "zero" : ""}`}>
                    {g.total_reservations}
                  </span>
                </div>
                <div className="rl-td">
                  <span className={`gl-num ltr-num ${g.active_reservations === 0 ? "zero" : ""}`}>
                    {g.active_reservations}
                  </span>
                </div>
                <div className="rl-td">
                  <span className={`gl-num ltr-num ${g.completed_stays === 0 ? "zero" : ""}`}>
                    {g.completed_stays}
                  </span>
                </div>
                <div className="rl-td">
                  <span className={`gl-num ltr-num ${g.cancelled_stays === 0 ? "zero" : ""}`}>
                    {g.cancelled_stays}
                  </span>
                </div>
                <div className="rl-td">
                  <span className={`gl-num ltr-num ${g.no_shows === 0 ? "zero" : ""}`}>
                    {g.no_shows}
                  </span>
                </div>
                <div className="rl-td">
                  <span className="rl-date ltr-num">{ddmmyy(g.last_stay)}</span>
                </div>
                <div className="rl-td">
                  <span className="rl-date ltr-num">{ddmmyy(g.next_stay)}</span>
                </div>
                <div className="rl-td">
                  <span className="gl-money ltr-num">{money(g.total_paid, data.currency)}</span>
                  {g.foreign_currency_count > 0 && (
                    /* foreign-currency bookings are never summed into the
                       tenant-currency totals — flagged instead of faked */
                    <span className="rl-otacode">+{g.foreign_currency_count} במט״ח</span>
                  )}
                </div>
                <div className="rl-td end">
                  <span className={`gl-money ltr-num ${g.outstanding > 0 ? "due" : ""}`}>
                    {money(g.outstanding, data.currency)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
        {data.truncatedBy > 0 && (
          <p className="rl-truncated">
            מוצגים {data.rows.length} אורחים; עוד {data.truncatedBy} תואמים — השתמשו בחיפוש
          </p>
        )}
      </div>

      {/* ---- guest profile panel ---- */}
      <SidePanel
        open={profileId !== null && reservationId === null}
        onClose={() => setProfileId(null)}
        title="כרטיס אורח"
        icon="guests"
        subtitle={profile?.guest.full_name ?? "טוען…"}
        bodyClassName="bg-appbg"
      >
        {profileError ? (
          <div className="grid h-40 place-items-center text-center">
            <p className="font-semibold text-status-danger">{profileError}</p>
          </div>
        ) : !profile ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-32" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <section className="card card-bd">
              <div className="bw-grid2">
                <ProfileFact label="שם מלא" value={profile.guest.full_name} />
                <ProfileFact label="טלפון" value={profile.guest.phone ?? "—"} ltr />
                <ProfileFact label="אימייל" value={profile.guest.email ?? "—"} ltr />
                <ProfileFact label="ת״ז" value={profile.guest.id_number ?? "—"} ltr />
                <ProfileFact
                  label="ערוצי OTA"
                  value={profile.otaSources.length > 0 ? profile.otaSources.join(", ") : "—"}
                />
                <ProfileFact
                  label="הצטרפות"
                  value={ddmmyy(profile.guest.created_at.slice(0, 10))}
                />
              </div>
              {profile.guest.notes && (
                <p className="mt-4 rounded-xl bg-appbg p-3 text-sm font-semibold text-ink">
                  {profile.guest.notes}
                </p>
              )}
            </section>

            <section className="card card-bd">
              <div className="bw-grid3">
                <div className="tile">
                  <p className="tile-l">
                    שולם סה״כ
                    {profile.totals.foreignCount > 0 && ` (+${profile.totals.foreignCount} במט״ח)`}
                  </p>
                  <p className="tile-v ltr-num" style={{ color: STATUS_COLORS.paid.tx }}>
                    {money(profile.totals.paid, data.currency)}
                  </p>
                </div>
                <div className="tile">
                  <p className="tile-l">יתרה פתוחה</p>
                  <p
                    className="tile-v ltr-num"
                    style={{
                      color:
                        profile.totals.outstanding > 0
                          ? STATUS_COLORS.unpaid.tx
                          : STATUS_COLORS.paid.tx,
                    }}
                  >
                    {money(profile.totals.outstanding, data.currency)}
                  </p>
                </div>
                <div className="tile">
                  <p className="tile-l">הזמנות</p>
                  <p className="tile-v ltr-num">{profile.reservations.length}</p>
                </div>
              </div>
            </section>

            <section className="card card-bd">
              <h4 className="h4 mb-3">היסטוריית הזמנות — כולל ביטולים ו-No-show</h4>
              {profile.reservations.length === 0 ? (
                <p className="t-secondary">אין הזמנות לאורח זה</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {profile.reservations.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 rounded-xl border border-line p-3 text-start hover:bg-hover"
                        onClick={() => can.viewReservation && setReservationId(r.id)}
                      >
                        <span className="rl-resno ltr-num">#{r.reservation_number}</span>
                        <span className="rl-date ltr-num">
                          {ddmmyy(r.check_in)} – {ddmmyy(r.check_out)}
                        </span>
                        <span className={`chip ${RES_STATUS_CHIP[r.status] ?? "chip-refunded"}`}>
                          {RES_STATUS_LABEL[r.status] ?? r.status}
                        </span>
                        {r.workflow_label && (
                          /* order-status tag — the same configured tint family
                             as the calendar pill / reservations list (D77.2) */
                          <span
                            className="chip rl-wf"
                            style={(() => {
                              const t = statusTintPalette(r.workflow_color);
                              return { backgroundColor: t.bg, borderColor: t.bd, color: t.tx };
                            })()}
                          >
                            {r.workflow_label}
                          </span>
                        )}
                        <span className="flex-1" />
                        <b className="ltr-num text-[15px] font-extrabold text-ink">
                          {money(r.total_price, r.currency)}
                        </b>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {profile.messages.length > 0 && (
              <section className="card card-bd">
                <h4 className="h4 mb-3">תקשורת אחרונה</h4>
                <ul className="flex flex-col gap-2">
                  {profile.messages.map((m, i) => (
                    <li key={i} className="bw-sum-line">
                      <span>
                        {MSG_CHANNEL_LABEL[m.channel] ?? m.channel} · {m.status}
                      </span>
                      <span className="ltr-num">
                        {m.created_at.slice(0, 16).replace("T", " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </SidePanel>

      {/* the ONE existing reservation panel, opened from the profile */}
      <EditReservationPanel
        reservationId={reservationId}
        onClose={() => setReservationId(null)}
        bookingSources={bookingSources}
        paymentMethods={paymentMethods}
        ratePlans={ratePlans}
        statusItems={statusItems}
        workflowStatuses={workflowStatuses}
        canEdit={can.edit}
        canCancel={can.cancel}
        vatRate={vatRate}
        canSaveCard={can.saveCard}
        canRevealCard={can.revealCard}
        canChargeCard={can.chargeCard}
      />
    </div>
  );
}

function ProfileFact({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="t-label">{label}</span>
      {/* a phone / mail / ID reads LTR; inside its own ltr box `end` is the
          right edge, so the value still lines up with the RTL column (§11) */}
      <b
        className={`text-[15px] font-extrabold text-ink${ltr ? " ltr-num text-end" : ""}`}
      >
        {value}
      </b>
    </div>
  );
}
