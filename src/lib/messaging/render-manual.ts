import { renderTemplate } from "./templates";
import { renderTemplateString } from "@/lib/communications/renderer";
import { describeRenderIssues } from "@/lib/communications/variables";
import type { CommunicationRenderContext, RenderIssue } from "@/lib/communications/types";

// ============================================================
// Rendering for the booking composer's MANUAL send (D172): the email subject
// and — since the 2026-09-05 addendum — the BODY of both channels (email and
// WhatsApp) go through this one chain, so a template authored in the
// communications editor renders the same whether an automation or an operator
// sends it.
//
// Two placeholder grammars coexist in message_templates and in the composer:
//   - legacy `{{snake_case}}` keys (the composer's variable chips, older
//     templates) — resolved by renderTemplate against the composer's own vars;
//   - `{{group.key}}` tokens (templates authored in the communications editor,
//     e.g. {{reservation.number}}) — resolved by the communications renderer,
//     the SAME one the automations use for body and subject.
// The two regexes are disjoint (the legacy one never matches a dot, the V2 one
// requires one), so the passes cannot double-resolve; order is irrelevant.
// An unknown `{{group.key}}` never ships literally: the V2 pass blanks it AND
// blocks the send, naming the variable (D115 semantics, D112 evidence line).
// A known key without a value renders empty and does not block (D115).
// ============================================================

export type ManualRender = {
  value: string;
  issues: RenderIssue[];
  canSend: boolean;
  /** Hebrew line naming the blocking variable(s); null when nothing blocks. */
  detail: string | null;
};

/** Subject or body — plain text in, plain text out; newlines survive untouched. */
export function renderManualText(
  text: string,
  legacyVars: Record<string, string>,
  context: CommunicationRenderContext,
): ManualRender {
  const legacy = renderTemplate(text, legacyVars);
  const rendered = renderTemplateString(legacy, context);
  return {
    value: rendered.value,
    issues: rendered.issues,
    canSend: rendered.canSend,
    detail: describeRenderIssues(rendered.issues),
  };
}
