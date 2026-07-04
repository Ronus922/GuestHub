import type { Metadata } from "next";
import { Icon } from "@/components/shared/Icon";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "כניסה למערכת · GuestHub" };

const FEATURES = [
  { icon: "calendar", title: "לוח תפוסה בזמן אמת", sub: "כל החדרים והתאריכים במבט אחד" },
  { icon: "guests", title: "הזמנות ואורחים", sub: "ניהול מלא מהקמה ועד צ׳ק-אאוט" },
  { icon: "cleaning", title: "ניקיון ותחזוקה", sub: "משימות צוות מסונכרנות אוטומטית" },
] as const;

export default function LoginPage() {
  return (
    <div className="flex min-h-screen bg-surface">
      {/* פאנל מותג — צד ימין בדסקטופ, מוסתר במובייל */}
      <aside className="relative hidden w-[55%] overflow-hidden bg-primary lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              "radial-gradient(120% 120% at 100% 0%, #2f4fe0 0%, #2540c8 45%, #1c2e9a 100%)",
          }}
        />
        {/* עיגולים דקורטיביים */}
        <div className="pointer-events-none absolute -start-24 top-8 h-72 w-72 rounded-full border border-white/10" />
        <div className="pointer-events-none absolute -start-10 top-24 h-52 w-52 rounded-full border border-white/10" />

        <div className="relative z-10 flex w-full flex-col justify-center gap-10 px-16 py-14 text-white">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-white/15 backdrop-blur">
            <Icon name="building" size={30} className="text-white" />
          </div>

          <div className="flex flex-col gap-4">
            <h1 className="text-5xl font-extrabold tracking-tight">GuestHub</h1>
            <p className="max-w-md text-lg leading-relaxed text-white/85">
              מערכת ניהול מלונאות חכמה — לוח תפוסה, הזמנות, אורחים, ניקיון
              ותחזוקה. הכל במקום אחד.
            </p>
          </div>

          <ul className="flex flex-col gap-5">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex items-center gap-4">
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/12">
                  <Icon name={f.icon} size={22} className="text-white" />
                </div>
                <div>
                  <p className="font-bold">{f.title}</p>
                  <p className="text-sm text-white/70">{f.sub}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-3 border-t border-white/15 pt-6 text-sm text-white/75">
            <div className="flex -space-x-2 flex-row-reverse">
              {["ד", "מ", "ק", "נ"].map((c) => (
                <span
                  key={c}
                  className="grid h-8 w-8 place-items-center rounded-full border-2 border-primary bg-white/90 text-xs font-bold text-primary"
                >
                  {c}
                </span>
              ))}
            </div>
            <span>מעל 200 מלונות ואכסניות מנהלים איתנו כל יום</span>
          </div>
        </div>
      </aside>

      {/* טופס — צד שמאל / מלא במובייל */}
      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="flex w-full max-w-[400px] flex-col gap-8">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-primary">
              <Icon name="building" size={22} className="text-white" />
            </div>
            <span className="text-2xl font-extrabold text-ink">GuestHub</span>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-3xl font-extrabold text-ink">כניסה למערכת</h2>
            <p className="text-muted">הזן את פרטי ההתחברות שלך כדי להמשיך</p>
          </div>

          <LoginForm />

          <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-faint">
            <span>© GuestHub 2026</span>
            <a href="#" className="hover:text-muted">
              מדיניות פרטיות
            </a>
            <a href="#" className="hover:text-muted">
              תנאי שימוש
            </a>
          </footer>
        </div>
      </main>
    </div>
  );
}
