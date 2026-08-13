import Link from "next/link";
import { Icon } from "@/components/shared/Icon";

// Without this file a 404 fell through to Next's built-in page: English copy,
// LTR, unstyled — rendered inside <html lang="he" dir="rtl">. It lives at the
// root (not inside the (dashboard) group) so it also covers /login, /uploads/*
// and every route outside the shell. Same visual idiom as (dashboard)/error.tsx.
export default function NotFound() {
  return (
    <div className="grid min-h-[60svh] place-items-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="bg-status-warning-050 grid h-16 w-16 place-items-center rounded-2xl">
          <Icon name="search" size={24} className="text-status-warning" />
        </div>
        <h2 className="h4">הדף לא נמצא</h2>
        <p className="t-secondary">
          הכתובת שביקשת אינה קיימת, או שאין לך הרשאה אליה.
        </p>
        <Link href="/dashboard" className="btn btn-primary">
          חזרה לדשבורד
        </Link>
      </div>
    </div>
  );
}
