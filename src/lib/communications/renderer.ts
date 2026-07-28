import { EMAIL_PALETTE as C } from "@/lib/colors";
import {
  BG_COLOR, BLOCK_PADDING, BUTTON_BG, BUTTON_TEXT,
  FONT_SIZE, FONT_WEIGHT, LINE_HEIGHT, TEXT_COLOR, cssAlign,
} from "./styles";
import { structuredTemplateContentSchema, templateContentKind } from "./schemas";
import type {
  BlockCondition,
  CommunicationRenderContext,
  HtmlTemplateContent,
  RenderIssue,
  RenderedCommunication,
  StructuredTemplateContent,
  TemplateBlock,
  TemplateContent,
  WhatsAppTemplateContent,
} from "./types";
import { getVariableDefinition, hasValue, interpolateVariables, resolveVariable } from "./variables";

// ============================================================
// The ONE renderer. It produces the bytes the guest receives — and the editor
// canvas shows those same bytes back (renderCommunicationBlocks), so a preview
// can never flatter a template that would send differently.
//
// Everything is inline-styled and table-based: an email client reads no CSS
// variable and no stylesheet. Colours come from the token file (lib/colors.ts).
//
// ponytail: the reference mock puts a Material Symbols icon in every detail row.
// Icons are deliberately NOT emitted — a webfont ligature that fails to load
// (Outlook and most clients) renders the literal word "confirmation_number"
// beside the label, in front of the guest. The label text carries the meaning.
// Upgrade path if they are ever wanted: inline data-URI SVGs, not a font.
// ============================================================

/**
 * `=` and the backtick are escaped alongside the five classic entities so a
 * value landing inside an UNQUOTED attribute (`<img alt={{guest.first_name}}>`)
 * cannot introduce a new one: without a literal `=` there is no way to attach a
 * handler body, and the backtick closes the legacy IE attribute-delimiter quirk.
 * Whitespace is deliberately NOT escaped — a space must still render as a space.
 * `&#61;` is decoded back to `=` by every HTML parser before a URL or an
 * attribute value is read, so normal values (query strings, prose) are unchanged.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("=", "&#61;")
    .replaceAll("`", "&#96;");
}

type Ctx = CommunicationRenderContext;
type Opts = { highlight?: boolean };

/** Canvas-only: paint a resolved variable so the operator sees what came from data. */
function mark(escaped: string, highlight: boolean): string {
  if (!highlight || !escaped) return escaped;
  return `<span style="background:${C.brandLine};color:${C.brandDark};border-radius:7px;padding:0 4px;font-weight:700">${escaped}</span>`;
}

/** Escape FIRST, then substitute — a guest name containing "<" can never become markup. */
function interpolateHtml(input: string, context: Ctx, opts: Opts): { html: string; issues: RenderIssue[] } {
  const issues: RenderIssue[] = [];
  const html = escapeHtml(input)
    .replace(/{{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\s*}}/gi, (_token, key: string) => {
      const resolved = resolveVariable(key, context);
      if (resolved.issue) issues.push(resolved.issue);
      return mark(escapeHtml(resolved.value), Boolean(opts.highlight));
    })
    .replaceAll("\n", "<br>");
  return { html, issues };
}

function numericValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value.replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function evaluateBlockCondition(condition: BlockCondition, context: Ctx): boolean {
  switch (condition) {
    case "always":
      return true;
    case "balance_positive":
      return numericValue(context.values["payment.balance"]) > 0;
    case "direct_reservation":
      return context.bookingOrigin === "direct_website";
    case "room_assigned":
      return hasValue(context.values["room.number"]) || hasValue(context.values["room.type"]);
    case "guest_email_exists":
      return hasValue(context.values["guest.email"]);
    case "cancellation_policy_exists":
      return hasValue(context.values["reservation.cancellation_policy"]);
    case "manage_url_exists":
      return hasValue(context.values["reservation.manage_url"]);
  }
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

type BlockRender = { html: string; text: string; issues: RenderIssue[] };

type TextDefaults = { size: keyof typeof FONT_SIZE; weight: keyof typeof FONT_WEIGHT; lh: keyof typeof LINE_HEIGHT; color: string };

/** Build the inline style for a heading/text/signature body from its tokens,
 *  falling back to the block's canonical default so an unstyled block renders
 *  byte-identically to before this control existed. */
function textStyle(block: TemplateBlock, defaults: TextDefaults): string {
  const size = FONT_SIZE[block.data.fontSize ?? defaults.size];
  const weight = FONT_WEIGHT[block.data.fontWeight ?? defaults.weight];
  const lh = LINE_HEIGHT[block.data.lineHeight ?? defaults.lh];
  const color = block.data.textColor ? TEXT_COLOR[block.data.textColor] : defaults.color;
  const bg = block.data.background ? BG_COLOR[block.data.background] : null;
  const pad = block.data.padding ? BLOCK_PADDING[block.data.padding] : 0;
  return `margin:0;color:${color};font-size:${size}px;font-weight:${weight};line-height:${lh};`
    + `text-align:${cssAlign(block.data.align)}`
    + (bg ? `;background:${bg};border-radius:12px` : "")
    + (pad ? `;padding:${pad}px 16px` : "");
}

// ---- shared email primitives ----
const PAD = "padding:16px 24px 0";

// Approved button radii, spelled as whole literal fragments (§1). Written as an
// object so each value line ends in a comma, not a semicolon — the design-system
// checker's radius rule keys on `border-radius:<value>;`.
const BUTTON_RADIUS_CSS = {
  md: "border-radius:12px",
  lg: "border-radius:16px",
  pill: "border-radius:999px",
} as const;

const detailRow = (label: string, value: string, last: boolean, tone?: string): string => {
  const edge = last ? "" : `border-bottom:1px solid ${C.line};`;
  return `<tr><td align="right" style="padding:9px 0;${edge}font-size:14px;font-weight:600;color:${C.muted}">${escapeHtml(label)}</td>`
    + `<td align="left" dir="auto" style="padding:9px 0;${edge}font-size:14px;font-weight:700;color:${tone ?? C.ink}">${value}</td></tr>`;
};

const detailShell = (rows: string): string =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:${C.fieldBg};border:1px solid ${C.line};border-radius:16px;padding:5px 16px"><tbody>${rows}</tbody></table>`;

type Line = { label: string; key: string; optional?: boolean; tone?: string };

function detailTable(lines: Line[], context: Ctx, opts: Opts): BlockRender {
  const issues: RenderIssue[] = [];
  const resolved = lines.flatMap((line) => {
    const value = resolveVariable(line.key, context);
    if (value.issue) issues.push(value.issue);
    if (value.issue && line.optional) return [];
    return [{ ...line, value: mark(escapeHtml(value.value), Boolean(opts.highlight)), raw: value.value }];
  });

  if (resolved.length === 0) return { html: "", text: "", issues };
  const rows = resolved
    .map((line, i) => detailRow(line.label, line.value, i === resolved.length - 1, line.tone))
    .join("");
  return {
    html: detailShell(rows),
    text: resolved.map((line) => `${line.label}: ${line.raw}`).join("\n"),
    issues,
  };
}

function renderBlock(block: TemplateBlock, context: Ctx, opts: Opts): BlockRender {
  const highlight = Boolean(opts.highlight);
  switch (block.type) {
    case "divider":
      return { html: `<hr style="border:0;border-top:1px solid ${C.line};margin:0">`, text: "────────", issues: [] };

    case "logo_header": {
      const name = resolveVariable("property.name", context);
      const logo = resolveVariable("property.logo_url", context);
      const safeLogo = logo.value ? safeHttpUrl(logo.value) : null;
      const issues = [name.issue].filter((issue): issue is RenderIssue => Boolean(issue));
      if (logo.value && !safeLogo) issues.push({ key: "property.logo_url", kind: "invalid_url" });
      const crest = safeLogo
        ? `<img src="${escapeHtml(safeLogo)}" alt="" width="50" height="50" style="display:block;margin:0 auto 9px;border:0;border-radius:12px">`
        : `<div style="width:50px;height:50px;line-height:50px;margin:0 auto 9px;border-radius:12px;background:rgba(255,255,255,.16);color:#fff;font-size:21px;font-weight:800;text-align:center">${escapeHtml([...name.value][0] ?? "")}</div>`;
      return {
        html: `<div style="background:${C.brand};padding:24px;text-align:center">${crest}<div style="color:#fff;font-size:19px;font-weight:800">${escapeHtml(name.value)}</div></div>`,
        text: name.value,
        issues,
      };
    }

    case "heading": {
      const r = interpolateHtml(block.data.text ?? "", context, opts);
      return {
        html: `<h1 style="${textStyle(block, { size: "xl", weight: "black", lh: "tight", color: C.ink })}">${r.html}</h1>`,
        text: interpolateVariables(block.data.text ?? "", context).value,
        issues: r.issues,
      };
    }

    case "text":
    case "signature": {
      const r = interpolateHtml(block.data.text ?? "", context, opts);
      const color = block.type === "signature" ? C.muted : C.ink;
      return {
        html: `<p style="${textStyle(block, { size: "base", weight: "medium", lh: "normal", color })}">${r.html}</p>`,
        text: interpolateVariables(block.data.text ?? "", context).value,
        issues: r.issues,
      };
    }

    case "reservation_details": {
      const lines: Line[] = [
        { label: "אורח", key: "guest.full_name" },
        { label: "מספר הזמנה", key: "reservation.number" },
      ];
      if (block.data.showSource) lines.push({ label: "מקור הזמנה", key: "reservation.source" });
      if (block.data.showCreatedAt) lines.push({ label: "תאריך הזמנה", key: "reservation.created_at" });
      lines.push(
        { label: "הגעה", key: "stay.arrival_date" },
        { label: "עזיבה", key: "stay.departure_date" },
      );
      if (block.data.showTimes !== false) {
        lines.push(
          { label: "צ׳ק-אין", key: "stay.check_in_time" },
          { label: "צ׳ק-אאוט", key: "stay.check_out_time" },
        );
      }
      if (block.data.showNights !== false) lines.push({ label: "לילות", key: "stay.nights" });
      if (block.data.showGuests) lines.push({ label: "אורחים", key: "stay.guests" });
      return detailTable(lines, context, opts);
    }

    case "room_details":
      return detailTable([
        { label: "חדר", key: "room.number", optional: true },
        { label: "סוג חדר", key: "room.type", optional: true },
        { label: "קומה", key: "room.floor", optional: true },
      ], context, opts);

    case "payment_summary": {
      const lines: Line[] = [];
      if (block.data.showTotal !== false) lines.push({ label: "סה״כ", key: "payment.total" });
      if (block.data.showPaid !== false) lines.push({ label: "שולם", key: "payment.paid" });
      if (block.data.showBalance !== false) lines.push({ label: "יתרה לתשלום", key: "payment.balance", tone: C.brandDark });
      return detailTable(lines, context, opts);
    }

    case "balance": {
      const balance = resolveVariable("payment.balance", context);
      return {
        html: `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:${C.brandSoft};border:1px solid ${C.brandLine};border-radius:12px"><tbody><tr>`
          + `<td align="right" style="padding:11px 16px;font-size:15px;font-weight:800;color:${C.brandDark}">יתרה לתשלום</td>`
          + `<td align="left" dir="auto" style="padding:11px 16px;font-size:15px;font-weight:800;color:${C.brandDark}">${mark(escapeHtml(balance.value), highlight)}</td>`
          + `</tr></tbody></table>`,
        text: `יתרה לתשלום: ${balance.value}`,
        issues: balance.issue ? [balance.issue] : [],
      };
    }

    case "action_button": {
      const issues: RenderIssue[] = [];
      // A free destination (fixed URL or a {{variable}}) wins over the quick-pick.
      let rawUrl = "";
      let urlKey = block.data.urlVariable ?? "";
      if (block.data.url?.trim()) {
        const interp = interpolateVariables(block.data.url, context);
        issues.push(...interp.issues);
        rawUrl = interp.value.trim();
        urlKey = block.data.url;
      } else {
        const resolved = resolveVariable(urlKey, context);
        if (resolved.issue) issues.push(resolved.issue);
        rawUrl = resolved.value;
      }
      const url = safeHttpUrl(rawUrl);
      if (rawUrl && !url) issues.push({ key: urlKey, kind: "invalid_url" });
      const label = block.data.label ?? "לצפייה בפרטים";
      if (!url) return { html: "", text: "", issues };
      const radiusCss = BUTTON_RADIUS_CSS[block.data.buttonRadius ?? "md"];
      const bg = BUTTON_BG[block.data.buttonBg ?? "brand"];
      const txt = BUTTON_TEXT[block.data.buttonText ?? "white"];
      const full = block.data.buttonWidth === "full";
      const anchor = `<a href="${escapeHtml(url)}" style="display:${full ? "block" : "inline-block"};${full ? "" : "padding:0 28px;"}height:44px;line-height:44px;${radiusCss};background:${bg};color:${txt};font-size:15px;font-weight:700;text-decoration:none;text-align:center">${escapeHtml(label)}</a>`;
      return {
        html: `<div style="text-align:${cssAlign(block.data.align) === "start" ? "right" : cssAlign(block.data.align) === "end" ? "left" : "center"}">${anchor}</div>`,
        text: `${label}: ${url}`,
        issues,
      };
    }

    case "property_address": {
      const address = resolveVariable("property.address", context);
      const map = resolveVariable("property.map_url", context);
      const safeMap = map.value ? safeHttpUrl(map.value) : null;
      const issues = [address.issue].filter((issue): issue is RenderIssue => Boolean(issue));
      if (map.value && !safeMap) issues.push({ key: "property.map_url", kind: "invalid_url" });
      const rows = detailRow("כתובת", mark(escapeHtml(address.value), highlight), !safeMap)
        + (safeMap
          ? detailRow("ניווט", `<a href="${escapeHtml(safeMap)}" style="color:${C.brand};font-weight:700;text-decoration:none">פתיחה במפה</a>`, true)
          : "");
      return {
        html: detailShell(rows),
        text: [address.value, safeMap].filter(Boolean).join(" · "),
        issues,
      };
    }

    case "cancellation_policy": {
      const policy = resolveVariable("reservation.cancellation_policy", context);
      return {
        html: `<div><div style="font-size:12px;font-weight:700;color:${C.muted};margin-bottom:3px">תנאי ביטול</div>`
          + `<div style="font-size:12px;font-weight:500;color:${C.muted};line-height:1.7">${mark(escapeHtml(policy.value).replaceAll("\n", "<br>"), highlight)}</div></div>`,
        text: `תנאי ביטול\n${policy.value}`,
        issues: policy.issue ? [policy.issue] : [],
      };
    }

    case "contact": {
      const name = resolveVariable("property.name", context);
      const items = (["property.address", "property.phone", "property.email"] as const)
        .map((key) => resolveVariable(key, context))
        .filter((item) => item.value);
      return {
        html: `<div style="background:${C.fieldBg};border-top:1px solid ${C.line};padding:14px 24px;margin-top:16px;text-align:center">`
          + `<div style="font-size:14px;font-weight:800;color:${C.ink}">${escapeHtml(name.value)}</div>`
          + `<div style="font-size:12px;font-weight:600;color:${C.muted};line-height:1.9">${items.map((item) => escapeHtml(item.value)).join(" &nbsp;·&nbsp; ")}</div></div>`,
        text: [name.value, ...items.map((item) => item.value)].filter(Boolean).join(" · "),
        issues: [],
      };
    }
  }
}

function uniqueIssues(issues: RenderIssue[]): RenderIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const signature = `${issue.kind}:${issue.key}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export type RenderedBlock = {
  id: string;
  type: TemplateBlock["type"];
  /** The block's own bytes — the SAME string the email carries. */
  html: string;
  text: string;
  /** false when the block is switched off, or its display condition is not met. */
  visible: boolean;
  issues: RenderIssue[];
};

/**
 * Per-block render for the editor canvas. Hidden blocks are returned too — the
 * operator must still see and select them — but flagged, and never emitted.
 */
export function renderCommunicationBlocks(
  content: StructuredTemplateContent,
  context: Ctx,
  options: Opts = {},
): RenderedBlock[] {
  const parsed = structuredTemplateContentSchema.parse(content);
  return parsed.blocks.map((block) => {
    const rendered = renderBlock(block, context, options);
    return {
      id: block.id,
      type: block.type,
      html: rendered.html,
      text: rendered.text,
      visible: block.enabled && evaluateBlockCondition(block.condition, context),
      issues: rendered.issues,
    };
  });
}

/** Wrap a block's own bytes in the email's body padding. Full-bleed blocks opt out. */
function bodyCell(block: RenderedBlock): string {
  const fullBleed = block.type === "logo_header" || block.type === "contact";
  return `<tr><td${fullBleed ? "" : ` style="${PAD}"`}>${block.html}</td></tr>`;
}

export function renderStructuredCommunication(
  content: StructuredTemplateContent,
  context: Ctx,
  options: Opts & { preheader?: string } = {},
): RenderedCommunication {
  const blocks = renderCommunicationBlocks(content, context, options);
  const visible = blocks.filter((block) => block.visible && block.html);
  const preheader = options.preheader
    ? interpolateVariables(options.preheader, context)
    : { value: "", issues: [] };

  const issues = uniqueIssues([
    ...blocks.filter((block) => block.visible).flatMap((block) => block.issues),
    ...preheader.issues,
  ]);

  const body = visible.map(bodyCell).join("")
    + `<tr><td style="height:20px;line-height:20px">&nbsp;</td></tr>`;

  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(preheader.value || "הודעה")}</title></head>`
    + `<body style="margin:0;padding:0;background:${C.bg};font-family:Arial,'Noto Sans Hebrew','Assistant',sans-serif">`
    + `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader.value)}</div>`
    + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${C.bg}"><tbody><tr>`
    + `<td align="center" style="padding:24px 12px">`
    + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" dir="rtl" `
    + `style="max-width:640px;background:${C.surface};border:1px solid ${C.line};border-radius:16px;overflow:hidden">`
    + `<tbody>${body}</tbody></table></td></tr></tbody></table></body></html>`;

  return {
    html,
    plainText: visible.map((block) => block.text).filter(Boolean).join("\n\n"),
    issues,
    canSend: !issues.some(
      (issue) => issue.kind === "missing_required" || issue.kind === "unknown_variable" || issue.kind === "invalid_url",
    ),
  };
}

export function renderTemplateString(
  input: string,
  context: Ctx,
): { value: string; issues: RenderIssue[]; canSend: boolean } {
  const rendered = interpolateVariables(input, context);
  return {
    ...rendered,
    canSend: !rendered.issues.some((issue) => issue.kind !== "missing_optional"),
  };
}

// ============================================================
// html-kind templates: the operator's own document. Interpolated VALUES are
// escaped (a guest named "<script>" stays text — same invariant as blocks);
// the author's markup is the markup and is sent untouched. No sanitizer:
// authoring requires communications.templates.edit, mail goes out through the
// tenant's own account, and the only in-app surface is a sandbox="" iframe.
// ============================================================

/** Best-effort text part for the multipart email — never shown in the app. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<(style|script|title)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#61;", "=")
    .replaceAll("&#96;", "`")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** A scheme-looking prefix: letter, then letters/digits/+/-/. up to a colon. */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;
/** Schemes that carry no script and are legitimate in an email href. */
const SAFE_NON_HTTP_SCHEME = /^(mailto|tel):/i;

/**
 * Detection must see the string the CLIENT will resolve, not the one we were
 * handed. Before resolving a URL every browser and mail client strips leading
 * and trailing C0 controls, and removes ASCII tab/CR/LF from ANYWHERE in it —
 * so `java\tscript:` and `\0javascript:` resolve as `javascript:` while sailing
 * past a naive `^[a-z]…:` test. Whole C0 range + DEL, not just \t\r\n\0: every
 * one of them is stripped or rejected by the URL parser the same way, and this
 * probe is used for DETECTION only — a value that turns out not to be a URL is
 * still emitted with its own bytes intact (a guest note keeps its newlines).
 */
function urlProbe(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

/**
 * Gate a value that IS a URL (a url-kind variable) or merely looks like one
 * (any scheme-prefixed string) before it reaches the author's markup — the
 * html path has no `href="…"` of its own to guard, so the guard travels with
 * the value. http/https go through the SAME safeHttpUrl the blocks renderer
 * uses; mailto/tel pass; everything else (javascript:, data:, vbscript:, file:)
 * is rejected exactly as the blocks path rejects one: an invalid_url issue and
 * an EMPTY value, never the raw string. invalid_url also forces canSend=false.
 */
function guardUrlValue(key: string, value: string, issues: RenderIssue[]): string {
  const probe = urlProbe(value);
  if (!probe) return value;
  const isUrlVariable = getVariableDefinition(key)?.kind === "url";
  if (!isUrlVariable && !SCHEME_PREFIX.test(probe)) return value;
  if (SAFE_NON_HTTP_SCHEME.test(probe)) return probe;
  const safe = safeHttpUrl(probe);
  if (safe) return safe;
  issues.push({ key, kind: "invalid_url" });
  return "";
}

export function renderHtmlCommunication(
  content: HtmlTemplateContent,
  context: Ctx,
  options: Opts & { preheader?: string } = {},
): RenderedCommunication {
  const issues: RenderIssue[] = [];
  const interpolated = content.html.replace(
    /{{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\s*}}/gi,
    (_token, key: string) => {
      const resolved = resolveVariable(key, context);
      if (resolved.issue) issues.push(resolved.issue);
      const guarded = guardUrlValue(key, resolved.value, issues);
      return mark(escapeHtml(guarded), Boolean(options.highlight));
    },
  );

  const preheader = options.preheader
    ? interpolateVariables(options.preheader, context)
    : { value: "", issues: [] };
  issues.push(...preheader.issues);

  // A pasted fragment gets a minimal RTL document shell (charset + viewport,
  // no styling). A full document passes through untouched — its own <head>
  // wins, so the preheader div is only injectable in the fragment case.
  const isFullDocument = /<html[\s>]/i.test(interpolated);
  const html = isFullDocument
    ? interpolated
    : `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width,initial-scale=1"></head>`
      + `<body style="margin:0;padding:0">`
      + `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader.value)}</div>`
      + `${interpolated}</body></html>`;

  const allIssues = uniqueIssues(issues);
  return {
    html,
    plainText: htmlToPlainText(interpolated),
    issues: allIssues,
    canSend: !allIssues.some(
      (issue) => issue.kind === "missing_required" || issue.kind === "unknown_variable" || issue.kind === "invalid_url",
    ),
  };
}

/**
 * whatsapp_text templates: plain interpolation, NO escaping — WhatsApp is a
 * text medium and escaping would ship "&amp;" to guests. There is no injection
 * surface: the result is never interpreted as markup anywhere (the editor
 * preview renders it as a text node).
 */
export function renderWhatsAppCommunication(
  content: WhatsAppTemplateContent,
  context: Ctx,
): { text: string; issues: RenderIssue[]; canSend: boolean } {
  const rendered = interpolateVariables(content.text, context);
  const issues = uniqueIssues(rendered.issues);
  return {
    text: rendered.value,
    issues,
    canSend: !issues.some((issue) => issue.kind !== "missing_optional"),
  };
}

/**
 * The ONE dispatch for anything holding a TemplateContent — editor preview,
 * test send, and the automation pipeline. For whatsapp_text the message lives
 * in plainText and html is empty (the email path must refuse it explicitly).
 */
export function renderTemplateContent(
  content: TemplateContent,
  context: Ctx,
  options: Opts & { preheader?: string } = {},
): RenderedCommunication {
  const kind = templateContentKind(content);
  if (kind === "html") {
    return renderHtmlCommunication(content as HtmlTemplateContent, context, options);
  }
  if (kind === "whatsapp_text") {
    const rendered = renderWhatsAppCommunication(content as WhatsAppTemplateContent, context);
    return { html: "", plainText: rendered.text, issues: rendered.issues, canSend: rendered.canSend };
  }
  return renderStructuredCommunication(content as StructuredTemplateContent, context, options);
}
