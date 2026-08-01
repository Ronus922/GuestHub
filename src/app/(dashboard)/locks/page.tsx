import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { Icon } from "@/components/shared/Icon";
import { listLocksAction } from "./actions";
import { LocksBoard } from "./LocksBoard";

export const dynamic = "force-dynamic";

// /locks — the smart-lock board (D123): which doors this account can reach, and
// which room each one opens. Page load is a pure DB read; TTLock is contacted
// only when the operator presses "סנכרון מנעולים".
//
// The gate here mirrors the one listLocksAction enforces. Hiding the sidebar
// entry is not security — the Server Action is the real boundary, and it checks
// again on every call.
export default async function LocksPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "locks.view")) redirect("/dashboard");

  const res = await listLocksAction();

  if (!res.success) {
    return (
      <div className="flex flex-col gap-5 p-[26px]" dir="rtl">
        <h1 className="h1">מנעולים</h1>
        <div className="flex items-start gap-3 rounded-2xl border border-status-danger bg-status-danger-050 p-4">
          <Icon name="warning" size={20} className="mt-0.5 shrink-0 text-status-danger" />
          <p className="t-secondary text-status-danger">{res.error}</p>
        </div>
      </div>
    );
  }

  return <LocksBoard initial={res.data!} />;
}
