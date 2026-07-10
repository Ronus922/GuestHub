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
import { Icon } from "@/components/shared/Icon";
import { ChannexStagingSection } from "./ChannexStagingSection";
import { ChannexPropertySection } from "./ChannexPropertySection";
import { ChannexRoomTypesSection } from "./ChannexRoomTypesSection";
import { ChannexRatePlansSection } from "./ChannexRatePlansSection";
import { AriSyncSection } from "./AriSyncSection";

export const dynamic = "force-dynamic";

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

function stateBadge(state: string) {
  const s = STATE_LABELS[state] ?? { label: state, tone: "muted" as const };
  const cls =
    s.tone === "success"
      ? "bg-status-success-050 text-status-success"
      : s.tone === "warning"
        ? "bg-status-warning-050 text-status-warning"
        : "bg-hover text-muted";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${cls}`}>{s.label}</span>;
}

export default async function ChannelsPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  // Same gate the server action enforces (canManageChannels — super_admin ONLY;
  // admin does NOT qualify). UI hiding is not security: this is the real boundary.
  if (!canManageChannels({ userId: actor.userId, roleKey: actor.roleKey }).ok) redirect("/dashboard");

  // Every one of these is a DB read. Loading /channels performs no Channex call
  // and creates nothing upstream.
  const [res, channex, channexProperty, roomSync, ratePlanSync] = await Promise.all([
    getChannelStatusAction(),
    getChannexConnectionAction(),
    getChannexPropertyContextAction(),
    getChannexRoomSyncContextAction(),
    getChannexRatePlanSyncContextAction(),
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
      <div>
        <h1 className="text-2xl font-extrabold text-ink">ערוצים</h1>
        <p className="mt-1 text-sm font-semibold text-muted">
          אבחון וסנכרון מנהל הערוצים (Channel Manager)
        </p>
      </div>

      {/* Scope note — this is a diagnostics screen, not the rate editor */}
      <div className="flex items-start gap-3 rounded-2xl border border-line bg-primary-050 p-4">
        <Icon name="info" size={20} className="mt-0.5 shrink-0 text-primary" />
        <div className="text-sm leading-relaxed text-text2">
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
      {channex.success && <ChannexStagingSection initial={channex.data!} />}

      {/* Channex Staging property mapping — existing tenant → one Channex property (D60) */}
      {channexProperty.success && <ChannexPropertySection initial={channexProperty.data!} />}

      {/* Physical room → Channex Room Type synchronization (D64) */}
      {roomSync.success && <ChannexRoomTypesSection initial={roomSync.data!} />}

      {/* (Local Rate Plan × mapped room) → Channex Rate Plan synchronization (D65) */}
      {ratePlanSync.success && <ChannexRatePlansSection initial={ratePlanSync.data!} />}

      {/* ARI status + THE Full Sync control (D68). Replaces the disabled
          "סנכרון מלא · בקרוב" placeholder. Reconcile stays out of scope. */}
      {channexConnectionId && ariStatus && (
        <AriSyncSection connectionId={channexConnectionId} initial={ariStatus} />
      )}

      {!res.success ? (
        <div className="flex items-start gap-3 rounded-2xl border border-status-danger bg-status-danger-050 p-4">
          <Icon name="warning" size={20} className="mt-0.5 shrink-0 text-status-danger" />
          <p className="text-sm font-semibold text-status-danger">{res.error}</p>
        </div>
      ) : (
        <StatusView data={res.data as ChannelStatus} />
      )}
    </div>
  );
}

function StatusView({ data }: { data: ChannelStatus }) {
  const { connections, counts, errors } = data;

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
        <h2 className="text-lg font-bold text-ink">חיבורי ערוצים</h2>
        {connections.length === 0 ? (
          <div className="grid min-h-[220px] place-items-center rounded-2xl border border-dashed border-line bg-surface">
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
              <div className="grid h-16 w-16 place-items-center rounded-2xl bg-hover">
                <Icon name="channels" size={30} className="text-faint" />
              </div>
              <h3 className="text-lg font-bold text-ink">לא מחובר — אין חיבור ערוצים פעיל</h3>
              <p className="text-sm text-muted">
                לא הוגדר אף חיבור לערוץ הפצה. זהו המצב הצפוי בשלב זה — הקמת חיבור, מיפוי
                וסנכרון יתווספו בשלב הבא (Phase 4B).
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {connections.map((c) => (
              <div key={c.id} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-ink">
                    {c.provider} · {c.environment}
                  </span>
                  {stateBadge(c.state)}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <InfoRow label="Channex Property" value={c.channex_property_id ?? "—"} />
                  <InfoRow label="מפתח API" value={c.api_key_hint ?? "—"} />
                  <InfoRow label="סנכרון יוצא" value={c.outbound_sync_enabled ? "פעיל" : "כבוי"} />
                  <InfoRow label="ייבוא נכנס" value={c.inbound_sync_enabled ? "פעיל" : "כבוי"} />
                  <InfoRow label="סנכרון יוצא אחרון" value={fmtDateTime(c.last_outbound_sync_at)} />
                  <InfoRow label="ייבוא נכנס אחרון" value={fmtDateTime(c.last_inbound_import_at)} />
                  <InfoRow label="התאמה אחרונה" value={fmtDateTime(c.last_reconciliation_at)} />
                  <InfoRow label="נדרש סנכרון מלא" value={c.full_sync_required ? "כן" : "לא"} />
                </dl>
                {c.last_error && (
                  <p className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-semibold text-status-danger">
                    {c.last_error}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Aggregate queue / health counts */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold text-ink">בריאות התור והסנכרון</h2>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
          {statCards.map((s) => (
            <div key={s.label} className="rounded-2xl border border-line bg-surface p-4">
              <p className={`text-2xl font-extrabold ${s.danger ? "text-status-danger" : "text-ink"}`}>
                {s.value}
              </p>
              <p className="mt-1 text-xs font-medium text-muted">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Inventory mapping summary. The three GuestHub room categories are
          DESCRIPTIVE metadata — they are deliberately NOT presented as Channex
          mapping progress (the old "0/3" read as if they were the inventory
          unit). The Channex inventory unit is the individual physical room. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold text-ink">מיפוי מלאי ל-Channex</h2>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-line bg-surface p-4">
            <p className="text-2xl font-extrabold text-ink">{counts.room_categories}</p>
            <p className="mt-1 text-xs font-medium text-muted">קטגוריות חדרים ב-GuestHub</p>
            <p className="text-[10px] font-medium text-faint">תיאוריות בלבד — אינן יחידת המלאי</p>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-4">
            <p className="text-2xl font-extrabold text-ink">{counts.active_rooms}</p>
            <p className="mt-1 text-xs font-medium text-muted">חדרים פיזיים לסנכרון</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4">
            <div>
              <p className="text-2xl font-extrabold text-ink">
                {counts.mapped_rooms}
                <span className="text-base font-bold text-faint"> / {counts.active_rooms}</span>
              </p>
              <p className="mt-1 text-xs font-medium text-muted">חדרים פיזיים ממופים</p>
            </div>
            {counts.active_rooms > counts.mapped_rooms && (
              <span className="rounded-full bg-status-warning-050 px-2.5 py-0.5 text-xs font-bold text-status-warning">
                {counts.active_rooms - counts.mapped_rooms} ללא מיפוי
              </span>
            )}
          </div>
          <div className="rounded-2xl border border-line bg-surface p-4">
            <p className="text-2xl font-extrabold text-ink">{counts.channex_room_types}</p>
            <p className="mt-1 text-xs font-medium text-muted">סוגי חדרים ב-Channex</p>
            <p className="text-[10px] font-medium text-faint">יחידה פיזית אחת לכל סוג חדר</p>
          </div>
        </div>
      </section>

      {/* Recent unresolved sync errors */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold text-ink">שגיאות סנכרון אחרונות</h2>
        {errors.length === 0 ? (
          <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4">
            <Icon name="shield-check" size={20} className="shrink-0 text-status-success" />
            <p className="text-sm font-semibold text-muted">אין שגיאות סנכרון פתוחות.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-line text-right text-xs font-bold text-faint">
                  <th className="px-4 py-3">קוד</th>
                  <th className="px-4 py-3">הודעה</th>
                  <th className="px-4 py-3">טווח</th>
                  <th className="px-4 py-3">מתי</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-3 font-mono text-xs text-status-danger">{e.error_code ?? "—"}</td>
                    <td className="px-4 py-3 text-text2">{e.error_message ?? "—"}</td>
                    <td className="px-4 py-3 text-muted">
                      {e.date_from || e.date_to ? `${fmtDate(e.date_from)} – ${fmtDate(e.date_to)}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted">{fmtDateTime(e.created_at)}</td>
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="truncate font-semibold text-text2" title={value}>
        {value}
      </dd>
    </>
  );
}
