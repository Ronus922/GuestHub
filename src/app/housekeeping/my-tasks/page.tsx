import { redirect } from "next/navigation";
import { getActor } from "@/lib/auth/actor";
import { logoutAction } from "@/lib/auth/actions";
import { Icon } from "@/components/shared/Icon";

// Cleaner screen — mobile, no sidebar/topbar (lives outside the (dashboard) group).
export default async function MyTasksPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");

  const initial = (actor.fullName ?? actor.username).trim().charAt(0) || "G";

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

      <main className="flex flex-1 items-center justify-center p-6">
        <div className="empty-state max-w-xs">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-primary-050">
            <Icon name="cleaning" size={24} className="text-primary" />
          </div>
          <h1 className="empty-t">אין משימות כרגע</h1>
          <p className="empty-s">
            רשימת משימות הניקיון שלך תופיע כאן. המסך המלא ייבנה בשלב הניקיון.
          </p>
        </div>
      </main>
    </div>
  );
}
