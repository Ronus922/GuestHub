import "server-only";
import { sql } from "@/lib/db";
import {
  normalizeExtraGuestDefaults,
  adultMinAge,
  type ExtraGuestDefaults,
} from "./extra-guest";
import type { CancellationTier } from "./cancellation";
import type { PaymentStage } from "./payment";
import {
  resolveEffectivePricing,
  type RoomExtraGuestOverride,
  type EffectiveExtraGuestPricing,
} from "./room-pricing";

// ============================================================
// Canonical commercial-settings READ layer (§D). The ONE server-side path the
// settings screen — and the future Rooms / Rate-Plan / Booking-Engine / Channex
// phases — read commercial defaults through, so business logic never scatters
// into React components. Tenant-scoped by the caller's actor.tenantId. numeric is
// cast ::float8 so it arrives as a JS number (project convention).
// ============================================================

// ---- §A extra-guest defaults (jsonb singleton on tenants.settings) ----
export async function getExtraGuestDefaults(
  tenantId: string,
): Promise<ExtraGuestDefaults & { adult_min_age: number }> {
  const [row] = await sql<{ extra_guest: unknown }[]>`
    SELECT settings->'extra_guest' AS extra_guest
    FROM guesthub.tenants WHERE id = ${tenantId}`;
  const d = normalizeExtraGuestDefaults(row?.extra_guest);
  return { ...d, adult_min_age: adultMinAge(d.child_max_age) };
}

// Canonical payment-method keys for this tenant (lookup_items 'payment_methods').
// Policies REFERENCE these — they are never duplicated into the policy tables.
export async function getPaymentMethods(
  tenantId: string,
): Promise<{ key: string; label: string }[]> {
  return sql<{ key: string; label: string }[]>`
    SELECT key, label FROM guesthub.lookup_items
    WHERE tenant_id = ${tenantId} AND category = 'payment_methods' AND is_active
    ORDER BY sort_order, label`;
}

// ---- §B cancellation policies (with ordered tiers) ----
export type CancellationPolicy = {
  id: string;
  name: string;
  public_title: string;
  code: string;
  is_active: boolean;
  is_default: boolean;
  internal_notes: string | null;
  guest_description: string | null;
  translations: Record<string, { public_title?: string; guest_description?: string }>;
  distribution_scope: "direct_only" | "direct_and_channels" | "internal_only";
  timezone: string | null;
  checkin_time_basis: string | null;
  is_archived: boolean;
  tiers: CancellationTier[];
};

export async function listCancellationPolicies(tenantId: string): Promise<CancellationPolicy[]> {
  const policies = await sql<Omit<CancellationPolicy, "tiers">[]>`
    SELECT id, name, public_title, code, is_active, is_default, internal_notes,
           guest_description, translations, distribution_scope, timezone,
           checkin_time_basis::text AS checkin_time_basis, is_archived
    FROM guesthub.cancellation_policies
    WHERE tenant_id = ${tenantId} AND NOT is_archived
    ORDER BY is_default DESC, name`;
  if (policies.length === 0) return [];
  const tiers = await sql<(CancellationTier & { policy_id: string })[]>`
    SELECT policy_id, trigger_type, time_unit, time_from, time_to, fee_type,
           fee_amount::float8 AS fee_amount, fee_percent::float8 AS fee_percent,
           fee_nights, calc_base
    FROM guesthub.cancellation_policy_tiers
    WHERE tenant_id = ${tenantId}
    ORDER BY policy_id, sort_order`;
  const byPolicy = new Map<string, CancellationTier[]>();
  for (const { policy_id, ...t } of tiers) {
    const arr = byPolicy.get(policy_id) ?? [];
    arr.push(t);
    byPolicy.set(policy_id, arr);
  }
  return policies.map((p) => ({ ...p, tiers: byPolicy.get(p.id) ?? [] }));
}

// ---- §C payment policies (with ordered stages) ----
export type PaymentPolicy = {
  id: string;
  name: string;
  public_title: string;
  code: string;
  is_active: boolean;
  is_default: boolean;
  internal_notes: string | null;
  guest_description: string | null;
  translations: Record<string, { public_title?: string; guest_description?: string }>;
  is_archived: boolean;
  stages: PaymentStage[];
};

export async function listPaymentPolicies(tenantId: string): Promise<PaymentPolicy[]> {
  const policies = await sql<Omit<PaymentPolicy, "stages">[]>`
    SELECT id, name, public_title, code, is_active, is_default, internal_notes,
           guest_description, translations, is_archived
    FROM guesthub.payment_policies
    WHERE tenant_id = ${tenantId} AND NOT is_archived
    ORDER BY is_default DESC, name`;
  if (policies.length === 0) return [];
  const stages = await sql<(PaymentStage & { policy_id: string })[]>`
    SELECT policy_id, trigger_type, trigger_offset_unit, trigger_offset_value,
           amount_type, amount_value::float8 AS amount_value,
           amount_percent::float8 AS amount_percent, methods,
           require_card_guarantee, retry_behavior, staff_instructions, guest_text
    FROM guesthub.payment_policy_stages
    WHERE tenant_id = ${tenantId}
    ORDER BY policy_id, sort_order`;
  const byPolicy = new Map<string, PaymentStage[]>();
  for (const { policy_id, ...s } of stages) {
    const arr = byPolicy.get(policy_id) ?? [];
    arr.push(s);
    byPolicy.set(policy_id, arr);
  }
  return policies.map((p) => ({ ...p, stages: byPolicy.get(p.id) ?? [] }));
}

// ============================================================
// Rooms — occupancy + per-room extra-guest override (§3/§5/§7)
// ============================================================
export type RoomRow = {
  id: string;
  room_number: string;
  name: string | null;
  floor: string | null;
  status: string;
  is_active: boolean;
  max_occupancy: number;
  max_adults: number;
  max_children: number;
  max_infants: number;
  default_occupancy: number | null;
  included_occupancy: number | null;
  extra_guest_pricing_mode: "inherit" | "override";
  extra_adult_override: number | null;
  extra_child_override: number | null;
  extra_infant_override: number | null;
  charge_frequency_override: "per_night" | "per_stay" | null;
  area_name: string | null;
  room_type_name: string | null;
};

export async function listRooms(tenantId: string): Promise<RoomRow[]> {
  return sql<RoomRow[]>`
    SELECT r.id, r.room_number, r.name, r.floor, r.status, r.is_active,
           r.max_occupancy, r.max_adults, r.max_children, r.max_infants,
           r.default_occupancy, r.included_occupancy, r.extra_guest_pricing_mode,
           r.extra_adult_override::float8  AS extra_adult_override,
           r.extra_child_override::float8  AS extra_child_override,
           r.extra_infant_override::float8 AS extra_infant_override,
           r.charge_frequency_override,
           a.name  AS area_name,
           rt.name AS room_type_name
    FROM guesthub.rooms r
    LEFT JOIN guesthub.areas a       ON a.id  = r.area_id
    LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
    WHERE r.tenant_id = ${tenantId}
    ORDER BY r.room_number`;
}

export async function getRoom(tenantId: string, roomId: string): Promise<RoomRow | null> {
  const [row] = await sql<RoomRow[]>`
    SELECT r.id, r.room_number, r.name, r.floor, r.status, r.is_active,
           r.max_occupancy, r.max_adults, r.max_children, r.max_infants,
           r.default_occupancy, r.included_occupancy, r.extra_guest_pricing_mode,
           r.extra_adult_override::float8  AS extra_adult_override,
           r.extra_child_override::float8  AS extra_child_override,
           r.extra_infant_override::float8 AS extra_infant_override,
           r.charge_frequency_override,
           a.name AS area_name, rt.name AS room_type_name
    FROM guesthub.rooms r
    LEFT JOIN guesthub.areas a       ON a.id  = r.area_id
    LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
    WHERE r.tenant_id = ${tenantId} AND r.id = ${roomId}`;
  return row ?? null;
}

// §5 canonical server resolver: effective extra-guest pricing for a room, with the
// source of each value (room override ↓ property default). The one server path the
// future quote reads through. Tenant-scoped.
export async function resolveEffectiveExtraGuestPricing(
  tenantId: string,
  roomId: string,
): Promise<EffectiveExtraGuestPricing | null> {
  const room = await getRoom(tenantId, roomId);
  if (!room) return null;
  const property = await getExtraGuestDefaults(tenantId);
  const override: RoomExtraGuestOverride = {
    mode: room.extra_guest_pricing_mode,
    extra_adult: room.extra_adult_override,
    extra_child: room.extra_child_override,
    extra_infant: room.extra_infant_override,
    charge_frequency: room.charge_frequency_override,
  };
  return resolveEffectivePricing(override, property);
}
