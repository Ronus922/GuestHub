import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// כל הקריאות מנותבות ל-schema הייעודי של הפרויקט.
// supabase.from('reservations') → guesthub.reservations
export const supabase = createClient(url, anonKey, {
  db: { schema: "guesthub" },
});
