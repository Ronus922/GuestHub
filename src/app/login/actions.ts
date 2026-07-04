"use server";

import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type LoginState = { error?: string };

// Login accepts email OR username. A non-email identifier is resolved to its email
// server-side, then handed to Supabase Auth. Failures are deliberately vague.
export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const identifier = String(formData.get("identifier") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!identifier || !password) {
    return { error: "יש להזין אימייל/שם משתמש וסיסמה" };
  }

  let email = identifier;
  if (!identifier.includes("@")) {
    const [row] = await sql<{ email: string | null }[]>`
      SELECT email FROM guesthub.users
      WHERE lower(username) = lower(${identifier}) AND is_active = true
      LIMIT 1`;
    if (!row?.email) return { error: "פרטי ההתחברות שגויים" };
    email = row.email;
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { error: "פרטי ההתחברות שגויים" };

  // Credentials are valid at the auth layer — confirm an ACTIVE guesthub user exists,
  // otherwise sign back out (an inactive/unlinked session would just loop into /auth/signout).
  const [active] = await sql<{ id: string }[]>`
    SELECT id FROM guesthub.users
    WHERE auth_user_id = ${data.user.id} AND is_active = true
    LIMIT 1`;
  if (!active) {
    await supabase.auth.signOut();
    return { error: "המשתמש אינו פעיל במערכת" };
  }

  redirect("/");
}
