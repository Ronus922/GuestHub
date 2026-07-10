"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
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
        <h1 className="rl-hd-t">אורחים</h1>
        <p className="rl-hd-sub">
          {data.totalGuests.toLocaleString()} אורחים · כל ההיסטוריה, התשלומים והשהיות
        </p>
      </div>

      <div className="rl-toolbar">
        <span className="rl-sp" />
        <label className="rl-search">
          <Icon name="search" size={22} />
          <input
            value={q}
            placeholder="חיפוש לפי שם, טלפון או אימייל…"
            onChange={(e) => onSearch(e.target.value)}
          />
        </label>
      </div>

      <div className="rl-card">
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
            <div className="rl-empty">
              <Icon name="guests" size={44} />
              <p className="rl-empty-t">לא נמצאו אורחים</p>
              <p className="rl-empty-s">נסו לשנות את מונח החיפוש</p>
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
                  {g.is_vip && <Icon name="star" size={19} className="rl-star" />}
                  {g.is_blocked && <span className="gl-blocked">חסום</span>}
                </div>
                <div className="rl-td">
                  <span className="rl-phone">{g.phone ?? "—"}</span>
                </div>
                <div className="rl-td">
                  <span className="gl-email">{g.email ?? "—"}</span>
                </div>
                <div className="rl-td">
                  <span className={`gl-num ${g.total_reservations === 0 ? "zero" : ""}`}>
                    {g.total_reservations}
                  </span>
                </div>
                <div className="rl-td">
                  <span className={`gl-num ${g.active_reservations === 0 ? "zero" : ""}`}>
                    {g.active_reservations}
                  </span>
                </div>
                <div className="rl-td">
                  <span className={`gl-num ${g.completed_stays === 0 ? "zero" : ""}`}>
                    {g.completed_stays}
                  </span>
                </div>
                <div className="rl-td">
                  <span className={`gl-num ${g.cancelled_stays === 0 ? "zero" : ""}`}>
                    {g.cancelled_stays}
                  </span>
                </div>
                <div className="rl-td">
                  <span className={`gl-num ${g.no_shows === 0 ? "zero" : ""}`}>{g.no_shows}</span>
                </div>
                <div className="rl-td">
                  <span className="rl-date">{ddmmyy(g.last_stay)}</span>
                </div>
                <div className="rl-td">
                  <span className="rl-date">{ddmmyy(g.next_stay)}</span>
                </div>
                <div className="rl-td">
                  <span className="rl-pay paid">{money(g.total_paid, data.currency)}</span>
                </div>
                <div className="rl-td" style={{ textAlign: "left" }}>
                  <span className={`rl-pay ${g.outstanding > 0 ? "unpaid" : "paid"}`} dir="ltr">
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
        bodyClassName="bg-[#eef0f5]"
      >
        {profileError ? (
          <div className="grid h-40 place-items-center text-center">
            <p className="font-semibold text-status-danger">{profileError}</p>
          </div>
        ) : !profile ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-2xl bg-white/70" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <section className="bw-card">
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

            <section className="bw-card">
              <div className="bw-grid3">
                <div className="bw-tile">
                  <p className="bw-tl">שולם סה״כ</p>
                  <p className="bw-tv" style={{ color: "#15803D" }} dir="ltr">
                    {money(profile.totals.paid, data.currency)}
                  </p>
                </div>
                <div className="bw-tile">
                  <p className="bw-tl">יתרה פתוחה</p>
                  <p
                    className="bw-tv"
                    style={{ color: profile.totals.outstanding > 0 ? "#B4231F" : "#15803D" }}
                    dir="ltr"
                  >
                    {money(profile.totals.outstanding, data.currency)}
                  </p>
                </div>
                <div className="bw-tile">
                  <p className="bw-tl">הזמנות</p>
                  <p className="bw-tv">{profile.reservations.length}</p>
                </div>
              </div>
            </section>

            <section className="bw-card">
              <h4 className="mb-3 text-sm font-extrabold text-ink">
                היסטוריית הזמנות — כולל ביטולים ו-No-show
              </h4>
              {profile.reservations.length === 0 ? (
                <p className="text-sm font-semibold text-muted">אין הזמנות לאורח זה</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {profile.reservations.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 rounded-xl border border-line p-3 text-right hover:bg-appbg"
                        onClick={() => can.viewReservation && setReservationId(r.id)}
                      >
                        <span className="rl-resno">#{r.reservation_number}</span>
                        <span className="rl-date">
                          {ddmmyy(r.check_in)} – {ddmmyy(r.check_out)}
                        </span>
                        <span
                          className={`rl-pill ${
                            r.status === "cancelled"
                              ? "cancelled"
                              : r.status === "checked_in"
                                ? "inhouse"
                                : r.status === "no_show"
                                  ? "noshow"
                                  : r.status === "checked_out"
                                    ? "out"
                                    : "confirmed"
                          }`}
                        >
                          {RES_STATUS_LABEL[r.status] ?? r.status}
                        </span>
                        <span className="flex-1" />
                        <b dir="ltr" className="text-sm text-ink">
                          {money(r.total_price, r.currency)}
                        </b>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {profile.messages.length > 0 && (
              <section className="bw-card">
                <h4 className="mb-3 text-sm font-extrabold text-ink">תקשורת אחרונה</h4>
                <ul className="flex flex-col gap-2">
                  {profile.messages.map((m, i) => (
                    <li key={i} className="bw-sum-line">
                      <span>
                        {MSG_CHANNEL_LABEL[m.channel] ?? m.channel} · {m.status}
                      </span>
                      <span dir="ltr">{m.created_at.slice(0, 16).replace("T", " ")}</span>
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
      <span className="text-xs font-bold text-muted">{label}</span>
      <b className="text-sm text-ink" dir={ltr ? "ltr" : undefined} style={ltr ? { textAlign: "right" } : undefined}>
        {value}
      </b>
    </div>
  );
}
