// ============================================================
// Block STYLE tokens — the ONE source of truth for the approved values a block
// author may pick (GUIDELINES §1/§8). The editor renders these as option lists;
// the renderer maps the stored KEY to an inline literal. Storing a key (not a
// hex/px) is what keeps "no raw HTML/CSS exposed" true and guarantees a template
// can never carry a colour or size the design system does not own.
//
// Colours are NOT re-declared here — they are drawn from the canonical email
// palette (lib/colors.ts, itself the §1 token file), so this file owns only the
// builder-specific scales (size / weight / spacing) and never a raw hex.
// ============================================================
import { EMAIL_PALETTE as C } from "@/lib/colors";

export const FONT_SIZE = { sm: 13, base: 15, md: 17, lg: 19, xl: 21, xxl: 24 } as const;
export type FontSize = keyof typeof FONT_SIZE;

export const FONT_WEIGHT = { normal: 400, medium: 500, semibold: 600, bold: 700, black: 800 } as const;
export type FontWeight = keyof typeof FONT_WEIGHT;

export const LINE_HEIGHT = { tight: 1.3, snug: 1.5, normal: 1.75, loose: 2 } as const;
export type LineHeight = keyof typeof LINE_HEIGHT;

export const TEXT_ALIGN = ["start", "center", "end"] as const;
export type TextAlign = (typeof TEXT_ALIGN)[number];

// the subset of the §1 palette the text controls offer
export const TEXT_COLOR = {
  ink: C.ink,
  muted: C.muted,
  brand: C.brand,
  brandDark: C.brandDark,
  ok: C.ok,
  danger: C.danger,
} as const;
export type TextColor = keyof typeof TEXT_COLOR;

// `none` = no box; the others are the approved soft surfaces
export const BG_COLOR = {
  none: null,
  subtle: C.fieldBg,
  brandSoft: C.brandSoft,
  brand: C.brand,
} as const;
export type BgColor = keyof typeof BG_COLOR;

export const BLOCK_PADDING = { none: 0, sm: 8, md: 14, lg: 20 } as const;
export type BlockPadding = keyof typeof BLOCK_PADDING;

export const BUTTON_WIDTH = ["auto", "full"] as const;
export type ButtonWidth = (typeof BUTTON_WIDTH)[number];

export const BUTTON_RADIUS = { md: 12, lg: 16, pill: 999 } as const;
export type ButtonRadius = keyof typeof BUTTON_RADIUS;

export const BUTTON_BG = { brand: C.brand, ink: C.ink, ok: C.ok } as const;
export type ButtonBg = keyof typeof BUTTON_BG;

export const BUTTON_TEXT = { white: C.surface, ink: C.ink } as const;
export type ButtonText = keyof typeof BUTTON_TEXT;

export const cssAlign = (align: TextAlign | undefined): string =>
  align === "center" ? "center" : align === "end" ? "end" : "start";
