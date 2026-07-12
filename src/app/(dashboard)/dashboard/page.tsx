import { Icon } from "@/components/shared/Icon";

export default function DashboardPage() {
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="h1">דשבורד</h1>
        <p className="t-secondary">מבט-על על המלון — נבנה בשלב הבא</p>
      </div>

      {/* Empty state — אין נתונים עסקיים בשלב 1 */}
      <div className="card grid min-h-[420px] place-items-center">
        <div className="empty-state max-w-sm">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-primary-050">
            <Icon name="dashboard" size={24} className="text-primary" />
          </div>
          <p className="empty-t">התשתית מוכנה</p>
          <p className="empty-s">
            בסיס הנתונים, ההרשאות והמעטפת פעילים. כרטיסי הדשבורד וכל המסכים
            העסקיים ייבנו בשלבים הבאים.
          </p>
        </div>
      </div>
    </div>
  );
}
