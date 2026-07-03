import postgres from "postgres";

// porsager postgres → Supabase (self-hosted) via the Supavisor SESSION pooler.
// Every table lives in the `guesthub` schema and MUST be qualified (`guesthub.<table>`):
// the pooler drops the search_path startup param, and the shared `postgres` DB's `public`
// schema hosts a different project with colliding table names. See DECISIONS.md D4.
const globalForDb = globalThis as unknown as {
  __guesthubSql?: ReturnType<typeof postgres>;
};

export const sql =
  globalForDb.__guesthubSql ??
  postgres(process.env.DATABASE_URL!, {
    prepare: true,
    max: 10,
    idle_timeout: 20,
  });

if (process.env.NODE_ENV !== "production") globalForDb.__guesthubSql = sql;
