"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { HEBREW_DAY_NAMES, dayOfWeek, formatFullDate, isRateDateWritable, type DateOnly } from "@/lib/dates";
import {
  DRAFT_CATEGORY_TEXT, STAY_MAX, blockingReasons, dirtyCategories, draftFromCell, draftPatch,
  liveSellable, outboundSummary, pruneEdits, stepStay, type CellDraft,
} from "@/lib/rates/cell-draft";
import { getCellDetailAction, upsertRateCellAction, type CellDetailData } from "./actions";
import {
  ROOM_ADMIN_TEXT, SELL_REASON_TEXT, SYNC_STATE_TEXT,
  type RateCellState, type RateGridUnit, type SyncState,
} from "./types";

// The cell drawer ("מצב מכירה ליום", approved design — DECISIONS D177). Opened
// by clicking a price cell. Shows the full canonical projection with the three
// axes kept SEPARATE (physical / commercial / sync), the final sale state LIVE,
// and the calculated outbound values. The six commercial fields are edited as
// a local DRAFT and written in ONE upsertRateCellAction call from the footer;
// the price has its own button and its own call. The pure rules (patch, dirty
// categories, stepper floor, live sellable) live in lib/rates/cell-draft.ts
// and are RUN by check:rate-cell-panel. PHYSICAL facts are shown read-only
// with LINKS to the proper operational screens — the grid never changes room
// status, reservations, or blocks (§5).

type Props = {
  open: boolean;
  onClose: () => void;
  unit: RateGridUnit | null;
  cell: RateCellState | null;
  today: DateOnly;
  editable: boolean;
  onSaved: () => void;
};

// Closed = not rendered (as before). The key remounts the drawer — and resets
// every draft — whenever a different (unit, date) is shown; an unrelated
// server refresh keeps the same key, so a half-edited draft survives it.
export function CellDetailPanel(props: Props) {
  const { unit, cell } = props;
  if (!unit || !cell) return null;
  return <CellDetailDrawer key={`${unit.sellableUnitId}|${cell.date}`} {...props} unit={unit} cell={cell} />;
}

type CellPatch = Parameters<typeof upsertRateCellAction>[0]["patch"];
type SaveKind = "fields" | "price";
type Tone = "ok" | "warn" | "danger";

const SYNC_TONE: Record<SyncState, Tone | undefined> = {
  not_connected: undefined,
  clean: "ok",
  pending: "warn",
  processing: "warn",
  failed: "danger",
};

function CellDetailDrawer({
  open, onClose, unit, cell, today, editable, onSaved,
}: Props & { unit: RateGridUnit; cell: RateCellState }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [detail, setDetail] = useState<CellDetailData | null>(null);
  // the user's edits ONLY, laid over the saved cell (see cell-draft.ts)
  const [edits, setEdits] = useState<Partial<CellDraft>>({});
  // null = untouched → the field shows the saved price
  const [priceEdit, setPriceEdit] = useState<string | null>(null);
  const [saving, setSaving] = useState<SaveKind | null>(null);
  const inFlight = useRef(false);

  const unitId = unit.sellableUnitId;
  const date = cell.date;

  // the physical entity links (reservations / closures) — once per open; a
  // commercial write cannot change them
  useEffect(() => {
    let alive = true;
    void getCellDetailAction(unitId, date).then((res) => {
      if (alive && res.success && res.data) setDetail(res.data);
    });
    return () => {
      alive = false;
    };
  }, [unitId, date]);

  const savedPriceInput = cell.price == null ? "" : String(Math.round(cell.price));

  // `cell` is a fresh object after every router.refresh(): drop the edits the
  // server now equals (the user's own save landed, or someone saved the same
  // value) so a later external change is never masked by a stale edit. The
  // edits that still differ survive, so an unrelated refresh never wipes a
  // draft; and nothing is reset right after a save, so the drawer never flashes
  // the OLD values while the refreshed cell is still on its way.
  useEffect(() => {
    setEdits((e) => pruneEdits(e, draftFromCell(cell)));
    setPriceEdit((p) => (p !== null && p === savedPriceInput ? null : p));
  }, [cell, savedPriceInput]);

  const writable = isRateDateWritable(date, today);

  const server = draftFromCell(cell);
  const draft: CellDraft = { ...server, ...edits };
  const patch = draftPatch(server, draft);
  const categories = dirtyCategories(patch);
  const dirty = categories.length > 0;
  const busy = saving !== null || isPending;

  const priceInput = priceEdit ?? savedPriceInput;
  const priceDirty = priceEdit !== null && priceEdit !== savedPriceInput;
  const priceValid = priceInput !== "" && Number(priceInput) >= 1; // the schema's floor (price 0 = a silent closure)

  // final sale state, LIVE: the draft's switch replaces the saved commercial
  // verdict; every other saved reason (physical / plan / price / mapping) holds
  const others = blockingReasons(cell.reasonCodes);
  const primary = others[0];
  const sellable = liveSellable(cell.reasonCodes, draft.stopSell);
  const sentence = primary
    ? SELL_REASON_TEXT[primary]
    : draft.stopSell
      ? "היום סגור למכירה — הזמינות לערוצים תהיה 0 גם אם קיים מלאי פיזי."
      : "יש מלאי פיזי זמין והיום פתוח למכירה בערוצים.";

  const setField = <K extends keyof CellDraft>(key: K, value: CellDraft[K]) =>
    setEdits((e) => {
      const next: Partial<CellDraft> = { ...e };
      next[key] = value;
      return next;
    });

  async function write(kind: SaveKind, p: CellPatch, okText: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(kind);
    const res = await upsertRateCellAction({
      sellableUnitId: unitId,
      pricingPlanId: unit.pricingPlanId ?? undefined,
      date,
      patch: p,
    });
    inFlight.current = false;
    setSaving(null);
    if (!res.success) {
      toast.error(res.error || "השמירה נכשלה");
      return;
    }
    toast.success(okText);
    onSaved();
    // re-render the grid (server) without remounting → scroll kept; the
    // transition keeps `busy` up until the fresh cell has landed
    startTransition(() => router.refresh());
  }
  // ONE call for every changed commercial field — never the price
  const saveFields = () => write("fields", patch, `השינויים נשמרו ליום ${formatFullDate(date)}`);
  const savePrice = () => write("price", { price: Number(priceInput) }, `המחיר נשמר ליום ${formatFullDate(date)}`);

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={`${unit.isPooled ? "מאגר" : "חדר"} ${unit.code} · ${formatFullDate(date)}`}
      subtitle={`${unit.roomTypeName ?? "ללא סוג"}${unit.isPooled ? ` · מאגר ${unit.roomCount}` : ""} · תוכנית בסיס · ${HEBREW_DAY_NAMES[dayOfWeek(date)]}`}
      icon="event-available"
      widthClassName="rc-panel"
      bodyClassName="rc-body"
      footer={
        /* §7 via .dw-ft (row-reverse): DOM order = visual left→right — the
           PRIMARY action is FIRST so it hugs the LEFT edge, "ביטול" to its
           right; the unsaved-changes note is pushed to the far right. */
        <>
          <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={saveFields}>
            <Icon name="check" size={20} />
            {saving === "fields" ? "שומר…" : "שמירת שינויים"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>ביטול</button>
          <span className="flex-1" />
          {dirty && !busy && (
            <span className="rc-dirty">
              <Icon name="edit" size={17} />
              שינויים שלא נשמרו: {categories.map((c) => DRAFT_CATEGORY_TEXT[c]).join(" · ")}
            </span>
          )}
        </>
      }
    >
      {/* 1. Final sale state — one pill + one sentence, live */}
      <Section title="מצב מכירה סופי" icon="flag" hint="נגזר מהמלאי הפיזי ומהמצב המסחרי">
        <div className="rc-final-row">
          <span className={`rc-final ${sellable ? "is-open" : "is-closed"}`}>
            <Icon name={sellable ? "check-circle" : "room-blocks"} size={20} />
            {sellable ? "ניתן למכירה" : "לא זמין למכירה"}
          </span>
          <span className="rc-final-txt">{sentence}</span>
        </div>
      </Section>

      {/* 2. Axis A — physical inventory (read-only; links to operational screens) */}
      <Section title="מלאי פיזי" icon="rooms">
        <div className="rc-tiles">
          <Tile label="קיבולת" value={cell.totalRooms} />
          <Tile label="זמין" value={cell.availability} tone={cell.availability > 0 ? "ok" : undefined} />
          <Tile label="תפוסים" value={cell.occupiedRooms} />
          <Tile label="חסומים" value={cell.closedRooms} />
          <Tile label="הולד (OTA)" value={cell.physicalHeld} />
          <Tile label="מצב חדר" value={ROOM_ADMIN_TEXT[cell.roomAdminState]} tone={cell.roomAdminState === "available" ? "ok" : undefined} />
        </div>
        {detail && (detail.reservations.length > 0 || detail.closures.length > 0 || cell.roomAdminState !== "available") && (
          <div className="flex flex-col gap-1.5">
            {detail.reservations.map((rv) => (
              <LinkRow key={rv.id} icon="calendar" href={`/calendar?from=${rv.checkIn}`}
                text={`הזמנה #${rv.reservationNumber} (${rv.status}) · ${rv.checkIn}→${rv.checkOut}`} label="צפייה בלוח" />
            ))}
            {detail.closures.map((c) => (
              <LinkRow key={c.id} icon="room-blocks" href={`/calendar?from=${c.startDate}`}
                text={`חסימה פיזית${c.reason ? ` · ${c.reason}` : ""} · ${c.startDate}→${c.endDate}`} label="ניהול חסימה" />
            ))}
            {cell.roomAdminState !== "available" && cell.roomAdminState !== "no_member" && (
              <p className="field-msg">
                {cell.roomAdminState === "out_of_order" ? "החדר מושבת פיזית — יש להחזירו לפעילות בניהול חדרים." : "החדר אינו פעיל — יש להפעילו בניהול חדרים."}
              </p>
            )}
            {cell.roomAdminState === "no_member" && (
              <p className="field-msg">אין חדר משויך ליחידת המכירה — יש להשלים מיפוי.</p>
            )}
          </div>
        )}
      </Section>

      {/* 3. Axis B — commercial: the draft (the hint shows the SAVED price) */}
      <Section
        title="מצב מסחרי"
        icon="storefront"
        hint={
          <>
            מחיר אפקטיבי <bdi className="ltr-num">₪{Math.round(cell.effectivePrice)}</bdi>{" "}
            {cell.priceSource === "inherited" ? <>(בסיס <bdi className="ltr-num">₪{Math.round(cell.inheritedRate)}</bdi>)</> : "(מוגדר)"}
          </>
        }
      >
        {!editable ? (
          <p className="field-hint">אין הרשאת עריכת תעריפים.</p>
        ) : !cell.activeRatePlan ? (
          <p className="field-msg">אין תוכנית תמחור פעילה ליחידה — יש להגדיר תוכנית בסיס.</p>
        ) : !writable ? (
          <p className="field-hint">תאריך שעבר — לא ניתן לעריכה מסחרית.</p>
        ) : (
          <>
            <div className="field">
              <span className="field-label" id="rc-sale-label">מכירה</span>
              {/* the chosen state is signalled by aria-checked + a glyph (shape cue),
                  never by colour alone (WCAG 1.4.1). DOM order: open first = RIGHT in RTL */}
              <div className="rc-sale" role="radiogroup" aria-labelledby="rc-sale-label">
                <button type="button" role="radio" aria-checked={!draft.stopSell} className="rc-sale-b is-open" disabled={busy} onClick={() => setField("stopSell", false)}>
                  <Icon name={draft.stopSell ? "radio-unchecked" : "check-circle"} size={20} />
                  פתוח למכירה
                </button>
                <button type="button" role="radio" aria-checked={draft.stopSell} className="rc-sale-b is-closed" disabled={busy} onClick={() => setField("stopSell", true)}>
                  <Icon name={draft.stopSell ? "room-blocks" : "radio-unchecked"} size={20} />
                  סגור למכירה
                </button>
              </div>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="rc-price">מחיר לילה</label>
              <div className="rc-price-row">
                <div className="rc-price-wrap">
                  {/* digits only (the reference): a text input filtered on change,
                      so the keyboard is numeric and nothing but digits can land */}
                  <input
                    id="rc-price" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={7} dir="ltr"
                    className="field-input ltr-num rc-price-in"
                    value={priceInput} placeholder={String(Math.round(cell.effectivePrice))} disabled={busy}
                    onChange={(e) => setPriceEdit(e.target.value.replace(/\D/g, ""))}
                  />
                  <span className="rc-price-cur" aria-hidden="true">₪</span>
                </div>
                <button type="button" className="btn btn-primary" disabled={!priceDirty || !priceValid || busy} onClick={savePrice}>
                  {saving === "price" ? "שומר…" : "שמירת מחיר"}
                </button>
              </div>
              <p className="field-hint">המחיר חל על יום זה בלבד ודורס את מחיר תוכנית הבסיס</p>
            </div>

            <div className="field">
              <span className="field-label">מגבלות שהייה</span>
              <div className="rc-stays">
                <StayStepper label="מ׳ לילות בהגעה" value={draft.minStayArrival} disabled={busy} onChange={(v) => setField("minStayArrival", v)} />
                <StayStepper label="מינימום לילות בטווח" value={draft.minStayThrough} disabled={busy} onChange={(v) => setField("minStayThrough", v)} />
                <StayStepper label="מקסימום לילות" value={draft.maxStay} disabled={busy} onChange={(v) => setField("maxStay", v)} />
              </div>
              <p className="field-hint">ערך ריק (—) = ללא מגבלה</p>
            </div>

            <div className="rc-sw-rows">
              <SwitchRow label="סגור לכניסה" desc="לא ניתן להתחיל שהייה ביום זה" icon="login" checked={draft.closedToArrival} disabled={busy} onChange={(v) => setField("closedToArrival", v)} />
              <SwitchRow label="סגור לעזיבה" desc="לא ניתן לסיים שהייה ביום זה" icon="logout" checked={draft.closedToDeparture} disabled={busy} onChange={(v) => setField("closedToDeparture", v)} />
            </div>
          </>
        )}
      </Section>

      {/* 4. Synchronization projection (calculated; nothing sent this phase) — the
          summary follows the DRAFT, so it always describes what a save would send */}
      <Section title="סנכרון ערוצים" icon="arrivals-departures">
        <div className="rc-tiles">
          <Tile label="מצב סנכרון" value={SYNC_STATE_TEXT[cell.syncState]} tone={SYNC_TONE[cell.syncState]} />
          <Tile label="מיפוי ערוץ" value={cell.mappingValid ? "ממופה" : "לא ממופה"} tone={cell.mappingValid ? "ok" : "danger"} />
          <Tile label="זמינות ליציאה" value={cell.outboundAvailability} />
        </div>
        <p className="rc-note">
          <Icon name="info" size={17} />
          <span>
            ערכים מחושבים בלבד — לא נשלח דבר לערוץ בשלב זה. זמינות ליציאה נגזרת מהמלאי הפיזי בלבד;
            המגבלות והמחיר נגזרים מה-ARI המסחרי: {outboundSummary(draft, cell.outboundRestrictions.rate)}.
          </span>
        </p>
      </Section>
    </SidePanel>
  );
}

function Section({ title, icon, hint, children }: { title: string; icon: IconName; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card rc-sec">
      {/* a real <h3> keeps the panel's document outline / screen-reader heading
          navigation; it inherits .card-hd's 17px/800 (§6). The hint is pushed
          to the far (left) end of the header row. */}
      <div className="card-hd">
        <span className="rc-sec-ic">
          <Icon name={icon} size={20} />
        </span>
        <h3>{title}</h3>
        {hint ? <span className="rc-sec-hint">{hint}</span> : null}
      </div>
      <div className="card-bd">{children}</div>
    </section>
  );
}
function Tile({ label, value, tone }: { label: string; value: string | number; tone?: Tone }) {
  return (
    <div className="tile rc-tile">
      <div className={`tile-v${tone ? ` is-${tone}` : ""}`}>{value}</div>
      <div className="tile-l">{label}</div>
    </div>
  );
}
function LinkRow({ icon, href, text, label }: { icon: IconName; href: string; text: string; label: string }) {
  return (
    <a href={href} className="flex items-center gap-2 rounded-[8px] border-[1.5px] border-line px-3 py-2 text-[12px] font-bold text-ink hover:bg-hover">
      <Icon name={icon} size={17} className="text-muted" />
      <span className="flex-1 truncate">{text}</span>
      <span className="flex-none text-primary">{label} ›</span>
    </a>
  );
}
// [−] value [+] laid out LTR whatever the document direction; null is "—"
// (no limit) and disables [−]; [+] stops at the schema ceiling.
function StayStepper({ label, value, disabled, onChange }: { label: string; value: number | null; disabled: boolean; onChange: (v: number | null) => void }) {
  return (
    <div className="rc-stay">
      <span className="rc-stay-l">{label}</span>
      <div className="rc-step">
        <button type="button" aria-label={`${label} — פחות`} className="icon-btn rc-step-b" disabled={disabled || value == null} onClick={() => onChange(stepStay(value, -1))}>
          <Icon name="minus" size={20} />
        </button>
        <span className={`rc-step-v${value == null ? " is-null" : ""}`}>{value ?? "—"}</span>
        <button type="button" aria-label={`${label} — עוד`} className="icon-btn rc-step-b" disabled={disabled || (value != null && value >= STAY_MAX)} onClick={() => onChange(stepStay(value, 1))}>
          <Icon name="plus" size={20} />
        </button>
      </div>
    </div>
  );
}
// the whole row is the switch (one button, role="switch"); the track + knob
// inside it are passive
function SwitchRow({ label, desc, icon, checked, disabled, onChange }: {
  label: string; desc: string; icon: IconName; checked: boolean; disabled: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="rc-sw-row" disabled={disabled} onClick={() => onChange(!checked)}>
      <Icon name={icon} size={17} className="rc-sw-ic" />
      <span className="rc-sw-txt">
        <span className="rc-sw-l">{label}</span>
        <span className="rc-sw-d">{desc}</span>
      </span>
      <span className="rc-sw" aria-hidden="true">
        <span className="rc-sw-knob" />
      </span>
    </button>
  );
}
