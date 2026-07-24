"use client";

import { useState, useTransition } from "react";
import { Icon, type IconName } from "@/components/shared/Icon";
import {
  getBeds24ConnectionAction,
  testBeds24ConnectionAction,
  listBeds24PropertiesAction,
  mapBeds24RoomAction,
  unmapBeds24RoomAction,
  enableBeds24InboundAction,
  disableBeds24InboundAction,
  runBeds24FullSyncAction,
  type Beds24ConnectionView,
} from "@/lib/channel/beds24-admin";
import type { Beds24PropertySummary } from "@/lib/channel/beds24-properties";
import { Beds24InviteCodeForm } from "./Beds24InviteCodeForm";

// Beds24 PRODUCTION connection card (D78) — super_admin only (the page gates on
// canManageChannels; every action re-checks server-side). No credential is
// ever sent back here; only the masked refresh-token hint, the cached
// access-token expiry and sanitized status.
//
// The invite-code input is NOT permanently mounted (D70 password-manager
// defence) — see ./Beds24InviteCodeForm.
//
// "בדיקת חיבור" takes NO argument: it always uses the STORED credential
// server-side (GET /authentication/details + GET /properties — read-only,
// never a write).
//
// Mapping model: one PHYSICAL ROOM ↔ one Beds24 room (propertyId+roomId) + ONE
// local pricing plan. The properties list loads only on explicit click — page
// load performs no Beds24 call.
//
// Activation (D79): the §12 inline-confirm Full Sync trigger + poll-only
// inbound enable/disable (Beds24 has NO webhook — the worker pulls bookings
// every ~5 minutes). Both are rejected server-side while Beds24 is a dormant
// backup (is_active_provider=false).

const dtFmt = new Intl.DateTimeFormat("he-IL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Jerusalem",
});
const fmt = (v: string | null) => (v ? dtFmt.format(new Date(v)) : "—");

type Status = "not_configured" | "configured" | "testing" | "connected" | "failed";

function deriveStatus(v: Beds24ConnectionView, testing: boolean): Status {
  if (testing) return "testing";
  if (!v.configured) return "not_configured";
  if (v.state === "ready" || v.state === "active" || v.lastTestOkAt) return "connected";
  if (v.state === "error" || v.lastTestErrorCode) return "failed";
  return "configured";
}

// §3 — one chip anatomy; the tone comes from the §3.1 triplets only.
const STATUS_META: Record<Status, { label: string; cls: string; icon: IconName }> = {
  not_configured: { label: "לא מוגדר", cls: "chip-cancelled", icon: "info" },
  configured: { label: "מוגדר — טרם נבדק", cls: "chip-approval", icon: "info" },
  testing: { label: "בודק…", cls: "chip-transfer", icon: "refresh" },
  connected: { label: "מחובר", cls: "chip-paid", icon: "shield-check" },
  failed: { label: "החיבור נכשל", cls: "chip-failed", icon: "warning" },
};

const MAPPING_STATUS_META: Record<string, { label: string; cls: string }> = {
  mapped: { label: "ממופה", cls: "chip-paid" },
  unmapped: { label: "ללא מיפוי", cls: "chip-neutral" },
  quarantined: { label: "בהסגר", cls: "chip-failed" },
};

type Msg = { tone: "ok" | "err"; text: string } | null;
// the grouped select carries BOTH ids in one value — "propertyId|roomId"
type Draft = { unitKey: string; planId: string };

const unitKeyOf = (propertyId: string, roomId: string) => `${propertyId}|${roomId}`;
const splitUnitKey = (key: string): { propertyId: string; roomId: string } => {
  const sep = key.indexOf("|");
  return sep < 0
    ? { propertyId: "", roomId: "" }
    : { propertyId: key.slice(0, sep), roomId: key.slice(sep + 1) };
};

export function Beds24Section({ initial }: { initial: Beds24ConnectionView }) {
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);

  // Mount discipline: the invite-code
  // field exists only after an explicit click; `mountId` forces a brand-new
  // instance per open.
  const [configuring, setConfiguring] = useState(false);
  const [mountId, setMountId] = useState(0);

  // Properties load ONLY on explicit click — never on page load.
  const [properties, setProperties] = useState<Beds24PropertySummary[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // mapped rows render as a static row; "שינוי" opens the selects
  const [editRows, setEditRows] = useState<Set<string>>(new Set());
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  // Activation (D79): inline Full-Sync confirm (§12 pattern from AriSyncSection)
  const [confirmingSync, setConfirmingSync] = useState(false);

  const status = deriveStatus(view, testing);
  const meta = STATUS_META[status];
  const busy = pending || rowBusy !== null;

  const mappingByRoom = new Map(view.mappings.map((m) => [m.roomId, m]));

  async function reload() {
    const res = await getBeds24ConnectionAction();
    if (res.success && res.data) setView(res.data);
  }

  function openConfigure() {
    setMsg(null);
    setMountId((n) => n + 1);
    setConfiguring(true);
  }

  function onSaved() {
    setConfiguring(false); // unmount: the code is never rendered again
    setMsg({ tone: "ok", text: "החיבור הוגדר — טוקן הרענון נשמר מוצפן. הפעל בדיקת חיבור לאימותו" });
    // the hint + access-token expiry are server-computed — refresh the masked view
    startTransition(reload);
  }

  function onTest() {
    setMsg(null);
    setTesting(true);
    startTransition(async () => {
      const res = await testBeds24ConnectionAction();
      setTesting(false);
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      await reload();
      if (res.data!.ok) {
        const credits = res.data!.creditsRemaining;
        setMsg({
          tone: "ok",
          text:
            `מחובר — ${res.data!.propertyCount} נכסים נגישים` +
            (credits !== null && credits !== undefined ? ` · ${credits} קרדיטים נותרו (5 דק׳)` : ""),
        });
      } else {
        setMsg({ tone: "err", text: res.data!.message ?? "החיבור נכשל" });
      }
    });
  }

  function onLoadProperties() {
    setMsg(null);
    startTransition(async () => {
      const res = await listBeds24PropertiesAction();
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      setProperties(res.data!.properties);
      setMsg({ tone: "ok", text: `נטענו ${res.data!.properties.length} נכסים מ-Beds24` });
    });
  }

  function draftOf(roomId: string): Draft {
    const existing = mappingByRoom.get(roomId);
    return (
      drafts[roomId] ?? {
        unitKey: existing ? unitKeyOf(existing.beds24PropertyId, existing.beds24RoomId) : "",
        planId: existing?.localRatePlanId ?? "",
      }
    );
  }

  function setDraft(roomId: string, patch: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [roomId]: { ...draftOf(roomId), ...patch } }));
  }

  function onMap(roomId: string) {
    const d = draftOf(roomId);
    const { propertyId, roomId: beds24RoomId } = splitUnitKey(d.unitKey);
    if (!propertyId || !beds24RoomId || !d.planId || rowBusy) return;
    setMsg(null);
    setRowBusy(roomId);
    startTransition(async () => {
      try {
        const res = await mapBeds24RoomAction({
          roomId,
          beds24PropertyId: propertyId,
          beds24RoomId,
          localRatePlanId: d.planId,
        });
        if (!res.success) return setMsg({ tone: "err", text: res.error });
        await reload();
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[roomId];
          return next;
        });
        setEditRows((prev) => {
          const next = new Set(prev);
          next.delete(roomId);
          return next;
        });
        setMsg({ tone: "ok", text: "החדר מופה לחדר Beds24" });
      } finally {
        setRowBusy(null);
      }
    });
  }

  function onUnmap(roomId: string) {
    if (rowBusy) return;
    setMsg(null);
    setRowBusy(roomId);
    startTransition(async () => {
      try {
        const res = await unmapBeds24RoomAction({ roomId });
        if (!res.success) return setMsg({ tone: "err", text: res.error });
        await reload();
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[roomId];
          return next;
        });
        setMsg({ tone: "ok", text: "המיפוי הוסר" });
      } finally {
        setRowBusy(null);
      }
    });
  }

  function onConfirmFullSync() {
    setConfirmingSync(false);
    setMsg(null);
    startTransition(async () => {
      const res = await runBeds24FullSyncAction();
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      await reload();
      setMsg({
        tone: "ok",
        text: res.data!.alreadyRunning
          ? "סנכרון מלא כבר מתבצע — לא נוצרה ריצה שנייה"
          : "סנכרון מלא נכנס לתור — עובד הרקע מריץ אותו כעת",
      });
    });
  }

  function onEnableInbound() {
    setMsg(null);
    startTransition(async () => {
      const res = await enableBeds24InboundAction();
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      await reload();
      setMsg({ tone: "ok", text: "ייבוא הזמנות הופעל — עובד הרקע מושך הזמנות כל כ-5 דקות" });
    });
  }

  function onDisableInbound() {
    setMsg(null);
    startTransition(async () => {
      const res = await disableBeds24InboundAction();
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      await reload();
      setMsg({ tone: "ok", text: "ייבוא הזמנות כובה" });
    });
  }

  const activeRooms = view.rooms.filter((r) => r.isActive);
  const canFullSync =
    view.isActiveProvider &&
    (view.state === "ready" || view.state === "active") &&
    view.mappedCount > 0;

  return (
    <section className="card">
      <div className="card-hd justify-between">
        <div className="flex items-center gap-2">
          <span className="h4">חיבור Beds24</span>
          <span className="chip chip-transfer">Production</span>
        </div>
        <span className={`chip ${meta.cls}`}>
          <Icon name={meta.icon} size={13.5} />
          {meta.label}
        </span>
      </div>

      <div className="card-bd flex flex-col gap-4">
        {/* Production notice — this IS the live account */}
        <div className="flex items-start gap-2.5 rounded-xl border border-status-warning bg-status-warning-050 p-3">
          <Icon name="warning" size={17} className="mt-0.5 shrink-0 text-status-warning" />
          <p className="t-label leading-relaxed text-status-warning">
            ל-Beds24 אין סביבת בדיקות — זהו חיבור לחשבון <strong>הייצור</strong> האמיתי.
            &quot;סנכרון מלא&quot; שולח את המחירים והזמינות הקנוניים דרך Beds24 ליומני
            Booking.com <strong>החיים</strong>; שאר הפעולות בכרטיס (בדיקה, רשימת נכסים,
            מיפוי) הן קריאה בלבד.
          </p>
        </div>

        {!view.isActiveProvider && (
          <p className="t-label rounded-lg bg-hover px-3 py-2 text-muted">
            Beds24 במצב גיבוי (ספק לא פעיל) — ניתן להגדיר, לבדוק ולמפות, אך הפעלת סנכרון
            וייבוא חסומות עד לבחירתו כספק הפעיל בראש המסך.
          </p>
        )}

        {!view.secretsKeyConfigured && (
          <p className="t-label rounded-lg bg-status-danger-050 px-3 py-2 text-status-danger">
            מפתח ההצפנה בשרת (CHANNEL_SECRETS_KEY) אינו מוגדר — לא ניתן לשמור את החיבור עד להגדרתו.
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <dt className="t-label text-faint">כתובת בסיס</dt>
          <dd className="t-secondary truncate text-text2" title={view.baseUrl}>
            <bdi className="ltr-num font-mono">{view.baseUrl}</bdi>
          </dd>
          <dt className="t-label text-faint">תוקף טוקן הגישה (מטמון 24ש׳)</dt>
          <dd className="t-secondary text-text2">
            <bdi className="ltr-num">{fmt(view.accessTokenExpiresAt)}</bdi>
          </dd>
          <dt className="t-label text-faint">בדיקה מוצלחת אחרונה</dt>
          <dd className="t-secondary text-text2">
            <bdi className="ltr-num">{fmt(view.lastTestOkAt)}</bdi>
          </dd>
          <dt className="t-label text-faint">בדיקה כושלת אחרונה</dt>
          <dd className="t-secondary text-text2">
            <bdi className="ltr-num">{fmt(view.lastTestFailedAt)}</bdi>
          </dd>
        </dl>

        {status === "failed" && view.lastError && (
          <p role="alert" className="t-label rounded-lg bg-status-danger-050 px-3 py-2 text-status-danger">
            {view.lastError}
          </p>
        )}

        {/* The stored credential: READ-ONLY TEXT. Never an input, never the
            token — only the safe stored api_key_hint (refresh-token tail). */}
        <div className="flex flex-col gap-3">
          <p className="t-secondary text-text2">
            {view.configured ? (
              <>
                טוקן רענון מוגדר: <bdi className="ltr-num font-mono">{view.refreshTokenHint}</bdi>
              </>
            ) : (
              "חיבור Beds24 לא הוגדר"
            )}
          </p>

          {/* The invite-code input does not exist in the DOM until this click. */}
          {!configuring ? (
            <div>
              <button
                type="button"
                onClick={openConfigure}
                disabled={!view.secretsKeyConfigured || busy}
                className="btn btn-secondary"
              >
                {view.configured ? "החלפת חיבור (קוד הזמנה חדש)" : "הגדרת חיבור (קוד הזמנה)"}
              </button>
            </div>
          ) : (
            <Beds24InviteCodeForm
              key={mountId}
              configured={view.configured}
              disabled={!view.secretsKeyConfigured}
              onCancel={() => setConfiguring(false)}
              onSaved={onSaved}
            />
          )}
        </div>

        {/* Test connection — read-only probe of the STORED credential */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onTest}
            disabled={!view.configured || busy}
            className="btn btn-secondary"
          >
            <Icon name="refresh" size={20} />
            בדיקת חיבור
          </button>
          <button
            type="button"
            onClick={onLoadProperties}
            disabled={!view.configured || busy}
            className="btn btn-secondary"
          >
            <Icon name="list" size={20} />
            טעינת נכסים מ-Beds24
          </button>
          {msg && (
            <span className={`t-secondary ${msg.tone === "ok" ? "text-status-success" : "text-status-danger"}`}>
              {msg.text}
            </span>
          )}
        </div>

        {/* Room ↔ Beds24 room mapping */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Icon name="rooms" size={17} className="text-muted" />
            <h3 className="h4">מיפוי חדרים לחדרי Beds24</h3>
            <span className="chip chip-neutral">
              <bdi className="ltr-num">{view.mappedCount}/{activeRooms.length}</bdi> ממופים
            </span>
          </div>

          <div className="flex items-start gap-2.5 rounded-xl border border-line bg-primary-050 p-3">
            <Icon name="info" size={17} className="mt-0.5 shrink-0 text-primary" />
            <p className="t-label leading-relaxed text-text2">
              יחידת המיפוי היא <strong>החדר הפיזי</strong>: כל חדר משויך לחדר Beds24 אחד
              (נכס + חדר) ולתוכנית תעריף מקומית אחת שמחירה הוא המחיר שיסונכרן בשלב הבא.
              מטבע הנכס חייב להתאים למטבע תוכנית התעריף (
              <bdi className="ltr-num">{view.tenantCurrency}</bdi>).
            </p>
          </div>

          {properties === null && (
            <p className="t-label rounded-lg bg-hover px-3 py-2 text-muted">
              לחץ על &quot;טעינת נכסים מ-Beds24&quot; כדי לבחור חדרים למיפוי. מיפויים קיימים
              מוצגים גם ללא טעינה.
            </p>
          )}

          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[1080px] text-sm">
              <thead>
                <tr className="border-b border-line bg-hover/40">
                  <th className="t-label px-4 py-3 text-start text-faint">חדר</th>
                  <th className="t-label px-4 py-3 text-start text-faint">קטגוריה</th>
                  <th className="t-label px-4 py-3 text-start text-faint">קומה</th>
                  <th className="t-label px-4 py-3 text-start text-faint">נכס Beds24</th>
                  <th className="t-label px-4 py-3 text-start text-faint">חדר Beds24</th>
                  <th className="t-label px-4 py-3 text-start text-faint">מזהים</th>
                  <th className="t-label px-4 py-3 text-start text-faint">תוכנית תעריף</th>
                  <th className="t-label px-4 py-3 text-start text-faint">מטבע</th>
                  <th className="t-label px-4 py-3 text-start text-faint">סטטוס</th>
                  <th className="t-label px-4 py-3 text-start text-faint">עודכן</th>
                  <th className="t-label px-4 py-3 text-start text-faint">פעולות</th>
                </tr>
              </thead>
              <tbody>
                {activeRooms.map((r) => {
                  const mapping = mappingByRoom.get(r.roomId);
                  const d = draftOf(r.roomId);
                  const { propertyId: dPropertyId, roomId: dRoomId } = splitUnitKey(d.unitKey);
                  const statusMeta = MAPPING_STATUS_META[mapping?.status ?? "unmapped"];
                  const selectedProperty = properties?.find((p) => p.id === dPropertyId);
                  const selectedRoom = selectedProperty?.rooms.find((rm) => rm.id === dRoomId);
                  const thisBusy = rowBusy === r.roomId;
                  const editing = !mapping || editRows.has(r.roomId);
                  const unchanged =
                    !!mapping &&
                    unitKeyOf(mapping.beds24PropertyId, mapping.beds24RoomId) === d.unitKey &&
                    (mapping.localRatePlanId ?? "") === d.planId;
                  const planName = mapping?.localRatePlanId
                    ? (view.ratePlans.find((p) => p.id === mapping.localRatePlanId)?.name ?? "—")
                    : "—";
                  const idsShown = editing
                    ? d.unitKey
                      ? `${dPropertyId} · ${dRoomId}`
                      : "—"
                    : mapping
                      ? `${mapping.beds24PropertyId} · ${mapping.beds24RoomId}`
                      : "—";
                  return (
                    <tr key={r.roomId} className="border-b border-line last:border-0">
                      <td className="px-4 py-3 text-ink">
                        <bdi className="ltr-num font-bold">{r.roomNumber}</bdi>
                      </td>
                      <td className="px-4 py-3 text-text2">{r.categoryName ?? "—"}</td>
                      <td className="px-4 py-3 text-muted">
                        <bdi className="ltr-num">{r.floor ?? "—"}</bdi>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-ink">
                          {editing
                            ? (selectedProperty?.name ?? (dPropertyId || "—"))
                            : (mapping?.beds24PropertyName ?? mapping?.beds24PropertyId ?? "—")}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {editing ? (
                          properties ? (
                            <select
                              className="field-input min-w-[220px]"
                              value={d.unitKey}
                              onChange={(e) => setDraft(r.roomId, { unitKey: e.target.value })}
                              disabled={busy}
                              aria-label={`חדר Beds24 לחדר ${r.roomNumber}`}
                            >
                              <option value="">בחר חדר…</option>
                              {/* grouped: property → its rooms; option label =
                                  room name + room id */}
                              {properties.map((p) => (
                                <optgroup key={p.id} label={p.name ?? p.id}>
                                  {p.rooms.map((rm) => (
                                    <option key={rm.id} value={unitKeyOf(p.id, rm.id)}>
                                      {`${rm.name ?? "חדר"} (${rm.id})`}
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                              {/* a mapped unit missing from the fresh list stays selectable-visible */}
                              {d.unitKey &&
                                !properties.some(
                                  (p) => p.id === dPropertyId && p.rooms.some((rm) => rm.id === dRoomId),
                                ) && <option value={d.unitKey}>{d.unitKey}</option>}
                            </select>
                          ) : (
                            <span className="t-label text-muted">טען נכסים כדי לבחור</span>
                          )
                        ) : (
                          <span className="text-ink">
                            {mapping?.beds24RoomName ?? mapping?.beds24RoomId ?? "—"}
                          </span>
                        )}
                        {editing && selectedRoom && selectedRoom.maxPeople !== null && (
                          <p className="t-label mt-1 text-muted">
                            עד <bdi className="ltr-num">{selectedRoom.maxPeople}</bdi> אורחים
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <bdi className="ltr-num font-mono text-text2">{idsShown}</bdi>
                      </td>
                      <td className="px-4 py-3">
                        {editing ? (
                          <select
                            className="field-input min-w-[180px]"
                            value={d.planId}
                            onChange={(e) => setDraft(r.roomId, { planId: e.target.value })}
                            disabled={busy}
                            aria-label={`תוכנית תעריף לחדר ${r.roomNumber}`}
                          >
                            <option value="">בחר תוכנית…</option>
                            {view.ratePlans.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-text2">{planName}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted">
                        <bdi className="ltr-num">
                          {selectedProperty?.currency ?? mapping?.currency ?? "—"}
                        </bdi>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`chip ${statusMeta.cls}`}>
                          <span className="dot" />
                          {statusMeta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted">{fmt(mapping?.updatedAt ?? null)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {editing ? (
                            <>
                              <button
                                type="button"
                                onClick={() => onMap(r.roomId)}
                                disabled={
                                  busy || !dPropertyId || !dRoomId || !d.planId || unchanged || !properties
                                }
                                className="btn btn-sm btn-primary"
                              >
                                {thisBusy ? "ממפה…" : mapping ? "עדכון מיפוי" : "מיפוי"}
                              </button>
                              {mapping && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEditRows((prev) => {
                                      const next = new Set(prev);
                                      next.delete(r.roomId);
                                      return next;
                                    })
                                  }
                                  disabled={busy}
                                  className="btn btn-sm btn-secondary"
                                >
                                  ביטול עריכה
                                </button>
                              )}
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  setEditRows((prev) => new Set(prev).add(r.roomId))
                                }
                                disabled={busy}
                                className="btn btn-sm btn-secondary"
                              >
                                שינוי
                              </button>
                              <button
                                type="button"
                                onClick={() => onUnmap(r.roomId)}
                                disabled={busy}
                                className="btn btn-sm btn-secondary"
                              >
                                ביטול מיפוי
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {activeRooms.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-4 py-6 text-center text-sm text-muted">
                      אין חדרים פעילים להצגה.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ---- Activation (D79): Full Sync + poll-only inbound import ---- */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Icon name="refresh" size={17} className="text-muted" />
            <h3 className="h4">הפעלת סנכרון Beds24</h3>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            <dt className="t-label text-faint">סנכרון יוצא (ARI)</dt>
            <dd className="t-secondary text-text2">
              {view.outboundEnabled ? "פעיל — סנכרון מצטבר רץ" : view.fullSyncRequired ? "נדרש סנכרון מלא" : "לא פעיל"}
            </dd>
            <dt className="t-label text-faint">סנכרון מלא מוצלח אחרון</dt>
            <dd className="t-secondary text-text2">
              <bdi className="ltr-num">{fmt(view.lastOutboundSyncAt)}</bdi>
            </dd>
            <dt className="t-label text-faint">ייבוא הזמנות נכנס</dt>
            <dd className="t-secondary text-text2">
              {view.inboundEnabled ? "פעיל — משיכה כל כ-5 דקות" : "כבוי"}
            </dd>
            <dt className="t-label text-faint">ייבוא אחרון</dt>
            <dd className="t-secondary text-text2">
              <bdi className="ltr-num">{fmt(view.lastInboundImportAt)}</bdi>
            </dd>
          </dl>

          <p className="t-label rounded-lg bg-hover px-3 py-2 text-muted">
            ל-Beds24 אין webhook — ההזמנות נמשכות אוטומטית כל כ-5 דקות על-ידי עובד הרקע.
            אין כתובת לרשום ואין טוקן להעתיק.
          </p>

          {/* THE Full Sync control — §12 inline-confirm pattern:
              trigger is secondary; confirm is primary. */}
          <div className="flex flex-wrap items-center gap-2">
            {!confirmingSync ? (
              <button
                type="button"
                onClick={() => setConfirmingSync(true)}
                disabled={busy || !canFullSync || view.fullSyncRunning}
                aria-disabled={busy || !canFullSync || view.fullSyncRunning}
                className="btn btn-secondary"
                title={!view.isActiveProvider ? "Beds24 אינו הספק הפעיל — בחר אותו בראש המסך תחילה" : undefined}
              >
                {view.fullSyncRunning ? "סנכרון מלא כבר מתבצע" : "סנכרון מלא"}
              </button>
            ) : (
              <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
                <p className="t-secondary text-text2">
                  יישלחו דרך Beds24 ליומני Booking.com <strong>החיים</strong> המחירים
                  והזמינות הקנוניים של החדרים הממופים (<bdi className="ltr-num">{view.mappedCount}</bdi>),
                  לפי תוכנית התעריף שנבחרה לכל חדר. ריצה נקייה מפעילה את הסנכרון המצטבר
                  אוטומטית. הפעולה אינה משנה מחיר, חדר, תוכנית או הזמנה ב-GuestHub.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onConfirmFullSync}
                    disabled={busy}
                    aria-disabled={busy}
                    className="btn btn-primary"
                  >
                    בצע סנכרון מלא
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingSync(false)}
                    disabled={pending}
                    className="btn btn-secondary"
                  >
                    ביטול
                  </button>
                </div>
              </div>
            )}

            {!view.inboundEnabled ? (
              <button
                type="button"
                onClick={onEnableInbound}
                disabled={
                  busy ||
                  !view.isActiveProvider ||
                  (view.state !== "ready" && view.state !== "active") ||
                  view.mappedCount === 0
                }
                className="btn btn-secondary"
                title={
                  !view.isActiveProvider
                    ? "Beds24 אינו הספק הפעיל — בחר אותו בראש המסך תחילה"
                    : view.state !== "ready" && view.state !== "active"
                      ? "הזן קוד הזמנה והרץ בדיקת חיבור תחילה"
                      : view.mappedCount === 0
                        ? "מפה חדר אחד לפחות תחילה"
                        : undefined
                }
              >
                הפעלת ייבוא הזמנות
              </button>
            ) : (
              <button type="button" onClick={onDisableInbound} disabled={busy} className="btn btn-secondary">
                כיבוי ייבוא הזמנות
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
