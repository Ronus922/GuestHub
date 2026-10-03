import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";

// porsager postgres → Supabase (self-hosted) via the Supavisor SESSION pooler.
// Every table lives in the `guesthub` schema and MUST be qualified (`guesthub.<table>`):
// the pooler drops the search_path startup param, and the shared `postgres` DB's `public`
// schema hosts a different project with colliding table names. See DECISIONS.md D4.
const globalForDb = globalThis as unknown as {
  __guesthubSql?: ReturnType<typeof postgres>;
};

const base =
  globalForDb.__guesthubSql ??
  postgres(process.env.DATABASE_URL!, {
    prepare: true,
    max: 10,
    idle_timeout: 20,
  });

if (process.env.NODE_ENV !== "production") globalForDb.__guesthubSql = base;

// D203 — a READ ONLY scope. Inside withReadOnlyScope(fn), every statement made
// through `sql` — by any module, however deep — runs on ONE transaction opened
// `read only`, so a write anywhere in that call tree is refused by PostgreSQL
// itself. Outside a scope `sql` is exactly the pool it always was.
const scope = new AsyncLocalStorage<typeof base>();

export const sql = new Proxy(base, {
  apply(target, thisArg, args: unknown[]) {
    return Reflect.apply(scope.getStore() ?? target, thisArg, args);
  },
  get(target, prop) {
    const active = scope.getStore();
    const owner = active && prop in active ? active : target;
    const value = Reflect.get(owner, prop) as unknown;
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(owner) : value;
  },
}) as typeof base;

export async function withReadOnlyScope<T>(fn: () => Promise<T>): Promise<T> {
  let result!: T;
  await base.begin("read only", async (tx) => {
    result = await scope.run(tx as unknown as typeof base, fn);
  });
  return result;
}
