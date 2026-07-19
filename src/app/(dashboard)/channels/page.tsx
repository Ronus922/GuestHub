import { redirect } from "next/navigation";
import Link from "next/link";
import { getActor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import {
  getAriSyncStatusAction,
  getChannelStatusAction,
  getChannexConnectionAction,
  getChannexPropertyContextAction,
} from "@/lib/channel/admin";
import { getChannexRoomSyncContextAction } from "@/lib/channel/room-type-admin";
import { getChannexRatePlanSyncContextAction } from "@/lib/channel/rate-plan-admin";
import { getInboundStatusAction } from "@/lib/channel/inbound-admin";
import { getExternalChangesAction } from "@/lib/channel/external-changes-admin";
import { getCertificationEvidenceAction } from "@/lib/channel/certification";
import { getHospitableConnectionAction } from "@/lib/channel/hospitable-admin";
import { getBeds24ConnectionAction } from "@/lib/channel/beds24-admin";
import { Icon } from "@/components/shared/Icon";
import { ChannexStagingSection } from "./ChannexStagingSection";
import { HospitableSection } from "./HospitableSection";
import { Beds24Section } from "./Beds24Section";
import { ChannexPropertySection } from "./ChannexPropertySection";
import { ChannexRoomTypesSection } from "./ChannexRoomTypesSection";
import { ChannexRatePlansSection } from "./ChannexRatePlansSection";
import { AriSyncSection } from "./AriSyncSection";
import { InboundBookingsSection } from "./InboundBookingsSection";
import { ExternalChangesSection } from "./ExternalChangesSection";
import { CertificationConsoleSection } from "./CertificationConsoleSection";

export const dynamic = "force-dynamic";

// D77 — Hospitable is the live provider; the whole Channex operator surface is
// HIDDEN (not removed) while its connection/data stay intact. Flip to true to
// bring every Channex card back exactly as it was.
const SHOW_CHANNEX = false;

// /channels — Channel Manager DIAGNOSTIC screen (§AA observability). DISPLAY-ONLY,
// super_admin only. This screen diagnoses channel sync (connection state, mapping
// completeness, queue health, recent errors) — it is NOT the rate editor (that is the
// Rate Grid at /rates). In this phase no channel is active: mapping/test/retry/
// reconcile are Phase 4B, shown here as disabled "בקרוב" affordances wired to nothing.
// No secrets are rendered beyond the already-masked api_key_hint. No Channex/HTTP call.

type ConnectionRow = {
  id: string;
  provider: string;
  environment: string;
  state: string;
  channex_property_id: string | null;
  outbound_sync_enabled: boolean;
  inbound_sync_enabled: boolean;
  full_sync_required: boolean;
  api_key_hint: string | null;
  last_outbound_sync_at: string | Date | null;
  last_inbound_import_at: string | Date | null;
  last_reconciliation_at: string | Date | null;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type CountsRow = {
  pending_jobs: number;
  failed_jobs: number;
  dead_letter_jobs: number;
  dirty_ranges: number;
  room_categories: number;
  active_rooms: number;
  mapped_rooms: number;
  channex_room_types: number;
  quarantined_revisions: number;
};

type SyncErrorRow = {
  id: string;
  connection_id: string | null;
  room_type_id: string | null;
  date_from: string | Date | null;
  date_to: string | Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string | Date;
};

type ChannelStatus = {
  connections: ConnectionRow[];
  counts: CountsRow;
  errors: SyncErrorRow[];
};

const dtFormatter = new Intl.DateTimeFormat("he-IL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Jerusalem",
});
const dFormatter = new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeZone: "Asia/Jerusalem" });

function fmtDateTime(v: string | Date | null): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? "—" : dtFormatter.format(d);
}

function fmtDate(v: string | Date | null): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? "—" : dFormatter.format(d);
}

const STATE_LABELS: Record<string, { label: string; tone: "success" | "warning" | "muted" }> = {
  active: { label: "פעיל", tone: "success" },
  configured: { label: "מוגדר — לא פעיל", tone: "warning" },
  disconnected: { label: "מנותק", tone: "muted" },
};

// §3 — every badge is the canonical .chip wearing one of the §3.1 triplets.
const TONE_CHIP: Record<"success" | "warning" | "muted", string> = {
  success: "chip-paid",
  warning: "chip-approval",
  muted: "chip-cancelled",
};

function stateBadge(state: string) {
  const s = STATE_LABELS[state] ?? { label: state, tone: "muted" as const };
  return (
    <span className={`chip ${TONE_CHIP[s.tone]}`}>
      <span className="dot" />
      {s.label}
    </span>
  );
}

export default async function ChannelsPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  // Same gate the server action enforces (canManageChannels — super_admin ONLY;
  // admin does NOT qualify). UI hiding is not security: this is the real boundary.
  if (!canManageChannels({ userId: actor.userId, roleKey: actor.roleKey }).ok) redirect("/dashboard");

  // Every one of these is a DB read. Loading /channels performs no Channex call
  // and creates nothing upstream.
  const [res, channex, channexProperty, roomSync, ratePlanSync, inbound, externalChanges, certification, hospitable, beds24] =
    await Promise.all([
      getChannelStatusAction(),
      getChannexConnectionAction(),
      getChannexPropertyContextAction(),
      getChannexRoomSyncContextAction(),
      getChannexRatePlanSyncContextAction(),
      getInboundStatusAction(),
      getExternalChangesAction(),
      getCertificationEvidenceAction({ limit: 100 }),
      getHospitableConnectionAction(),
      getBeds24ConnectionAction(),
    ]);

  // ARI status hangs off the one Channex connection this tenant has (the row is
  // UNIQUE per tenant+provider+environment). Still a pure DB read.
  const channexConnectionId = res.success
    ? (res.data as ChannelStatus).connections.find((c) => c.provider === "channex")?.id ?? null
    : null;
  const ari = channexConnectionId ? await getAriSyncStatusAction(channexConnectionId) : null;
  const ariStatus = ari?.success ? ari.data ?? null : null;

  return (
    <div className="flex flex-col gap-5 p-[26px]" dir="rtl">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="h1">ערוצים</h1>
        <p className="t-secondary">אבחון וסנכרון מנהל הערוצים (Channel Manager)</p>
      </div>

      {/* Scope note — this is a diagnostics screen, not the rate editor */}
      <div className="flex items-start gap-3 rounded-2xl border border-line bg-primary-050 p-4">
        <Icon name="info" size={20} className="mt-0.5 shrink-0 text-primary" />
        <div className="t-secondary leading-relaxed">
          מסך זה <strong>מציג ומאבחן</strong> את מצב הסנכרון מול ערוצי ההפצה — סטטוס חיבור,
          שלמות המיפוי, תקינות התור והשגיאות האחרונות. הוא <strong>אינו עורך התעריפים</strong>;
          מחירים, הגבלות וזמינות נקבעים אך ורק ב&quot;עדכון קבוצתי&quot; שברשת התעריפים{" "}
          <Link href="/rates" className="font-bold text-primary hover:underline">
            /rates
          </Link>{" "}
          וב
          <Link href="/rate-plans" className="font-bold text-primary hover:underline">
            /rate-plans
          </Link>
          , ומשם מסונכרנים לערוץ אוטומטית ברקע. הסנכרון המלא הראשוני מופעל ידנית מכרטיס
          &quot;סנכרון ARI&quot; שלמטה.
        </div>
      </div>

      {/* Channex Staging connection — secure credential + real test (D59) */}
      {SHOW_CHANNEX && channex.success && <ChannexStagingSection initial={channex.data!} />}

      {/* Channex Staging property mapping — existing tenant → one Channex property (D60) */}
      {SHOW_CHANNEX && channexProperty.success && <ChannexPropertySection initial={channexProperty.data!} />}

      {/* Physical room → Channex Room Type synchronization (D64) */}
      {SHOW_CHANNEX && roomSync.success && <ChannexRoomTypesSection initial={roomSync.data!} />}

      {/* (Local Rate Plan × mapped room) → Channex Rate Plan synchronization (D65) */}
      {SHOW_CHANNEX && ratePlanSync.success && <ChannexRatePlansSection initial={ratePlanSync.data!} />}

      {/* ARI status + THE Full Sync control (D68). Replaces the disabled
          "סנכרון מלא · בקרוב" placeholder. Reconcile stays out of scope. */}
      {SHOW_CHANNEX && channexConnectionId && ariStatus && (
        <AriSyncSection connectionId={channexConnectionId} initial={ariStatus} />
      )}

      {/* Inbound OTA bookings — Channex status + manual pull (D76). */}
      {SHOW_CHANNEX && inbound.success && <InboundBookingsSection initial={inbound.data!} />}

      {/* External date changes from the OTA — pending reconciliation + ops email
          (D82). Provider-agnostic: the Hospitable inbound writes these too. */}
      {externalChanges.success && <ExternalChangesSection initial={externalChanges.data!} />}

      {/* Read-only Channex certification console — evidence ledger (§13). */}
      {SHOW_CHANNEX && certification.success && <CertificationConsoleSection initial={certification.data!} />}

      {/* Hospitable PRODUCTION connection + room↔property mapping (D77). A second
          provider alongside Channex; page load is still a pure DB read — the
          Hospitable properties list loads only on explicit operator click. */}
      {hospitable.success && <HospitableSection initial={hospitable.data!} />}

      {/* Beds24 PRODUCTION connection + room↔room mapping (D78) — read-only
          phase: invite-code setup, token cache, test, mapping. No sync yet.
          Page load is still a pure DB read — the Beds24 properties list loads
          only on explicit operator click. */}
      {beds24.success && <Beds24Section initial={beds24.data!} />}

      {!res.success ? (
        <div className="flex items-start gap-3 rounded-2xl border border-status-danger bg-status-danger-050 p-4">
          <Icon name="warning" size={20} className="mt-0.5 shrink-0 text-status-danger" />
          <p className="t-secondary text-status-danger">{res.error}</p>
        </div>
      ) : (
        <StatusView data={res.data as ChannelStatus} />
      )}
    </div>
  );
}

function StatusView({ data }: { data: ChannelStatus }) {
  const { counts, errors } = data;
  // Channex hidden (D77): its connection card disappears with the rest of the
  // Channex surface; queue/health/error cards stay — they are provider-neutral.
  const connections = SHOW_CHANNEX
    ? data.connections
    : data.connections.filter((c) => c.provider !== "channex");

  const statCards: { label: string; value: number; danger?: boolean }[] = [
    { label: "עבודות ממתינות", value: counts.pending_jobs },
    { label: "עבודות שנכשלו", value: counts.failed_jobs, danger: counts.failed_jobs > 0 },
    { label: "בהמתנה סופית (dead-letter)", value: counts.dead_letter_jobs, danger: counts.dead_letter_jobs > 0 },
    { label: "טווחים ממתינים לסנכרון", value: counts.dirty_ranges },
    { label: "הזמנות בהסגר (quarantine)", value: counts.quarantined_revisions, danger: counts.quarantined_revisions > 0 },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Connections */}
      <section className="flex flex-col gap-3">
        <h2 className="h3">חיבורי ערוצים</h2>
        {connections.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <div className="grid h-16 w-16 place-items-center rounded-2xl bg-hover">
                <Icon name="channels" size={24} className="text-faint" />
              </div>
              <p className="empty-t">לא מחובר — אין חיבור ערוצים פעיל</p>
              <p className="empty-s max-w-md">
                לא הוגדר אף חיבור לערוץ הפצה. זהו המצב הצפוי בשלב זה — הקמת חיבור, מיפוי
                וסנכרון יתווספו בשלב הבא (Phase 4B).
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {connections.map((c) => (
              <div key={c.id} className="card">
                <div className="card-bd flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="h4">
                      <bdi>{c.provider}</bdi> · <bdi>{c.environment}</bdi>
                    </span>
                    {stateBadge(c.state)}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {c.provider === "channex" && (
                      <InfoRow label="Channex Property" value={c.channex_property_id ?? "—"} code />
                    )}
                    <InfoRow label="מפתח API" value={c.api_key_hint ?? "—"} code />
                    <InfoRow label="סנכרון יוצא" value={c.outbound_sync_enabled ? "פעיל" : "כבוי"} />
                    <InfoRow label="ייבוא נכנס" value={c.inbound_sync_enabled ? "פעיל" : "כבוי"} />
                    <InfoRow label="סנכרון יוצא אחרון" value={fmtDateTime(c.last_outbound_sync_at)} code />
                    <InfoRow label="ייבוא נכנס אחרון" value={fmtDateTime(c.last_inbound_import_at)} code />
                    <InfoRow label="התאמה אחרונה" value={fmtDateTime(c.last_reconciliation_at)} code />
                    <InfoRow label="נדרש סנכרון מלא" value={c.full_sync_required ? "כן" : "לא"} />
                  </dl>
                  {c.last_error && (
                    <p className="t-label rounded-lg bg-status-danger-050 px-3 py-2 text-status-danger">
                      {c.last_error}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Aggregate queue / health counts */}
      <section className="flex flex-col gap-3">
        <h2 className="h3">בריאות התור והסנכרון</h2>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
          {statCards.map((s) => (
            <div key={s.label} className="card">
              <div className="card-bd">
                <p className={`h2 ${s.danger ? "text-status-danger" : "text-ink"}`}>
                  <bdi className="ltr-num">{s.value}</bdi>
                </p>
                <p className="t-label mt-1">{s.label}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Inventory mapping summary. The three GuestHub room categories are
          DESCRIPTIVE metadata — they are deliberately NOT presented as Channex
          mapping progress (the old "0/3" read as if they were the inventory
          unit). The Channex inventory unit is the individual physical room. */}
      {SHOW_CHANNEX && (
      <section className="flex flex-col gap-3">
        <h2 className="h3">מיפוי מלאי ל-Channex</h2>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <div className="card">
            <div className="card-bd">
              <p className="h2">
                <bdi className="ltr-num">{counts.room_categories}</bdi>
              </p>
              <p className="t-label mt-1">קטגוריות חדרים ב-GuestHub</p>
              <p className="field-hint">תיאוריות בלבד — אינן יחידת המלאי</p>
            </div>
          </div>
          <div className="card">
            <div className="card-bd">
              <p className="h2">
                <bdi className="ltr-num">{counts.active_rooms}</bdi>
              </p>
              <p className="t-label mt-1">חדרים פיזיים לסנכרון</p>
            </div>
          </div>
          <div className="card">
            <div className="card-bd flex flex-wrap items-center gap-3">
              <div>
                <p className="h2">
                  <bdi className="ltr-num">
                    {counts.mapped_rooms}
                    <span className="text-faint"> / {counts.active_rooms}</span>
                  </bdi>
                </p>
                <p className="t-label mt-1">חדרים פיזיים ממופים</p>
              </div>
              {counts.active_rooms > counts.mapped_rooms && (
                <span className="chip chip-approval">
                  <span className="dot" />
                  <bdi className="ltr-num">{counts.active_rooms - counts.mapped_rooms}</bdi> ללא מיפוי
                </span>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-bd">
              <p className="h2">
                <bdi className="ltr-num">{counts.channex_room_types}</bdi>
              </p>
              <p className="t-label mt-1">סוגי חדרים ב-Channex</p>
              <p className="field-hint">יחידה פיזית אחת לכל סוג חדר</p>
            </div>
          </div>
        </div>
      </section>
      )}

      {/* Recent unresolved sync errors */}
      <section className="flex flex-col gap-3">
        <h2 className="h3">שגיאות סנכרון אחרונות</h2>
        {errors.length === 0 ? (
          <div className="card">
            <div className="card-bd flex items-center gap-3">
              <Icon name="shield-check" size={20} className="shrink-0 text-status-success" />
              <p className="t-secondary">אין שגיאות סנכרון פתוחות.</p>
            </div>
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="t-label px-4 py-3 text-start text-faint">קוד</th>
                  <th className="t-label px-4 py-3 text-start text-faint">הודעה</th>
                  <th className="t-label px-4 py-3 text-start text-faint">טווח</th>
                  <th className="t-label px-4 py-3 text-start text-faint">מתי</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-3 text-status-danger">
                      <bdi className="ltr-num font-mono">{e.error_code ?? "—"}</bdi>
                    </td>
                    <td className="px-4 py-3 text-text2">{e.error_message ?? "—"}</td>
                    <td className="px-4 py-3 text-muted">
                      <bdi className="ltr-num">
                        {e.date_from || e.date_to ? `${fmtDate(e.date_from)} – ${fmtDate(e.date_to)}` : "—"}
                      </bdi>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      <bdi className="ltr-num">{fmtDateTime(e.created_at)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </div>
  );
}

function InfoRow({ label, value, code = false }: { label: string; value: string; code?: boolean }) {
  return (
    <>
      <dt className="t-label text-faint">{label}</dt>
      <dd className="t-secondary truncate text-text2" title={value}>
        {code ? <bdi className="ltr-num">{value}</bdi> : value}
      </dd>
    </>
  );
}
