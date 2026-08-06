"use client";

import { PaymentMethodsCard } from "./PaymentMethodsCard";
import type { PaymentMethodDef } from "./payment-method-actions";

// The "payment" settings section is the payment-methods manager. The old
// payment-policy templates were removed (migration 078) — the tenant used them
// as an ad-hoc method list, and nothing consumed them.
export function PaymentSection({ methodDefs }: { methodDefs: PaymentMethodDef[] }) {
  return <PaymentMethodsCard initial={methodDefs} />;
}
