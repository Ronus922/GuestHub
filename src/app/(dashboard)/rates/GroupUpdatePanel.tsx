"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { addDays, dayOfWeek, eachDay, HEBREW_DAY_LETTERS, type DateOnly } from "@/lib/dates";
import { bulkUpdateRatesAction } from "./actions";
import { applyPriceMode } from "@/lib/rates/rules";
import type { BulkUpdateRatesInput } from "@/lib/validation/rates";
import type { RateGridType, RateCellState } from "./types";

type PriceMode = "replace" | "add" | "subtract" | "percent_add" | "percent_subtract";
const PRICE_MODES: { value: PriceMode; label: string; unit: string }[] = [
  { value: "percent_add", label: "העלאה באחוזים", unit: "%" },
  { value: "percent_subtract", label: "הורדה באחוזים", unit: "%" },
  { value: "replace", label: "מחיר קבוע", unit: "₪" },
  { value: "add", label: "הוספת סכום", unit: "₪" },
  { value: "subtract", label: "הפחתת סכום", unit: "₪" },
];

type TriState = "nochange" | "yes" | "no";

// A flat SU record for the selection grid.
type SuCard = { id: string; code: string; name: string; typeName: string; basePrice: number; roomTypeId: string; pooled: boolean; rooms: number };

export function GroupUpdatePanel({
  open,
  types,
  from,
  toInclusive,
  minDate,
  maxDate,
  presetUnitIds,
  onClose,
  onSaved,
}: {
  open: boolean;
  types: RateGridType[];
  from: DateOnly;
  toInclusive: DateOnly;
  // Writable horizon (Step 6): minDate = tenant-local today, maxDate = today + 5y.
  // Group Update spans the FULL horizon, not just the grid's visible window.
  minDate: DateOnly;
  maxDate: DateOnly;
  presetUnitIds: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Clamp a requested date into [minDate, maxDate].
  const clampDate = (d: DateOnly): DateOnly => (d < minDate ? minDate : d > maxDate ? maxDate : d);
  const router = useRouter();
  const allCards: SuCard[] = useMemo(
    () =>
      types.flatMap((t) =>
        t.units.map((u) => ({
          id: u.sellableUnitId,
          code: u.code,
          name: u.name,
          typeName: t.roomTypeName,
          basePrice: u.basePrice,
          roomTypeId: t.roomTypeId ?? "—",
          pooled: u.isPooled,
          rooms: u.roomCount,
        })),
      ),
    [types],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set(presetUnitIds));
  const [cardType, setCardType] = useState<string>("all");
  const [search, setSearch] = useState("");

  const [dateFrom, setDateFrom] = useState<DateOnly>(clampDate(from));
  const [dateTo, setDateTo] = useState<DateOnly>(clampDate(toInclusive));
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4, 5, 6]));

  // field controls (each defaults to "no change")
  const [priceOn, setPriceOn] = useState(false);
  const [priceMode, setPriceMode] = useState<PriceMode>("percent_add");
  const [priceAmount, setPriceAmount] = useState(10);
  const [stopSell, setStopSell] = useState<TriState>("nochange");
  const [minThroughOn, setMinThroughOn] = useState(false);
  const [minThrough, setMinThrough] = useState(2);
  const [maxStayOn, setMaxStayOn] = useState(false);
  const [maxStay, setMaxStay] = useState(7);
  const [minArrivalOn, setMinArrivalOn] = useState(false);
  const [minArrival, setMinArrival] = useState(1);
  const [cta, setCta] = useState<TriState>("nochange");
  const [ctd, setCtd] = useState<TriState>("nochange");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each open may target a different preset (whole grid vs one room-type button).
  // The panel is always mounted now, so opening must reset ALL editable state to
  // defaults — otherwise field selections leak from a previous (unapplied) open
  // and could silently bulk-write stale changes.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(presetUnitIds));
    setCardType("all");
    setSearch("");
    // clamp the reset window into the writable horizon (inline so the effect deps
    // stay primitive and it never re-fires mid-edit).
    setDateFrom(from < minDate ? minDate : from > maxDate ? maxDate : from);
    setDateTo(toInclusive < minDate ? minDate : toInclusive > maxDate ? maxDate : toInclusive);
    setWeekdays(new Set([0, 1, 2, 3, 4, 5, 6]));
    setPriceOn(false);
    setPriceMode("percent_add");
    setPriceAmount(10);
    setStopSell("nochange");
    setMinThroughOn(false);
    setMinThrough(2);
    setMaxStayOn(false);
    setMaxStay(7);
    setMinArrivalOn(false);
    setMinArrival(1);
    setCta("nochange");
    setCtd("nochange");
    setError(null);
  }, [open, presetUnitIds, from, toInclusive, minDate, maxDate]);

  const cards = allCards.filter(
    (c) =>
      (cardType === "all" || c.roomTypeId === cardType) &&
      (search.trim() === "" || c.code.includes(search.trim()) || c.name.includes(search.trim())),
  );

  const effectiveDates = useMemo(() => {
    if (dateTo < dateFrom) return [];
    return eachDay(dateFrom, addDays(dateTo, 1)).filter((d) => weekdays.has(dayOfWeek(d)));
  }, [dateFrom, dateTo, weekdays]);

  const cellCount = selected.size * effectiveDates.length;

  // Honest preview breakdown (§9) over the actual selected cells' canonical state
  // — so the user is never told stop_sell=false creates physical availability.
  const cellIndex = useMemo(() => {
    const m = new Map<string, RateCellState>();
    for (const t of types) for (const u of t.units) for (const c of u.cells) m.set(`${u.sellableUnitId}|${c.date}`, c);
    return m;
  }, [types]);
  const preview = useMemo(() => {
    let noInventory = 0, missingPrice = 0, currentlyClosed = 0, currentlyOpen = 0;
    for (const su of selected) {
      for (const d of effectiveDates) {
        const c = cellIndex.get(`${su}|${d}`);
        if (!c) continue;
        if (c.availability === 0) noInventory++;
        if (c.effectivePrice <= 0) missingPrice++;
        if (c.stopSell) currentlyClosed++; else currentlyOpen++;
      }
    }
    return { noInventory, missingPrice, willOpen: currentlyClosed, willClose: currentlyOpen };
  }, [selected, effectiveDates, cellIndex]);

  const anyFieldSelected =
    priceOn || stopSell !== "nochange" || minThroughOn || maxStayOn || minArrivalOn || cta !== "nochange" || ctd !== "nochange";
  const canApply = selected.size > 0 && effectiveDates.length > 0 && anyFieldSelected && !busy;

  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toggleWeekday = (d: number) =>
    setWeekdays((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });

  // sample "before → after" price for the first selected SU (display only)
  const sample = useMemo(() => {
    if (!priceOn) return null;
    const first = allCards.find((c) => selected.has(c.id));
    if (!first) return null;
    const after = applyPriceMode(first.basePrice, priceMode, priceAmount, first.basePrice);
    return { typeName: first.typeName, before: first.basePrice, after };
  }, [priceOn, priceMode, priceAmount, selected, allCards]);

  async function apply() {
    setBusy(true);
    setError(null);
    const allWeekdays = weekdays.size === 7;
    const input = {
      sellableUnitIds: [...selected],
      dateFrom,
      dateTo,
      ...(allWeekdays ? {} : { weekdays: [...weekdays] }),
      ...(priceOn ? { price: { mode: priceMode, amount: priceAmount } } : {}),
      ...(minThroughOn ? { minStayThrough: minThrough } : {}),
      ...(maxStayOn ? { maxStay } : {}),
      ...(minArrivalOn ? { minStayArrival: minArrival } : {}),
      ...(stopSell !== "nochange" ? { stopSell: stopSell === "yes" } : {}),
      ...(cta !== "nochange" ? { closedToArrival: cta === "yes" } : {}),
      ...(ctd !== "nochange" ? { closedToDeparture: ctd === "yes" } : {}),
    };
    const res = await bulkUpdateRatesAction(input as BulkUpdateRatesInput);
    setBusy(false);
    if (res.success) {
      onSaved();
      router.refresh();
      onClose();
    } else {
      setError(res.error ?? "אירעה שגיאה");
    }
  }

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title="עדכון קבוצתי"
      subtitle="עדכון מחיר, זמינות ומגבלות לילות במספר יחידות ותאריכים בבת אחת"
      icon="bulk-update"
      bodyClassName="p-5 flex flex-col gap-4"
      footer={
        /* §7 — flat .dw-ft children (row-reverse): the FIRST DOM child (the
           primary) lands on the LEFT edge, "ביטול" to its right. No wrapper. */
        <>
          <button
            type="button"
            data-testid="gu-apply"
            onClick={apply}
            disabled={!canApply}
            className="btn btn-primary flex-1"
          >
            <Icon name="check" size={20} />
            {busy ? "מעדכן…" : `עדכן ${cellCount} תאים`}
          </button>
          <button type="button" onClick={onClose} className="btn btn-secondary">ביטול</button>
        </>
      }
    >
          {/* 1 — Sellable Units */}
          <Section n={1} title="יחידות מכירה" badge={`נבחרו ${selected.size} מתוך ${allCards.length}`}>
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="חיפוש יחידה…"
                aria-label="חיפוש יחידה"
                className="field-input flex-1 min-w-[140px]"
              />
              <button type="button" aria-pressed={cardType === "all"} className={`chip clickable${cardType === "all" ? " on" : ""}`} onClick={() => setCardType("all")}>הכל</button>
              {types.map((t) => (
                <button
                  key={t.roomTypeId ?? "—"} type="button"
                  aria-pressed={cardType === (t.roomTypeId ?? "—")}
                  className={`chip clickable${cardType === (t.roomTypeId ?? "—") ? " on" : ""}`}
                  onClick={() => setCardType(t.roomTypeId ?? "—")}
                >
                  {t.roomTypeName}
                </button>
              ))}
              {/* commands, not filters — §4 buttons (a .chip.clickable never enters
                  `.on`, so as a command it would render borderless muted text) */}
              <button type="button" data-testid="gu-selectall" className="btn btn-secondary" onClick={() => setSelected(new Set(cards.map((c) => c.id)))}>בחר הכל</button>
              <button type="button" data-testid="gu-clear" className="btn btn-secondary" onClick={() => setSelected(new Set())}>נקה</button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
              {cards.map((c) => {
                const on = selected.has(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    data-su={c.id}
                    onClick={() => toggleSel(c.id)}
                    className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-[12px] border-[1.5px] text-start ${on ? "border-primary bg-primary-050" : "border-line bg-surface hover:bg-hover"}`}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <b className="text-[15px] text-ink">{c.code}</b>
                        {c.pooled && <span className="chip chip-neutral">מאגר · {c.rooms}</span>}
                      </span>
                      <span className="t-label block truncate">{c.typeName}</span>
                    </span>
                    <span className="flex items-center gap-2 flex-none">
                      <span className="t-label ltr-num">₪{Math.round(c.basePrice)}</span>
                      <span className={`w-5 h-5 rounded-[7px] border-[1.5px] flex items-center justify-center ${on ? "bg-primary border-primary text-white" : "border-line"}`}>
                        {on && <Icon name="check" size={13.5} />}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* 2 — Dates */}
          <Section n={2} title="תאריכים" badge={`${effectiveDates.length} לילות`}>
            <div className="flex items-end gap-2 flex-wrap mb-3">
              <div className="field">
                <label className="field-label" htmlFor="gu-from">מתאריך</label>
                <input id="gu-from" data-testid="gu-date-from" type="date" dir="ltr" value={dateFrom} min={minDate} max={maxDate} onChange={(e) => setDateFrom(clampDate(e.target.value))} className="field-input ltr-num" />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="gu-to">עד תאריך</label>
                <input id="gu-to" data-testid="gu-date-to" type="date" dir="ltr" value={dateTo} min={dateFrom} max={maxDate} onChange={(e) => setDateTo(clampDate(e.target.value))} className="field-input ltr-num" />
              </div>
              <span className="mx-1 h-6 w-px bg-line" />
              {/* quick-range COMMANDS (§4 buttons), aligned with the 44px date fields */}
              {([7, 14, 30] as const).map((n) => (
                <button type="button" key={n} className="btn btn-secondary" onClick={() => setDateTo(earlier(addDays(dateFrom, n - 1), maxDate))}>{n} ימים</button>
              ))}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="field-label">ימים בשבוע</span>
              {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                <button
                  type="button"
                  key={d}
                  aria-pressed={weekdays.has(d)}
                  aria-label={`יום ${HEBREW_DAY_LETTERS[d]}`}
                  onClick={() => toggleWeekday(d)}
                  className={`icon-btn text-[13.5px] font-extrabold ${weekdays.has(d) ? "bg-primary text-white" : "bg-hover text-muted"}`}
                >
                  {HEBREW_DAY_LETTERS[d].replace("'", "")}
                </button>
              ))}
              <span className="mx-1 h-6 w-px bg-line" />
              <button type="button" className="rg-tlink" onClick={() => setWeekdays(new Set([0, 1, 2, 3, 4, 5, 6]))}>הכל</button>
              <button type="button" className="rg-tlink" onClick={() => setWeekdays(new Set([0, 1, 2, 3, 4]))}>אמצע שבוע</button>
              <button type="button" className="rg-tlink" onClick={() => setWeekdays(new Set([5, 6]))}>סוף שבוע</button>
            </div>
          </Section>

          {/* 3 — Changes (partial: only marked fields update) */}
          <Section n={3} title="שינויים לביצוע" hint="רק שדות מסומנים יעודכנו — השאר יישארו ללא שינוי">
            <div className="flex flex-col divide-y divide-line">
              <FieldRow icon="credit-card" title="מחיר ללילה" desc="החלפה, תוספת או שינוי באחוזים" on={priceOn} onToggle={() => setPriceOn((v) => !v)} testId="gu-price">
                <input type="number" dir="ltr" aria-label="ערך שינוי המחיר" value={priceAmount} onChange={(e) => setPriceAmount(Number(e.target.value))} disabled={!priceOn} className="field-input ltr-num w-20 text-center" />
                <select aria-label="אופן שינוי המחיר" value={priceMode} onChange={(e) => setPriceMode(e.target.value as PriceMode)} disabled={!priceOn} className="field-input w-40">
                  {PRICE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </FieldRow>

              <FieldRow icon="power" title="זמינות למכירה" desc="פתיחה או סגירה למכירה בתאריכים שנבחרו">
                <Segmented value={stopSell} onChange={setStopSell} yes="סגור" no="פתוח" testId="gu-stopsell" />
              </FieldRow>

              <FieldRow icon="moon" title="מינימום לילות" desc="אורך שהייה מזערי להזמנה" on={minThroughOn} onToggle={() => setMinThroughOn((v) => !v)} testId="gu-minthrough">
                <Stepper value={minThrough} onChange={setMinThrough} disabled={!minThroughOn} />
              </FieldRow>

              <FieldRow icon="calendar" title="מקסימום לילות" desc="אורך שהייה מרבי להזמנה" on={maxStayOn} onToggle={() => setMaxStayOn((v) => !v)} testId="gu-maxstay">
                <Stepper value={maxStay} onChange={setMaxStay} disabled={!maxStayOn} />
              </FieldRow>

              <FieldRow icon="login" title="מ׳ לילות בהגעה" desc="מינימום לילות כשההגעה בתאריך זה" on={minArrivalOn} onToggle={() => setMinArrivalOn((v) => !v)} testId="gu-minarrival">
                <Stepper value={minArrival} onChange={setMinArrival} disabled={!minArrivalOn} />
              </FieldRow>

              <FieldRow icon="login" title="סגור להגעה (CTA)" desc="חסימת צ׳ק-אין בתאריכים שנבחרו">
                <Segmented value={cta} onChange={setCta} yes="פעיל" no="כבוי" testId="gu-cta" />
              </FieldRow>

              <FieldRow icon="logout" title="סגור לעזיבה (CTD)" desc="חסימת צ׳ק-אאוט בתאריכים שנבחרו">
                <Segmented value={ctd} onChange={setCtd} yes="פעיל" no="כבוי" testId="gu-ctd" />
              </FieldRow>
            </div>
          </Section>

          {/* summary */}
          <Section n={0} title="סיכום העדכון" icon="info">
            <div className="grid grid-cols-3 gap-3">
              <Stat value={cellCount} label="תאים לעדכון" />
              <Stat value={effectiveDates.length} label="לילות" />
              <Stat value={selected.size} label="יחידות" />
            </div>
            {sample && (
              <p className="mt-3 text-[13.5px] font-bold text-muted">
                דוגמה — {sample.typeName}: <bdi className="ltr-num">₪{Math.round(sample.before)}</bdi> <span className="text-faint">←</span> <b className="text-ink"><bdi className="ltr-num">₪{Math.round(sample.after)}</bdi></b>
              </p>
            )}
            {cellCount > 0 && (stopSell !== "nochange" || preview.noInventory > 0 || preview.missingPrice > 0) && (
              <div className="mt-3 text-[12px] font-bold text-muted flex flex-col gap-1">
                {stopSell === "no" && (
                  <p><b className="text-status-success ltr-num">{preview.willOpen}</b> תאים ייפתחו למכירה מסחרית{preview.noInventory > 0 && <> · <b className="text-status-danger ltr-num">{preview.noInventory}</b> מתוכם יישארו ללא מלאי פיזי (הפתיחה המסחרית אינה יוצרת זמינות)</>}</p>
                )}
                {stopSell === "yes" && (
                  <p><b className="text-status-danger ltr-num">{preview.willClose}</b> תאים ייסגרו למכירה מסחרית · המלאי הפיזי אינו משתנה</p>
                )}
                {preview.noInventory > 0 && stopSell !== "no" && <p><b className="text-status-danger ltr-num">{preview.noInventory}</b> מהתאים ללא מלאי פיזי</p>}
                {preview.missingPrice > 0 && <p><b className="text-status-warning ltr-num">{preview.missingPrice}</b> מהתאים ללא מחיר אפקטיבי</p>}
              </div>
            )}
          </Section>

      {error && <p className="field-msg">{error}</p>}
    </SidePanel>
  );
}

function earlier(a: DateOnly, b: DateOnly): DateOnly {
  return a < b ? a : b;
}

function Section({ n, title, badge, hint, icon, children }: { n: number; title: string; badge?: string; hint?: string; icon?: "info"; children: ReactNode }) {
  return (
    <section className="card">
      {/* a real <h3> keeps the wizard's document outline / screen-reader heading
          navigation; it inherits .card-hd's 17px/800 (§6) */}
      <div className="card-hd">
        <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-primary-050 text-[12px] font-extrabold text-primary">
          {icon ? <Icon name={icon} size={13.5} /> : n}
        </span>
        <h3>{title}</h3>
        {badge && <span className="chip chip-neutral ms-auto">{badge}</span>}
        {hint && <span className="field-hint ms-auto text-end">{hint}</span>}
      </div>
      <div className="card-bd">{children}</div>
    </section>
  );
}

function FieldRow({ icon, title, desc, on, onToggle, testId, children }: { icon: Parameters<typeof Icon>[0]["name"]; title: string; desc: string; on?: boolean; onToggle?: () => void; testId?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[7px] bg-field text-muted"><Icon name={icon} size={17} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-extrabold text-ink">{title}</span>
          {/* OFF track is a token-DERIVED darker mix (§1 color-mix) — a plain
              --line track leaves the white knob at ~1.1:1, i.e. invisible */}
          {onToggle && (
            <button type="button" data-testid={testId ? `${testId}-toggle` : undefined} onClick={onToggle} className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-primary" : "bg-[color-mix(in_srgb,var(--line)_65%,var(--faint))]"}`} aria-pressed={on} aria-label={title}>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "end-0.5" : "start-0.5"}`} />
            </button>
          )}
        </div>
        <p className="field-hint">{desc}</p>
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}

function Segmented({ value, onChange, yes, no, testId }: { value: TriState; onChange: (v: TriState) => void; yes: string; no: string; testId?: string }) {
  const opt = (v: TriState, label: string) => (
    <button
      type="button" key={v} aria-pressed={value === v}
      data-testid={testId ? `${testId}-${v}` : undefined}
      onClick={() => onChange(v)}
      className={`btn btn-sm ${value === v ? "btn-primary" : "btn-secondary"}`}
    >
      {label}
    </button>
  );
  /* segmented control: the 4px-padded TRACK renders 44px overall; the 36px
     btn-sm items sit inside it (coordinator ruling on §4) */
  return <div className="inline-flex items-center gap-1 rounded-[12px] bg-field p-1">{opt("nochange", "ללא שינוי")}{opt("yes", yes)}{opt("no", no)}</div>;
}

function Stepper({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className={`flex items-center gap-1 ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
      {/* border-solid is REQUIRED: .icon-btn resets `border: none` (style), so the
          width/colour utilities alone would never paint the outline */}
      <button type="button" aria-label="פחות" onClick={() => onChange(Math.max(0, value - 1))} className="icon-btn border-[1.5px] border-solid border-line"><Icon name="minus" size={20} /></button>
      <span className="w-8 text-center text-[14px] font-extrabold tabular-nums">{value}</span>
      <button type="button" aria-label="עוד" onClick={() => onChange(value + 1)} className="icon-btn border-[1.5px] border-solid border-line"><Icon name="plus" size={20} /></button>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-[12px] bg-field p-3 text-center">
      <div className="text-[21px] font-extrabold text-ink tabular-nums">{value}</div>
      <div className="t-label">{label}</div>
    </div>
  );
}
