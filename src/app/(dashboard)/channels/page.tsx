import { redirect } from "next/navigation";
import Link from "next/link";
import { getActor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { getChannelStatusAction } from "@/lib/channel/admin";
import { getExternalChangesAction } from "@/lib/channel/external-changes-admin";
import { getBeds24ConnectionAction } from "@/lib/channel/beds24-admin";
import {
  BEDS24_CREDIT_CEILING, BEDS24_LOW_CREDIT_THRESHOLD,
} from "@/lib/channel/beds24-credits";
import { Icon } from "@/components/shared/Icon";
import { Beds24Section } from "./Beds24Section";
import { ExternalChangesSection } from "./ExternalChangesSection";

export const dynamic = "force-dynamic";

// /channels — Channel Manager DIAGNOSTIC screen (§AA observability). DISPLAY-ONLY,
// super_admin only. This screen diagnoses channel sync (connection state, mapping
// completeness, queue health, recent errors) — it is NOT the rate editor (that is the
// Rate Grid at /rates). Beds24 is the ONE channel provider (D91); page load is a pure
// DB read (the Beds24 properties list loads only on explicit operator click).

type ConnectionRow = {
  id: string;
  provider: string;
  environment: string;
  state: string;
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

// P0-4 — the Beds24 credit window as the worker last measured it (parked on the
// job row that read it). Every field may be absent: a response without the
// meter headers is normal, and a brand-new install has never measured one.
type CreditsRow = {
  credits: {
    remaining: number | null;
    resets_in_sec: number | null;
    cost: number | null;
    paused: string | null;
    measured_at: string | null;
  } | null;
  job_type: string;
  finished_at: string | Date | null;
};

type ChannelStatus = {
  connections: ConnectionRow[];
  counts: CountsRow;
  errors: SyncErrorRow[];
  credits: CreditsRow | null;
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
  paused: { label: "מושהה", tone: "muted" },
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

  // Every one of these is a DB read. Loading /channels performs no channel API
  // call and creates nothing upstream.
  const [res, externalChanges, beds24] = await Promise.all([
    getChannelStatusAction(),
    getExternalChangesAction(),
    getBeds24ConnectionAction(),
  ]);

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
          &quot;הפעלת סנכרון Beds24&quot; שלמטה.
        </div>
      </div>

      {/* Beds24 PRODUCTION connection + room↔room mapping + Full Sync (D78) —
          the ONE channel provider (D91). Page load is a pure DB read; the Beds24
          properties list loads only on explicit operator click. */}
      {beds24.success && <Beds24Section initial={beds24.data!} />}

      {/* External date changes from the OTA — pending reconciliation + ops email
          (D82). Provider-neutral: the Beds24 inbound writes these. */}
      {externalChanges.success && <ExternalChangesSection initial={externalChanges.data!} />}

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
  // Beds24 is the only provider; every connection row shown is its own.
  const connections = data.connections.filter((c) => c.provider === "beds24");

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
                לא הוגדר חיבור Beds24. הקימו חיבור מכרטיס &quot;הפעלת סנכרון Beds24&quot; שלמעלה.
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

      {/* P0-4 — Beds24 credit window (100 credits / rolling 5 min per account).
          Read-only observability: the worker paces itself off the SAME numbers. */}
      <CreditWindowSection credits={data.credits} />

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

// The credit meter Beds24 returns on every metered response. `remaining` is
// fractional (97.6, not 97) — never rounded to an int here.
function CreditWindowSection({ credits }: { credits: CreditsRow | null }) {
  const c = credits?.credits ?? null;
  const remaining = c?.remaining ?? null;
  const low = remaining !== null && remaining < BEDS24_LOW_CREDIT_THRESHOLD;
  const paused = c?.paused ?? null;
  const pct =
    remaining === null ? null : Math.max(0, Math.min(100, (remaining / BEDS24_CREDIT_CEILING) * 100));

  return (
    <section className="flex flex-col gap-3">
      <h2 className="h3">מכסת קרדיטים · Beds24</h2>
      <div className="card">
        <div className="card-bd flex flex-col gap-3">
          {c === null ? (
            <p className="t-secondary">
              טרם נמדדה מכסה. המדידה נרשמת אוטומטית בסבב הייבוא הבא (כל 5 דקות).
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className={`h2 ${low ? "text-status-danger" : "text-ink"}`}>
                  <bdi className="ltr-num">
                    {remaining === null ? "—" : remaining} / {BEDS24_CREDIT_CEILING}
                  </bdi>
                </p>
                <span className={`chip ${low || paused ? "chip-approval" : "chip-paid"}`}>
                  <span className="dot" />
                  {paused === "rate_limited"
                    ? "נחסם (429) — ממתין לאיפוס"
                    : paused === "low_credits"
                      ? "האטה — המכסה קרובה למיצוי"
                      : "זורם"}
                </span>
              </div>
              {/* the window as a bar; the danger zone is the derived threshold */}
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-hover"
                role="img"
                aria-label={`נותרו ${remaining ?? 0} מתוך ${BEDS24_CREDIT_CEILING} קרדיטים בחלון של 5 דקות`}
              >
                <div
                  className={`h-full rounded-full ${low ? "bg-status-danger" : "bg-status-success"}`}
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <InfoRow
                  label="איפוס החלון בעוד"
                  value={c.resets_in_sec === null ? "—" : `${c.resets_in_sec} שניות`}
                  code
                />
                <InfoRow label="עלות הקריאה האחרונה" value={c.cost === null ? "—" : String(c.cost)} code />
                <InfoRow label="סף האטה" value={`${BEDS24_LOW_CREDIT_THRESHOLD} קרדיטים`} code />
                <InfoRow label="נמדד לאחרונה" value={fmtDateTime(c.measured_at)} code />
              </dl>
            </>
          )}
        </div>
      </div>
    </section>
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
