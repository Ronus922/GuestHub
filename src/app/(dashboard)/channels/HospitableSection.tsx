"use client";

import { useState, useTransition } from "react";
import { Icon, type IconName } from "@/components/shared/Icon";
import {
  getHospitableConnectionAction,
  testHospitableConnectionAction,
  listHospitablePropertiesAction,
  mapHospitablePropertyAction,
  unmapHospitablePropertyAction,
  enableHospitableInboundAction,
  disableHospitableInboundAction,
  runHospitableFullSyncAction,
  type HospitableConnectionView,
} from "@/lib/channel/hospitable-admin";
import type { HospitablePropertySummary } from "@/lib/channel/hospitable-properties";
import { HospitableKeyReplacementForm } from "./HospitableKeyReplacementForm";

// Hospitable PRODUCTION connection card (D77) — super_admin only (the page
// gates on canManageChannels; every action re-checks server-side). Mirror of
// ChannexStagingSection: the PAT is never sent back here; only the masked hint,
// the decoded expiry and sanitized status are shown.
//
// The PAT input is NOT permanently mounted (same D70 password-manager defence
// as Channex) — see ./HospitableKeyReplacementForm.
//
// "בדיקת חיבור" takes NO argument: it always decrypts and uses the STORED
// token server-side (GET /user + GET /properties — read-only, never a write).
//
// Mapping model: one PHYSICAL ROOM ↔ one Hospitable property UUID + ONE local
// pricing plan. The properties list loads only on explicit click — page load
// performs no Hospitable call.

const dtFmt = new Intl.DateTimeFormat("he-IL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Jerusalem",
});
const dFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeZone: "Asia/Jerusalem" });
const fmt = (v: string | null) => (v ? dtFmt.format(new Date(v)) : "—");
const fmtDate = (v: string | null) => (v ? dFmt.format(new Date(v)) : "—");

type Status = "not_configured" | "configured" | "testing" | "connected" | "failed";

// Same-building units often share one public name — the label prefers the
// internal name, appends the address line, and when the result STILL collides
// (or nothing but the public name exists) appends the UUID tail so every
// option is visually distinct and the operator can cross-check in Hospitable.
function propertyLabels(
  properties: HospitablePropertySummary[],
): { property: HospitablePropertySummary; label: string }[] {
  const base = properties.map((p) => {
    const name = p.name ?? p.publicName ?? p.id;
    // host tags first — hosts tag units with their apartment number, which is
    // the ONLY human-meaningful discriminator inside one building
    const tagPrefix = p.tags.length > 0 ? `[${p.tags.join(" ")}] ` : "";
    const cap =
      p.bedrooms !== null || p.maxGuests !== null
        ? ` · ${p.bedrooms ?? "?"} חד׳ · עד ${p.maxGuests ?? "?"} אורחים`
        : "";
    return {
      property: p,
      label: `${tagPrefix}${name}${p.addressLine ? ` · ${p.addressLine}` : ""}${cap}`,
    };
  });
  const counts = new Map<string, number>();
  for (const b of base) counts.set(b.label, (counts.get(b.label) ?? 0) + 1);
  return base.map((b) =>
    (counts.get(b.label) ?? 0) > 1
      ? { ...b, label: `${b.label} · ‎…${b.property.id.slice(-6)}` }
      : b,
  );
}

function deriveStatus(v: HospitableConnectionView, testing: boolean): Status {
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

const EXPIRY_WARN_DAYS = 30;

type Msg = { tone: "ok" | "err"; text: string } | null;
type Draft = { propertyId: string; planId: string };

export function HospitableSection({ initial }: { initial: HospitableConnectionView }) {
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);

  // Same mount discipline as the Channex card: the replacement field exists only
  // after an explicit click; `mountId` forces a brand-new instance per open.
  const [replacing, setReplacing] = useState(false);
  const [mountId, setMountId] = useState(0);

  // Properties load ONLY on explicit click — never on page load.
  const [properties, setProperties] = useState<HospitablePropertySummary[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // mapped rows render as a static, Channex-style row; "שינוי" opens the selects
  const [editRows, setEditRows] = useState<Set<string>>(new Set());
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  // Activation (F4): inline Full-Sync confirm (§12 pattern from AriSyncSection)
  // + the ONE-TIME webhook URL. The URL exists only in this state, only after an
  // enable that minted a token; a refresh loses it forever (stored hashed only).
  const [confirmingSync, setConfirmingSync] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);

  const status = deriveStatus(view, testing);
  const meta = STATUS_META[status];
  const busy = pending || rowBusy !== null;

  const mappingByRoom = new Map(view.mappings.map((m) => [m.roomId, m]));
  const days = view.apiKeyExpiresInDays;
  const expired = days !== null && days <= 0;
  const expiringSoon = days !== null && days > 0 && days <= EXPIRY_WARN_DAYS;

  async function reload() {
    const res = await getHospitableConnectionAction();
    if (res.success && res.data) setView(res.data);
  }

  function openReplace() {
    setMsg(null);
    setMountId((n) => n + 1);
    setReplacing(true);
  }

  function onSaved(hint: string) {
    setReplacing(false); // unmount: the new secret is never rendered again
    setView((v) => ({
      ...v,
      configured: true,
      apiKeyHint: hint,
      state: "configured",
      lastTestOkAt: null,
      lastTestFailedAt: null,
      lastTestErrorCode: null,
      lastError: null,
    }));
    setMsg({ tone: "ok", text: "הטוקן נשמר מוצפן — הפעל בדיקת חיבור לאימותו" });
    // the decoded expiry is server-computed — refresh the masked view to show it
    startTransition(reload);
  }

  function onTest() {
    setMsg(null);
    setTesting(true);
    startTransition(async () => {
      const res = await testHospitableConnectionAction();
      setTesting(false);
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      const nowIso = new Date().toISOString();
      if (res.data!.ok) {
        setView((v) => ({ ...v, state: "ready", lastTestOkAt: nowIso, lastTestErrorCode: null, lastError: null }));
        setMsg({ tone: "ok", text: `מחובר — ${res.data!.propertyCount} נכסים נגישים` });
      } else {
        setView((v) => ({
          ...v,
          state: "error",
          lastTestFailedAt: nowIso,
          lastTestErrorCode: res.data!.category ?? null,
          lastError: res.data!.message ?? null,
        }));
        setMsg({ tone: "err", text: res.data!.message ?? "החיבור נכשל" });
      }
    });
  }

  function onLoadProperties() {
    setMsg(null);
    startTransition(async () => {
      const res = await listHospitablePropertiesAction();
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      setProperties(res.data!.properties);
      setMsg({ tone: "ok", text: `נטענו ${res.data!.properties.length} נכסים מ-Hospitable` });
    });
  }

  function draftOf(roomId: string): Draft {
    const existing = mappingByRoom.get(roomId);
    return (
      drafts[roomId] ?? {
        propertyId: existing?.hospitablePropertyId ?? "",
        planId: existing?.localRatePlanId ?? "",
      }
    );
  }

  function setDraft(roomId: string, patch: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [roomId]: { ...draftOf(roomId), ...patch } }));
  }

  function onMap(roomId: string) {
    const d = draftOf(roomId);
    if (!d.propertyId || !d.planId || rowBusy) return;
    setMsg(null);
    setRowBusy(roomId);
    startTransition(async () => {
      try {
        const res = await mapHospitablePropertyAction({
          roomId,
          hospitablePropertyId: d.propertyId,
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
        setMsg({ tone: "ok", text: "החדר מופה לנכס Hospitable" });
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
        const res = await unmapHospitablePropertyAction({ roomId });
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
      const res = await runHospitableFullSyncAction();
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
    setWebhookUrl(null);
    startTransition(async () => {
      const res = await enableHospitableInboundAction();
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      await reload();
      setWebhookUrl(res.data!.webhookUrl);
      setMsg({
        tone: res.data!.webhookWarning ? "err" : "ok",
        text: res.data!.webhookWarning ?? "ייבוא הזמנות הופעל",
      });
    });
  }

  function onDisableInbound() {
    setMsg(null);
    setWebhookUrl(null);
    startTransition(async () => {
      const res = await disableHospitableInboundAction();
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      await reload();
      setMsg({ tone: "ok", text: "ייבוא הזמנות כובה וכתובת ה-webhook בוטלה" });
    });
  }

  const activeRooms = view.rooms.filter((r) => r.isActive);
  const canFullSync =
    (view.state === "ready" || view.state === "active") && view.mappedCount > 0;

  return (
    <section className="card">
      <div className="card-hd justify-between">
        <div className="flex items-center gap-2">
          <span className="h4">חיבור Hospitable</span>
          <span className="chip chip-transfer">Production</span>
        </div>
        <span className={`chip ${meta.cls}`}>
          <Icon name={meta.icon} size={13.5} />
          {meta.label}
        </span>
      </div>

      <div className="card-bd flex flex-col gap-4">
        {/* Production notice — unlike Channex Staging, this IS the live account */}
        <div className="flex items-start gap-2.5 rounded-xl border border-status-warning bg-status-warning-050 p-3">
          <Icon name="warning" size={17} className="mt-0.5 shrink-0 text-status-warning" />
          <p className="t-label leading-relaxed text-status-warning">
            ל-Hospitable אין סביבת בדיקות — זהו חיבור לחשבון <strong>הייצור</strong> האמיתי.
            &quot;סנכרון מלא&quot; שולח את המחירים, ההגבלות והזמינות הקנוניים ליומני Hospitable
            החיים; שאר הפעולות בכרטיס (בדיקה, רשימת נכסים, מיפוי) הן קריאה בלבד.
          </p>
        </div>

        {!view.secretsKeyConfigured && (
          <p className="t-label rounded-lg bg-status-danger-050 px-3 py-2 text-status-danger">
            מפתח ההצפנה בשרת (CHANNEL_SECRETS_KEY) אינו מוגדר — לא ניתן לשמור טוקן PAT עד להגדרתו.
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <dt className="t-label text-faint">כתובת בסיס</dt>
          <dd className="t-secondary truncate text-text2" title={view.baseUrl}>
            <bdi className="ltr-num font-mono">{view.baseUrl}</bdi>
          </dd>
          <dt className="t-label text-faint">תוקף הטוקן</dt>
          <dd className="t-secondary text-text2">
            <bdi className="ltr-num">{fmtDate(view.apiKeyExpiresAt)}</bdi>
            {expired && (
              <span className="chip chip-failed ms-2">
                <span className="dot" />
                פג תוקף
              </span>
            )}
            {expiringSoon && (
              <span className="chip chip-approval ms-2">
                <span className="dot" />
                פג בעוד <bdi className="ltr-num">{days}</bdi> ימים
              </span>
            )}
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

        {/* ≥30-day expiry warning (server-computed days — no client clock) */}
        {(expired || expiringSoon) && (
          <div
            className={`flex items-start gap-2.5 rounded-xl border p-3 ${
              expired
                ? "border-status-danger bg-status-danger-050"
                : "border-status-warning bg-status-warning-050"
            }`}
          >
            <Icon
              name="warning"
              size={17}
              className={`mt-0.5 shrink-0 ${expired ? "text-status-danger" : "text-status-warning"}`}
            />
            <p className={`t-label leading-relaxed ${expired ? "text-status-danger" : "text-status-warning"}`}>
              {expired ? (
                <>טוקן ה-PAT פג תוקף — הסנכרון ייכשל עד להנפקת טוקן חדש ב-Hospitable ושמירתו כאן.</>
              ) : (
                <>
                  טוקן ה-PAT יפוג בעוד <bdi className="ltr-num">{days}</bdi> ימים. הנפק טוקן חדש
                  ב-Hospitable ושמור אותו כאן לפני מועד התפוגה כדי למנוע נפילת סנכרון.
                </>
              )}
            </p>
          </div>
        )}

        {status === "failed" && view.lastError && (
          <p role="alert" className="t-label rounded-lg bg-status-danger-050 px-3 py-2 text-status-danger">
            {view.lastError}
          </p>
        )}

        {/* The stored token: READ-ONLY TEXT. Never an input, never the token —
            only the safe stored api_key_hint. */}
        <div className="flex flex-col gap-3">
          <p className="t-secondary text-text2">
            {view.configured ? (
              <>
                טוקן PAT מוגדר: <bdi className="ltr-num font-mono">{view.apiKeyHint}</bdi>
              </>
            ) : (
              "טוקן PAT לא הוגדר"
            )}
          </p>

          {/* The replacement input does not exist in the DOM until this click. */}
          {!replacing ? (
            <div>
              <button
                type="button"
                onClick={openReplace}
                disabled={!view.secretsKeyConfigured || busy}
                className="btn btn-secondary"
              >
                {view.configured ? "החלפת טוקן PAT" : "הגדרת טוקן PAT"}
              </button>
            </div>
          ) : (
            <HospitableKeyReplacementForm
              key={mountId}
              configured={view.configured}
              disabled={!view.secretsKeyConfigured}
              onCancel={() => setReplacing(false)}
              onSaved={onSaved}
            />
          )}
        </div>

        {/* Test connection — read-only probe of the STORED token */}
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
            טעינת נכסים מ-Hospitable
          </button>
          {msg && (
            <span className={`t-secondary ${msg.tone === "ok" ? "text-status-success" : "text-status-danger"}`}>
              {msg.text}
            </span>
          )}
        </div>

        {/* Room ↔ property mapping */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Icon name="rooms" size={17} className="text-muted" />
            <h3 className="h4">מיפוי חדרים לנכסי Hospitable</h3>
            <span className="chip chip-neutral">
              <bdi className="ltr-num">{view.mappedCount}/{activeRooms.length}</bdi> ממופים
            </span>
          </div>

          <div className="flex items-start gap-2.5 rounded-xl border border-line bg-primary-050 p-3">
            <Icon name="info" size={17} className="mt-0.5 shrink-0 text-primary" />
            <p className="t-label leading-relaxed text-text2">
              יחידת המיפוי היא <strong>החדר הפיזי</strong>: כל חדר משויך לנכס Hospitable אחד (UUID)
              ולתוכנית תעריף מקומית אחת שמחירה הוא המחיר שיסונכרן. נכס עם{" "}
              <bdi className="font-mono">calendar_restricted</bdi> אינו ניתן למיפוי, ומטבע הנכס חייב
              להתאים למטבע תוכנית התעריף (<bdi className="ltr-num">{view.tenantCurrency}</bdi>).
            </p>
          </div>

          {properties === null && (
            <p className="t-label rounded-lg bg-hover px-3 py-2 text-muted">
              לחץ על &quot;טעינת נכסים מ-Hospitable&quot; כדי לבחור נכסים למיפוי. מיפויים קיימים
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
                  <th className="t-label px-4 py-3 text-start text-faint">נכס Hospitable</th>
                  <th className="t-label px-4 py-3 text-start text-faint">מזהה Hospitable</th>
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
                  const statusMeta = MAPPING_STATUS_META[mapping?.status ?? "unmapped"];
                  const selected = properties?.find((p) => p.id === d.propertyId);
                  const thisBusy = rowBusy === r.roomId;
                  const editing = !mapping || editRows.has(r.roomId);
                  const unchanged =
                    !!mapping &&
                    mapping.hospitablePropertyId === d.propertyId &&
                    (mapping.localRatePlanId ?? "") === d.planId;
                  const planName = mapping?.localRatePlanId
                    ? (view.ratePlans.find((p) => p.id === mapping.localRatePlanId)?.name ?? "—")
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
                        {editing ? (
                          properties ? (
                            <select
                              className="field-input min-w-[220px]"
                              value={d.propertyId}
                              onChange={(e) => setDraft(r.roomId, { propertyId: e.target.value })}
                              disabled={busy}
                              aria-label={`נכס Hospitable לחדר ${r.roomNumber}`}
                            >
                              <option value="">בחר נכס…</option>
                              {propertyLabels(properties).map(({ property: p, label }) => (
                                <option key={p.id} value={p.id} disabled={p.calendarRestricted}>
                                  {label + (p.calendarRestricted ? " — מוגבל יומן" : "")}
                                </option>
                              ))}
                              {/* a mapped id missing from the fresh list stays selectable-visible */}
                              {d.propertyId && !properties.some((p) => p.id === d.propertyId) && (
                                <option value={d.propertyId}>{d.propertyId}</option>
                              )}
                            </select>
                          ) : (
                            <span className="t-label text-muted">טען נכסים כדי לבחור</span>
                          )
                        ) : null}
                        {editing && selected ? (
                          /* identification card — recognise the unit by PHOTO before mapping */
                          <div className="mt-2 flex items-center gap-3 rounded-lg border border-line bg-hover/30 p-2">
                            {selected.pictureUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element -- external Hospitable CDN, display-only thumbnail
                              <img
                                src={selected.pictureUrl}
                                alt={selected.name ?? "נכס Hospitable"}
                                className="h-14 w-20 shrink-0 rounded-md object-cover"
                              />
                            ) : null}
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span className="t-label truncate text-ink">
                                {selected.name ?? selected.publicName ?? selected.id}
                              </span>
                              <span className="t-label text-muted">
                                {[
                                  selected.addressLine,
                                  selected.bedrooms !== null ? `${selected.bedrooms} חד׳` : null,
                                  selected.maxGuests !== null ? `עד ${selected.maxGuests} אורחים` : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || "—"}
                              </span>
                              <a
                                href={`https://my.hospitable.com/properties/${selected.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="t-label text-primary underline-offset-2 hover:underline"
                              >
                                פתח ב-Hospitable לאימות ↗
                              </a>
                            </div>
                          </div>
                        ) : null}
                        {!editing ? (
                          <span className="text-ink">
                            {mapping?.hospitablePropertyName ??
                              properties?.find((p) => p.id === mapping?.hospitablePropertyId)?.name ??
                              "—"}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <bdi className="ltr-num font-mono text-text2">
                          {(editing ? d.propertyId : mapping?.hospitablePropertyId) || "—"}
                        </bdi>
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
                        <bdi className="ltr-num">{selected?.currency ?? mapping?.currency ?? "—"}</bdi>
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
                                disabled={busy || !d.propertyId || !d.planId || unchanged || !properties}
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
                    <td colSpan={10} className="px-4 py-6 text-center text-sm text-muted">
                      אין חדרים פעילים להצגה.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ---- Activation (F4): Full Sync + inbound import ---- */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Icon name="refresh" size={17} className="text-muted" />
            <h3 className="h4">הפעלת סנכרון Hospitable</h3>
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
            <dd className="t-secondary text-text2">{view.inboundEnabled ? "פעיל" : "כבוי"}</dd>
            <dt className="t-label text-faint">כתובת Webhook</dt>
            <dd className="t-secondary truncate text-text2">
              {view.callbackDisplay ? (
                <bdi className="ltr-num font-mono">{view.callbackDisplay}</bdi>
              ) : (
                "לא נוצרה"
              )}
            </dd>
          </dl>

          {/* THE Full Sync control — same §12 inline-confirm pattern as the
              Channex AriSyncSection: trigger is secondary; confirm is primary. */}
          <div className="flex flex-wrap items-center gap-2">
            {!confirmingSync ? (
              <button
                type="button"
                onClick={() => setConfirmingSync(true)}
                disabled={busy || !canFullSync || view.fullSyncRunning}
                aria-disabled={busy || !canFullSync || view.fullSyncRunning}
                className="btn btn-secondary"
              >
                {view.fullSyncRunning ? "סנכרון מלא כבר מתבצע" : "סנכרון מלא"}
              </button>
            ) : (
              <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
                <p className="t-secondary text-text2">
                  יישלחו ליומני Hospitable <strong>החיים</strong> המחירים, ההגבלות והזמינות
                  הקנוניים של החדרים הממופים (<bdi className="ltr-num">{view.mappedCount}</bdi>),
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
                disabled={busy || (view.state !== "ready" && view.state !== "active") || view.mappedCount === 0}
                className="btn btn-secondary"
                title={
                  view.state !== "ready" && view.state !== "active"
                    ? "שמור טוקן והרץ בדיקת חיבור תחילה"
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

          {/* ONE-TIME webhook URL — exists only right after an enable that
              minted a token; stored hashed, never displayable again. */}
          {webhookUrl && (
            <div className="flex flex-col gap-2 rounded-xl border border-status-warning bg-status-warning-050 p-4">
              <p className="t-secondary text-status-warning">
                כתובת ה-webhook נוצרה — <strong>היא מוצגת פעם אחת בלבד</strong>. העתק אותה ורשום
                אותה ידנית בממשק Hospitable (Apps → Webhooks). לאחר רענון הדף לא ניתן לשחזר אותה;
                סיבוב (rotation) מתבצע ע&quot;י כיבוי והפעלה מחדש של הייבוא.
              </p>
              <p className="break-all rounded-lg bg-surface px-3 py-2">
                <bdi className="ltr-num font-mono text-ink">{webhookUrl}</bdi>
              </p>
              <p className="t-label text-status-warning">
                גם ללא webhook, עובד הרקע מושך הזמנות תקופתית — ה-webhook רק מזרז את הייבוא.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
