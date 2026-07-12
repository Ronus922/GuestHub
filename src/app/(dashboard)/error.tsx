"use client";

import { Icon } from "@/components/shared/Icon";

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="grid min-h-[60vh] place-items-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-status-danger-050">
          <Icon name="warning" size={24} className="text-status-danger" />
        </div>
        <h2 className="h4">משהו השתבש</h2>
        <p className="t-secondary">
          אירעה שגיאה בטעינת המסך. נסה שוב, ואם הבעיה נמשכת פנה למנהל המערכת.
        </p>
        <button type="button" className="btn btn-primary" onClick={reset}>
          נסה שוב
        </button>
      </div>
    </div>
  );
}
