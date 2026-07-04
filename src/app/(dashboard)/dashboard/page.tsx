import { Icon } from "@/components/shared/Icon";

export default function DashboardPage() {
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold text-ink">דשבורד</h1>
        <p className="mt-1 text-sm text-muted">מבט-על על המלון — נבנה בשלב הבא</p>
      </div>

      {/* Empty state — אין נתונים עסקיים בשלב 1 */}
      <div className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-line bg-surface">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-primary-050">
            <Icon name="dashboard" size={30} className="text-primary" />
          </div>
          <h2 className="text-lg font-bold text-ink">התשתית מוכנה</h2>
          <p className="text-sm text-muted">
            בסיס הנתונים, ההרשאות והמעטפת פעילים. כרטיסי הדשבורד וכל המסכים
            העסקיים ייבנו בשלבים הבאים.
          </p>
        </div>
      </div>
    </div>
  );
}
