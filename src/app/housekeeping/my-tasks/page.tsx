import { redirect } from "next/navigation";
import { getActor } from "@/lib/auth/actor";
import { logoutAction } from "@/lib/auth/actions";
import { Icon } from "@/components/shared/Icon";
import { getMyTasksAction, advanceMyTaskAction } from "@/lib/housekeeping/actions";

export const dynamic = "force-dynamic";

// Cleaner screen — mobile, no sidebar/topbar (lives outside the (dashboard) group).
// Shows the cleaner's assigned tasks + the unassigned pool; one tap advances a
// task (dirty → cleaning → clean). Tasks are generated automatically on checkout.

const STATUS_LABEL: Record<string, string> = {
  pending: "ממתין לניקיון",
  in_progress: "בניקיון",
  completed: "נוקה",
  inspected: "נבדק",
};
const NEXT_LABEL: Record<string, string> = {
  pending: "התחלת ניקיון",
  in_progress: "סיום ניקיון",
};

export default async function MyTasksPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");

  const initial = (actor.fullName ?? actor.username).trim().charAt(0) || "G";
  const res = await getMyTasksAction();
  const tasks = res.success ? res.data ?? [] : [];

  async function advance(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    if (id) await advanceMyTaskAction(id);
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-appbg">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-4">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-[15px] font-bold text-white">
            {initial}
          </span>
          <div>
            <p className="h4">המשימות שלי</p>
            <p className="t-label text-faint">{actor.fullName ?? actor.username}</p>
          </div>
        </div>
        <form action={logoutAction}>
          <button
            type="submit"
            className="icon-btn text-status-danger hover:bg-status-danger-050 hover:text-status-danger"
          >
            <Icon name="logout" size={20} label="התנתקות" />
          </button>
        </form>
      </header>

      {tasks.length === 0 ? (
        <main className="flex flex-1 items-center justify-center p-6">
          <div className="empty-state max-w-xs">
            <div className="grid h-16 w-16 place-items-center rounded-2xl bg-primary-050">
              <Icon name="cleaning" size={24} className="text-primary" />
            </div>
            <h1 className="empty-t">אין משימות כרגע</h1>
            <p className="empty-s">משימות ניקיון נוצרות אוטומטית עם יציאת אורח ויופיעו כאן.</p>
          </div>
        </main>
      ) : (
        <main className="flex flex-1 flex-col gap-3 p-4">
          {tasks.map((t) => (
            <div key={t.id} className="card">
              <div className="card-bd flex flex-col gap-3">
                <div className="flex flex-row-reverse items-center justify-between gap-2">
                  <span className="h4">{t.title ?? (t.roomNumber ? `חדר ${t.roomNumber}` : "משימה")}</span>
                  <span
                    className={`rounded-lg px-3 py-1 text-sm ${
                      t.status === "in_progress" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {STATUS_LABEL[t.status] ?? t.status}
                  </span>
                </div>
                {t.priority === "high" && <span className="t-label text-status-danger">דחוף</span>}
                {t.notes && <p className="t-secondary">{t.notes}</p>}
                {NEXT_LABEL[t.status] && (
                  <form action={advance}>
                    <input type="hidden" name="id" value={t.id} />
                    <button type="submit" className="w-full rounded-lg bg-primary px-4 py-3 font-semibold text-white">
                      {NEXT_LABEL[t.status]}
                    </button>
                  </form>
                )}
              </div>
            </div>
          ))}
        </main>
      )}
    </div>
  );
}
